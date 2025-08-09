const { teranId, removeFile } = require('../lib'); // fixed import
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
require('dotenv').config();
const pino = require("pino");
const {
    default: TERAN_XMD,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers
} = require("@whiskeysockets/baileys");

const router = express.Router();
const { SESSIONS_API_URL, SESSIONS_API_KEY } = process.env;

async function uploadCreds(id) {
    try {
        const authPath = path.join(__dirname, 'temp', id, 'creds.json');

        try {
            await fs.access(authPath);
        } catch {
            console.error('❌ Creds file not found:', authPath);
            return null;
        }

        const credsData = JSON.parse(await fs.readFile(authPath, 'utf8'));
        const credsId = teranId();

        await axios.post(
            `${SESSIONS_API_URL}/api/uploadCreds.php`,
            { credsId, credsData },
            {
                headers: {
                    'x-api-key': SESSIONS_API_KEY,
                    'Content-Type': 'application/json',
                },
                timeout: 10000
            }
        );

        return credsId;
    } catch (error) {
        console.error('❌ Error uploading credentials:', error.response?.data || error.message);
        return null;
    }
}

router.get('/', async (req, res) => {
    const pairingId = teranId();
    const phoneNumber = req.query.number;

    if (!phoneNumber) {
        return res.status(400).json({ error: "Phone number is required" });
    }

    const authDir = path.join(__dirname, 'temp', pairingId);
    await fs.mkdir(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const Gifted = TERAN_XMD({
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
        },
        printQRInTerminal: false,
        logger: pino({ level: "fatal" }),
        browser: Browsers.macOS("Safari")
    });

    let pairingDone = false;

    if (!Gifted.authState.creds.registered) {
        await delay(1500);
        const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
        const code = await Gifted.requestPairingCode(cleanNumber);
        console.log(`📲 Pairing Code for ${cleanNumber}: ${code}`);

        res.write(JSON.stringify({ code }) + "\n");
        res.flush?.();
    }

    Gifted.ev.on('creds.update', saveCreds);

    const cleanup = async () => {
        await delay(100);
        await Gifted.ws.close().catch(() => {});
        await removeFile(authDir);
    };

    Gifted.ev.on("connection.update", async (update) => {
        console.log("🔄 Connection Update:", update);
        const { connection, lastDisconnect } = update;

        if (connection === "close" && !pairingDone) {
            pairingDone = true;
            const reason = lastDisconnect?.error?.output?.statusCode;
            res.write(JSON.stringify({ error: "Connection closed", reason }) + "\n");
            res.end();
            await cleanup();
        }

        if (connection === "open" && !pairingDone) {
            pairingDone = true;
            try {
                console.log("✅ Connected successfully, uploading creds...");
                const sessionId = await uploadCreds(pairingId);
                if (!sessionId) throw new Error('Failed to upload credentials');

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

                await Gifted.sendMessage(Gifted.user.id, { text: sessionId });
                await Gifted.sendMessage(Gifted.user.id, { text: TERAN_BRAND });

                res.write(JSON.stringify({ sessionId, brand: TERAN_BRAND }) + "\n");
                res.end();
            } catch (err) {
                console.error('❌ Error in connection update:', err);
                res.write(JSON.stringify({ error: err.message }) + "\n");
                res.end();
            } finally {
                await cleanup();
            }
        }
    });
});

module.exports = router;
