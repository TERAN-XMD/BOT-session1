const {
    default: TeranXMD_Tech,
    useMultiFileAuthState,
    Browsers,
    delay,
    jidNormalizedUser,
    DisconnectReason,
    makeInMemoryStore
} = require("@whiskeysockets/baileys");

const { teranXmdId, removeFile } = require('../lib'); // make sure this exists (or change to giftedId if not renamed)
const express = require("express");
const router = express.Router();
const pino = require("pino");
const { toBuffer } = require("qrcode");
const path = require('path');
require('dotenv').config();
const fs = require('fs').promises;
const NodeCache = require('node-cache');
const { Boom } = require("@hapi/boom");
const axios = require('axios');

const SESSIONS_API_URL = process.env.SESSIONS_API_URL;
const SESSIONS_API_KEY = process.env.SESSIONS_API_KEY;

async function uploadCreds(id) {
    try {
        const authPath = path.join(__dirname, 'temp', id, 'creds.json');

        try {
            await fs.access(authPath);
        } catch {
            console.error('Creds file not found at:', authPath);
            return null;
        }

        const credsData = JSON.parse(await fs.readFile(authPath, 'utf8'));
        const credsId = teranXmdId();

        await axios.post(
            `${SESSIONS_API_URL}/api/uploadCreds.php`,
            { credsId, credsData },
            {
                headers: {
                    'x-api-key': SESSIONS_API_KEY,
                    'Content-Type': 'application/json',
                },
                timeout: 8000
            }
        );

        return credsId;
    } catch (error) {
        console.error('Error uploading credentials:', error.response?.data || error.message);
        // fallback: return local id so user still receives a session id
        return teranXmdId();
    }
}

router.get("/", async (req, res) => {
    const id = teranXmdId();
    const authDir = path.join(__dirname, 'temp', id);

    try {
        try {
            await fs.access(authDir);
        } catch {
            await fs.mkdir(authDir, { recursive: true });
        }

        async function TERAN_QR_CODE() {
            const { state, saveCreds } = await useMultiFileAuthState(authDir);
            const msgRetryCounterCache = new NodeCache();

            try {
                let TeranXMD = TeranXMD_Tech({
                    printQRInTerminal: false,
                    logger: pino({ level: "silent" }),
                    browser: Browsers.baileys("Desktop"),
                    auth: state,
                    msgRetryCounterCache,
                    defaultQueryTimeoutMs: undefined
                });

                TeranXMD.ev.on("connection.update", async (update) => {
                    const { connection, lastDisconnect, qr } = update;

                    if (qr) {
                        try {
                            const qrBuffer = await toBuffer(qr);
                            if (!res.headersSent) {
                                res.type('png').send(qrBuffer);
                            }
                        } catch (qrError) {
                            console.error('QR render error:', qrError);
                            if (!res.headersSent) {
                                res.status(500).send("QR generation failed");
                            }
                        }
                    }

                    if (connection === "open") {
                        try {
                            await delay(3000);
                            const sessionId = await uploadCreds(id);
                            if (!sessionId) {
                                throw new Error('Failed to generate/upload credentials');
                            }

                            // send session id (first message)
                            const session = await TeranXMD.sendMessage(TeranXMD.user.id, { text: sessionId });

                            // TERAN-XMD ASCII branding + short instructions
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

*✅ SESSION ID GENERATED ✅*
────────────────────────────
This Session ID has been generated for your bot.
Keep it private — do NOT share it.
Validate using your validator before deployment.
Version: 5.0.0
────────────────────────────
`;

                            await TeranXMD.sendMessage(TeranXMD.user.id, { text: TERAN_BRAND }, { quoted: session });

                            await delay(1000);
                            await TeranXMD.ws.close();
                            await removeFile(authDir);

                        } catch (error) {
                            console.error('Session processing failed:', error);

                            try {
                                await TeranXMD.sendMessage(TeranXMD.user.id, {
                                    text: '⚠️ Session generation/upload failed. Please try again.'
                                });
                            } catch (msgError) {
                                console.error('Failed to send error message:', msgError);
                            }

                            try {
                                await TeranXMD.ws.close();
                                await removeFile(authDir);
                            } catch (cleanupError) {
                                console.error('Cleanup failed:', cleanupError);
                            }
                        }
                    }

                    if (connection === "close") {
                        const statusCode = new Boom(lastDisconnect?.error)?.output.statusCode;

                        if (statusCode === DisconnectReason.restartRequired) {
                            await delay(2000);
                            TERAN_QR_CODE().catch(err => console.error('Restart failed:', err));
                        }
                    }
                });

                TeranXMD.ev.on('creds.update', saveCreds);

            } catch (error) {
                console.error("Initialization error:", error);
                try {
                    await removeFile(authDir);
                } catch (cleanupError) {
                    console.error('Initial cleanup failed:', cleanupError);
                }

                if (!res.headersSent) {
                    res.status(500).send("Initialization failed");
                }
            }
        }

        await TERAN_QR_CODE();
    } catch (error) {
        console.error("Fatal error:", error);
        try {
            await removeFile(authDir);
        } catch (finalCleanupError) {
            console.error('Final cleanup failed:', finalCleanupError);
        }

        if (!res.headersSent) {
            res.status(500).send("Service unavailable");
        }
    }
});

module.exports = router;
