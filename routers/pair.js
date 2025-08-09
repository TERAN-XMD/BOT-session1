const { 
    giftedId: teranId,
    removeFile
} = require('../lib'); 

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
            console.error('Creds file not found at:', authPath);
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
        console.error('Error uploading credentials:', error.response?.data || error.message);
        return null;
    }
}

router.get('/', async (req, res) => {
    const id = teranId(); 
    let num = req.query.number;

    if (!num) {
        return res.status(400).send({ error: "Phone number is required" });
    }

    async function TERAN_PAIR_CODE() {
        const authDir = path.join(__dirname, 'temp', id);

        try {
            if (!fs.existsSync(authDir)) {
                fs.mkdirSync(authDir, { recursive: true });
            }

            const { state, saveCreds } = await useMultiFileAuthState(authDir);

            let Gifted = TERAN_XMD({
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
                },
                printQRInTerminal: false,
                logger: pino({ level: "fatal" }).child({ level: "fatal" }),
                browser: Browsers.macOS("Safari")
            });

            if (!Gifted.authState.creds.registered) {
                await delay(1500);
                num = num.replace(/[^0-9]/g, '');
                const code = await Gifted.requestPairingCode(num);
                console.log(`Your Code: ${code}`);

                if (!res.headersSent) {
                    res.send({ code });
                }
            }

            Gifted.ev.on('creds.update', saveCreds);

            Gifted.ev.on("connection.update", async (s) => {
                const { connection } = s;

                if (connection === "open") {
                    await delay(5000);

                    try {
                        const sessionId = await uploadCreds(id);
                        if (!sessionId) {
                            throw new Error('Failed to upload credentials');
                        }

                        // Send the Session ID as the first message
                        const session = await Gifted.sendMessage(Gifted.user.id, { text: sessionId });

                        // TERAN-XMD branding message
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
Use the above Session ID to deploy your bot.
Make sure to validate it first using your validator tool.
────────────────────────────
Version: 5.0.0
`;

                        await Gifted.sendMessage(Gifted.user.id, { text: TERAN_BRAND }, { quoted: session });

                    } catch (err) {
                        console.error('Error in connection update:', err);
                    } finally {
                        await delay(100);
                        await Gifted.ws.close();
                        removeFile(authDir).catch(err => console.error('Error removing temp files:', err));
                    }
                }
            });

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
    }

    await TERAN_PAIR_CODE();
});

module.exports = router;
