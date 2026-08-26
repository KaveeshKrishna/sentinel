'use strict';

const fs = require('fs');
const crypto = require('crypto');

const TOKEN_PATH = process.env.SENTINEL_AGENT_TOKEN_PATH || '/etc/sentinel/agent.token';

let cachedToken = null;

/**
 * Load the shared bearer token. SENTINEL_AGENT_TOKEN (env) takes priority
 * for tests and local dev; production reads the file written by the
 * installer at /etc/sentinel/agent.token (0640 root:sentinel) — the
 * socket's own 0660 root:sentinel mode is the first factor, this token is
 * the second, independent one, and the one a future network transport
 * will reuse.
 */
function loadToken() {
  if (cachedToken) return cachedToken;
  if (process.env.SENTINEL_AGENT_TOKEN) {
    cachedToken = process.env.SENTINEL_AGENT_TOKEN;
    return cachedToken;
  }
  try {
    cachedToken = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
  } catch {
    cachedToken = null;
  }
  return cachedToken;
}

/**
 * Constant-time token comparison. Padding a mismatched-length comparison
 * against a same-length buffer avoids leaking length via timing while
 * still using the fast native comparator.
 */
function timingSafeEqual(a, b) {
  const bufA = Buffer.from(a || '');
  const bufB = Buffer.from(b || '');
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, Buffer.alloc(bufA.length));
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function authMiddleware(req, res, next) {
  const token = loadToken();
  if (!token) {
    return res.status(500).json({ error: 'Agent token not configured' });
  }
  const header = req.headers.authorization || '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!presented || !timingSafeEqual(presented, token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

module.exports = { authMiddleware, loadToken, timingSafeEqual };
