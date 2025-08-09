// filename: routes/pair.js
const { teranId, removeFile } = require('../lib'); // ensure lib exports teranId
const express = require('express');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const axios = require('axios');
require('dotenv').config();
const pino = require('pino');
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const {
  default: TERAN_XMD,
  useMultiFileAuthState,
  delay,
  makeCacheableSignalKeyStore,
  Browsers
} = require('@whiskeysockets/baileys');

const { SESSIONS_API_URL, SESSIONS_API_KEY } = process.env;
if (!SESSIONS_API_URL || !SESSIONS_API_KEY) {
  throw new Error('Missing env vars: SESSIONS_API_URL and SESSIONS_API_KEY are required');
}

const router = express.Router();

// uploadCreds with small retry/backoff
async function uploadCreds(tempId) {
  const authPath = path.join(__dirname, 'temp', tempId, 'creds.json');
  const credsId = teranId();

  // confirm file exists and read
  try {
    await fs.access(authPath);
  } catch (err) {
    logger.error({ authPath, err }, 'Creds file not found before upload');
    throw new Error('creds.json not found');
  }

  const credsData = JSON.parse(await fs.readFile(authPath, 'utf8'));

  const payload = { credsId, credsData };

  const maxAttempts = 3;
  let attempt = 0;
  let lastErr = null;

  while (attempt < maxAttempts) {
    attempt++;
    try {
      logger.info({ attempt }, 'Uploading creds to sessions API');
      const resp = await axios.post(
        `${SESSIONS_API_URL}/api/uploadCreds.php`,
        payload,
        {
          headers: {
            'x-api-key': SESSIONS_API_KEY,
            'Content-Type': 'application/json',
          },
          timeout: 10000,
        }
      );
      logger.info({ status: resp.status, data: resp.data }, 'Upload successful');
      return credsId;
    } catch (err) {
      lastErr = err;
      logger.warn({ attempt, err: err.response?.data || err.message }, 'Upload attempt failed');
      // backoff
      await new Promise(r => setTimeout(r, 500 * attempt));
    }
  }

  throw lastErr || new Error('Unknown upload error');
}

// Helper to send SSE event
function sseSend(res, event, obj) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

