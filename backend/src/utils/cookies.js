'use strict';

/**
 * Parse a cookie header string into a key-value map.
 * Used during WebSocket upgrade where Express cookie-parser hasn't run.
 */
function parseCookies(cookieString) {
  const cookies = {};
  if (!cookieString) return cookies;
  for (const part of cookieString.split(';')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx < 0) continue;
    const key = part.slice(0, eqIdx).trim();
    const val = part.slice(eqIdx + 1).trim();
    if (key) cookies[key] = decodeURIComponent(val);
  }
  return cookies;
}

module.exports = { parseCookies };
