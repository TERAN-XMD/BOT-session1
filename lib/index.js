// lib/index.js
require('dotenv').config();
const axios = require('axios');
const fs = require('fs').promises;
const crypto = require('crypto');
const path = require('path');

let SESSIONS_API_URL = process.env.SESSIONS_API_URL || null;
let SESSIONS_API_KEY = process.env.SESSIONS_API_KEY || null;

/**
 * Allow runtime injection (useful in tests or if you want to pass config at startup)
 */
function setSessionsConfig({ url, key }) {
  SESSIONS_API_URL = url || SESSIONS_API_URL;
  SESSIONS_API_KEY = key || SESSIONS_API_KEY;
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
 * Throws a helpful error if configuration is missing.
 */
async function downloadCreds(sessionId) {
  if (!SESSIONS_API_URL || !SESSIONS_API_KEY) {
    throw new Error('Missing Sessions API configuration. Set SESSIONS_API_URL and SESSIONS_API_KEY (or call setSessionsConfig).');
  }

  if (!sessionId || typeof sessionId !== 'string' || !sessionId.startsWith('TERAN-XMD~')) {
    throw new Error('Invalid sessionId: must be a string starting with "TERAN-XMD~"');
  }

  const url = `${SESSIONS_API_URL.replace(/\/+$/, '')}/api/downloadCreds.php/${encodeURIComponent(sessionId)}`;

  try {
    const resp = await axios.get(url, {
      headers: { 'x-api-key': SESSIONS_API_KEY },
      timeout: 10000,
    });

    if (!resp.data?.credsData) {
      throw new Error('No session data received from server');
    }

    return typeof resp.data.credsData === 'string'
      ? JSON.parse(resp.data.credsData)
      : resp.data.credsData;
  } catch (error) {
    // surface server returned error if available
    const serverMsg = error.response?.data || error.message;
    const e = new Error(`Failed to download creds: ${serverMsg}`);
    e.cause = error;
    throw e;
  }
}

/**
 * Remove a file or directory (safe). Optionally restrict removal to a base dir.
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
  setSessionsConfig,
};
