const { giftedId: teranId, removeFile } = require('../lib');
const express = require('express');
const fs = require('fs');
const axios = require('axios');
require('dotenv').config();
const path = require('path');
let router = express.Router();
const pino = require("pino");

const SESSIONS_API_URL = process.env.SESSIONS_API_URL;
const SESSIONS_API_KEY = process.env.SESSIONS_API_KEY;

const {
    default: TERAN_XMD,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers
} = require("@whiskeysockets/baileys");

async function uploadCreds(id) {
    try {
        const authPath = path.join(__dirname, 'temp', id, 'creds.json');

        if (!fs.existsSync(authPath)) {
            console.error('❌ Creds file not found at:', authPath);
            return null;
        }

        const credsData = JSON.parse(fs.readFileSync(authPath, 'utf8'));
        const credsId = teranId();

        await axios.post(
            `${SESSIONS_API_URL}/api/uploadCreds.php`,
            { credsId, credsData },
            {
                headers: {
                    'x-api-key': SESSIONS_API_KEY,
                    'Content-Type': 'application/json',
                },
            }
        );

        return credsId;
    } catch (error) {
        console.error('❌ Error uploading credentials:', error.response?.data || error.message);
        return null;
    }
}

router.get('/', async (req, res) => {
    const id = teranId();
    let num = req.query.number;

    if (!num) {
        return res.status(400).send({ error: "Phone number is required" });
    }

    const authDir = path.join(__dirname, 'temp', id);

    if (!fs.existsSync(authDir)) {
        fs.mkdirSync(authDir, { recursive: true });
    }

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
        num = num.replace(/[^0-9]/g, '');
        const code = await Gifted.requestPairingCode(num);
        console.log(`📲 Pairing Code for ${num}: ${code}`);

        // Send code to HTTP client
        res.write(JSON.stringify({ code }) + "\n");
        res.flush?.(); // Keep connection open
    }

    Gifted.ev.on('creds.update', saveCreds);

    Gifted.ev.on("connection.update", async (s) => {
        console.log("🔄 Connection Update:", s);

        const { connection, lastDisconnect } = s;

        if (connection === "close") {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.error("❌ Connection closed. Reason:", reason);
            if (!pairingDone) {
                pairingDone = true;
                res.write(JSON.stringify({ error: "Connection closed", reason }) + "\n");
                res.end();
            }
        }

        if (connection === "open" && !pairingDone) {
            pairingDone = true;
            console.log("✅ Connected successfully, uploading creds...");

            try {
                const sessionId = await uploadCreds(id);
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
                await delay(100);
                await Gifted.ws.close();
                removeFile(authDir).catch(err => console.error('❌ Error removing temp files:', err));
            }
        }
    });
});

module.exports = router;
