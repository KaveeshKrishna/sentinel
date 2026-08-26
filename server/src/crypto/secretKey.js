'use strict';

const fs = require('fs');

const SECRET_KEY_PATH = process.env.SENTINEL_SECRET_KEY_PATH || '/etc/sentinel/secret.key';

let cachedKey = null;

/**
 * Load the 32-byte AES-256 key used to encrypt the AI provider's API key
 * at rest. Mirrors agent/src/auth.js's loadToken(): SENTINEL_SECRET_KEY
 * (env, hex) takes priority for tests/dev; production reads the file the
 * installer generates at /etc/sentinel/secret.key (0640 root:sentinel,
 * `openssl rand -hex 32` — 64 hex chars, i.e. already exactly 32 bytes).
 * @returns {Buffer}
 */
function loadSecretKey() {
  if (cachedKey) return cachedKey;

  const hex = process.env.SENTINEL_SECRET_KEY || fs.readFileSync(SECRET_KEY_PATH, 'utf8').trim();
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) {
    throw new Error(`Sentinel secret key must be 32 bytes (64 hex chars), got ${key.length}`);
  }
  cachedKey = key;
  return cachedKey;
}

function _resetForTesting() {
  cachedKey = null;
}

module.exports = { loadSecretKey, _resetForTesting };