router.get('/', async (req, res) => {
  const phoneRaw = req.query.number;
  if (!phoneRaw) {
    return res.status(400).json({ error: 'Phone number is required' });
  }
  const phone = String(phoneRaw).replace(/[^0-9]/g, '');
  if (!phone) {
    return res.status(400).json({ error: 'Phone number invalid after sanitization' });
  }

  // Set SSE headers so client can receive streaming updates
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const tempId = teranId();
  const authDir = path.join(__dirname, 'temp', tempId);

  try {
    await fs.mkdir(authDir, { recursive: true });
  } catch (err) {
    logger.error({ err }, 'Failed to create auth dir');
    sseSend(res, 'error', { message: 'failed to create auth dir' });
    res.end();
    return;
  }

  let wsClosed = false;
  let pairingDone = false;

  // watchdog - abort if not connected within X ms
  const WATCHDOG_MS = Number(process.env.PAIRING_WATCHDOG_MS || 120000); // default 2 minutes
  const watchdog = setTimeout(async () => {
    if (!pairingDone) {
      logger.warn('Watchdog timed out — aborting pairing');
      sseSend(res, 'error', { message: 'pairing timeout' });
      res.end();
      try { await removeFile(authDir); } catch(e) { logger.warn(e, 'cleanup after watchdog'); }
    }
  }, WATCHDOG_MS);

  // create Baileys state
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  const Gifted = TERAN_XMD({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' })),
    },
    printQRInTerminal: false,
    logger: pino({ level: process.env.BAILEYS_LOG_LEVEL || 'fatal' }),
    browser: Browsers.macOS('Safari'),
  });

  Gifted.ev.on('creds.update', async (...args) => {
    logger.info('creds.update event');
    try {
      await saveCreds(...args);
    } catch (e) {
      logger.error(e, 'saveCreds failed');
    }
  });

  Gifted.ev.on('connection.update', async (update) => {
    logger.info({ update }, 'connection.update');
    const { connection, lastDisconnect } = update;

    // log lastDisconnect details
    if (lastDisconnect) {
      logger.info({ lastDisconnect }, 'lastDisconnect details');
    }

    // when the connection closes unexpectedly
    if (connection === 'close' && !pairingDone) {
      pairingDone = true;
      const reason = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.message || 'unknown';
      logger.error({ reason }, 'Connection closed before pairing finished');
      sseSend(res, 'error', { message: 'connection closed', reason });
      res.end();
      clearTimeout(watchdog);
      try { await Gifted.ws.close(); } catch(e) { logger.debug(e, 'ws close error'); }
      try { await removeFile(authDir); } catch(e) { logger.warn(e, 'cleanup error'); }
    }

    // successful open
    if (connection === 'open' && !pairingDone) {
      pairingDone = true;
      clearTimeout(watchdog);
      logger.info('Connection OPEN - proceeding to upload creds');

      // ensure creds.json exists before uploading
      const credsPath = path.join(authDir, 'creds.json');
      try {
        // wait briefly for creds to be flushed
        await delay(200);
        await fs.access(credsPath);
      } catch (err) {
        logger.error({ err }, 'creds.json not ready');
        sseSend(res, 'error', { message: 'creds not ready' });
        res.end();
        try { await Gifted.ws.close(); } catch(e) {}
        await removeFile(authDir).catch(e => logger.warn(e, 'removeFile'));
        return;
      }

      try {
        const sessionId = await uploadCreds(tempId);
        logger.info({ sessionId }, 'session uploaded');

        const TERAN_BRAND = `
╔════════════════════════════╗
║  ████████╗███████╗██████╗  ║
║  ╚══██╔══╝██╔════╝██╔══██╗ ║
║     ██║   █████╗  ██████╔╝ ║
║     ██║   ██╔══╝  ██╔═══╝  ║
║     ██║   ███████╗██║      ║
║     ╚═╝   ╚══════╝╚═╝      ║
║       TERAN  •  XMD        ║
╚════════════════════════════╝

*✅ Session ID Generated ✅*
────────────────────────────
${sessionId}
────────────────────────────
Use this Session ID to deploy your bot.
Version: 5.0.0
`;

        // send messages to the logged-in account (best-effort)
        try {
          await Gifted.sendMessage(Gifted.user.id, { text: sessionId });
          await Gifted.sendMessage(Gifted.user.id, { text: TERAN_BRAND });
        } catch (err) {
          logger.warn({ err }, 'failed to send messages to self (non-fatal)');
        }

        sseSend(res, 'session', { sessionId, brand: TERAN_BRAND });
        res.end();
      } catch (err) {
        logger.error({ err: err.response?.data || err.message }, 'uploadCreds failed');
        sseSend(res, 'error', { message: 'upload failed', detail: err.response?.data || err.message });
        res.end();
      } finally {
        // ensure close + cleanup
        try { await Gifted.ws.close(); } catch(e) { logger.debug(e, 'ws close'); }
        await removeFile(authDir).catch(e => logger.warn(e, 'cleanup removeFile'));
      }
    }
  });

  // request pairing code if not registered
  try {
    if (!Gifted.authState.creds.registered) {
      await delay(1500);
      const code = await Gifted.requestPairingCode(phone);
      logger.info({ phone, code }, 'requestPairingCode returned');
      // send pairing code via SSE to client
      sseSend(res, 'code', { code });
      // keep SSE open - watchdog will handle timeout if not connected
    } else {
      logger.info('Already registered on this auth state');
      sseSend(res, 'info', { message: 'already registered' });
      res.end();
      clearTimeout(watchdog);
      await Gifted.ws.close().catch(() => {});
      await removeFile(authDir).catch(() => {});
    }
  } catch (err) {
    logger.error({ err: err.response?.data || err.message }, 'Error when requesting pairing code');
    sseSend(res, 'error', { message: 'requestPairingCode failed', detail: err.response?.data || err.message });
    res.end();
    clearTimeout(watchdog);
    try { await Gifted.ws.close(); } catch(e) {}
    await removeFile(authDir).catch(() => {});
  }

  // client disconnect handling: if client (browser) closes connection, abort pairing
  req.on('close', async () => {
    if (!pairingDone) {
      logger.info('Client closed SSE connection — aborting pairing');
      clearTimeout(watchdog);
      try { await Gifted.ws.close(); } catch(e) {}
      await removeFile(authDir).catch(e => logger.warn(e, 'cleanup after client close'));
    }
  });
});

module.exports = router;
