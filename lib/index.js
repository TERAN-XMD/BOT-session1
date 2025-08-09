require('dotenv').config();
const axios = require('axios');
const fs = require('fs').promises;

const SESSIONS_API_URL = process.env.SESSIONS_API_URL;
const SESSIONS_API_KEY = process.env.SESSIONS_API_KEY;

/**
 * Generate a unique TERAN-XMD session ID
 * Example output: TERAN-XMD~aBcDeFg12345
 */
function teranId(num = 22) {
  let result = "";
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const charactersLength = characters.length;

  for (let i = 0; i < num; i++) {
    result += characters.charAt(Math.floor(Math.random() * charactersLength));
  }

  return `TERAN-XMD~${result}`;
}

/**
 * Download credentials from the session storage server
 */
async function downloadCreds(sessionId) {
  try {
    if (!sessionId.startsWith('TERAN-XMD~')) {
      throw new Error('Invalid SESSION_ID: It must start with "TERAN-XMD~"');
    }

    const response = await axios.get(
      `${SESSIONS_API_URL}/api/downloadCreds.php/${sessionId}`,
      {
        headers: { 'x-api-key': SESSIONS_API_KEY },
        timeout: 10000
      }
    );

    if (!response.data?.credsData) {
      throw new Error('No session data received from server');
    }

    return typeof response.data.credsData === 'string'
      ? JSON.parse(response.data.credsData)
      : response.data.credsData;

  } catch (error) {
    console.error('Download Error:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Remove a file or directory
 */
async function removeFile(filePath) {
  try {
    await fs.access(filePath);
    await fs.rm(filePath, { recursive: true, force: true });
    console.log(`🗑️ Removed: ${filePath}`);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log(`⚠️ Skipped remove: ${filePath} (not found)`);
    } else {
      console.error('Remove Error:', error.message);
    }
    return false;
  }
}

module.exports = {
  downloadCreds,
  removeFile,
  teranId
};
