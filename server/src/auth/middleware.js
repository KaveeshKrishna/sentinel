'use strict';

const jwt = require('jsonwebtoken');
const { isSessionValid } = require('./sessions');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('[FATAL] JWT_SECRET environment variable is not set.');
  process.exit(1);
}

/**
 * Verify a JWT token string AND that its session hasn't been revoked
 * (logout, or a future "sign out other sessions" action deletes the
 * auth_sessions row for its jti). A syntactically valid, unexpired JWT
 * whose session was revoked is treated the same as an invalid one.
 * Throws on failure.
 * @param {string} token
 * @returns {object} decoded payload
 */
function verifyToken(token) {
  if (!token) throw new Error('No token provided');
  const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  if (!isSessionValid(payload.jti)) throw new Error('Session has been revoked or expired');
  return payload;
}

/**
 * Express middleware — requires a valid, non-revoked sentinel_token cookie.
 */
function authMiddleware(req, res, next) {
  const token = req.cookies?.sentinel_token;
  try {
    req.user = verifyToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

module.exports = { authMiddleware, verifyToken };
