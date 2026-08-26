'use strict';

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('[FATAL] JWT_SECRET environment variable is not set. Run: npm run setup');
  process.exit(1);
}

/**
 * Verify a JWT token string. Throws on failure.
 * @param {string} token
 * @returns {object} decoded payload
 */
function verifyToken(token) {
  if (!token) throw new Error('No token provided');
  return jwt.verify(token, JWT_SECRET);
}

/**
 * Express middleware — requires valid sentinel_token cookie.
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
