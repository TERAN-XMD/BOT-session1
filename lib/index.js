require('dotenv').config();
const axios = require('axios');
const fs = require('fs').promises;
const crypto = require('crypto');
const path = require('path');

// Load and validate env vars
const { SESSIONS_API_URL, SESSIONS_API_KEY } = process.env;
if (!SESSIONS_API_URL || !SESSIONS_API_KEY) {
  throw new Error('❌ Missing required env vars: SESSIONS_API_URL, SESSIONS_API_KEY');
}

/**
 * Generate a cryptographically strong TERAN-XMD session ID.
 * Example output: TERAN-XMD~aBcDeFg12345
 */
function teranId(length = 22) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(length);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return `TERAN-XMD~${result}`;
}

/**
 * Download credentials from the session storage server.
 */
async function downloadCreds(sessionId) {
  try {
    if (!sessionId.startsWith('TERAN-XMD~')) {
      throw new Error('Invalid SESSION_ID: It must start with "TERAN-XMD~"');
    }

    const url = `${SESSIONS_API_URL}/api/downloadCreds.php/${encodeURIComponent(sessionId)}`;
    const response = await axios.get(url, {
      headers: { 'x-api-key': SESSIONS_API_KEY },
      timeout: 10000,
    });

    const creds = response.data?.credsData;
    if (!creds) throw new Error('No session data received from server');

    return typeof creds === 'string' ? JSON.parse(creds) : creds;
  } catch (error) {
    console.error('Download Error:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Safely remove a file or directory.
 * Optional: restrict deletions to a specific base directory for safety.
 */
async function removeFile(filePath, safeBaseDir = null) {
  try {
    if (safeBaseDir) {
      const resolvedPath = path.resolve(filePath);
      const resolvedBase = path.resolve(safeBaseDir);
      if (!resolvedPath.startsWith(resolvedBase)) {
        throw new Error(`Refused to delete outside base dir: ${resolvedPath}`);
      }
    }

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
  teranId,
  downloadCreds,
  removeFile,
};
