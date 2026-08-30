'use strict';

const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const { getUserByUsername, touchLastLogin, BCRYPT_COST } = require('./users');
const { createSession, revokeSession, pruneExpiredSessions } = require('./sessions');
const { withBcryptSlot } = require('./bcryptLimiter');
const { verifyToken } = require('./middleware');
const { logEvent } = require('../activity/logger');

const JWT_SECRET = process.env.JWT_SECRET;
const SESSION_TTL = 12 * 60 * 60; // 12 hours in seconds

// A real, well-formed bcrypt hash of a value nobody could have chosen as
// their password (a random 32-byte string generated once at boot) — used
// to give a wrong-username login the same bcrypt work as a real one, so
// the response-time difference doesn't leak whether the username exists.
// Generated dynamically (not a hardcoded literal) so it's guaranteed to
// be a structurally valid hash at the configured cost.
const DUMMY_HASH = bcrypt.hashSync(require('crypto').randomBytes(32).toString('hex'), BCRYPT_COST);

// 5 attempts per 15 minutes per IP. This bounds the *arrival rate* of
// login attempts; withBcryptSlot (below) separately bounds how many of
// those attempts can be doing bcrypt work at once, since a wide-enough
// spread of source IPs would otherwise still be able to saturate the
// threadpool despite this per-IP limit.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again later.' }
});

router.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const user = getUserByUsername(username);
  const hashToCompare = user ? user.password_hash : DUMMY_HASH;

  const valid = await withBcryptSlot(() => bcrypt.compare(password, hashToCompare));

  if (!valid || !user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  pruneExpiredSessions();
  const jti = createSession(user.id, SESSION_TTL);
  touchLastLogin(user.id);

  const token = jwt.sign({ username: user.username, sub: user.id, jti }, JWT_SECRET, {
    expiresIn: SESSION_TTL,
    algorithm: 'HS256'
  });

  res.cookie('sentinel_token', token, {
    httpOnly: true,
    // Trust the proxy's X-Forwarded-Proto if present (Caddy/cloudflared
    // terminate TLS in front of Sentinel); fall back to the request's own
    // protocol. Unlike the previous hardcoded `secure: false`, this
    // reflects how the request actually arrived instead of assuming a
    // specific ingress setup.
    secure: (req.headers['x-forwarded-proto'] || req.protocol) === 'https',
    sameSite: 'strict',
    maxAge: SESSION_TTL * 1000,
    path: '/'
  });

  logEvent('LOGIN', `User "${user.username}" logged in`);
  res.json({ ok: true, username: user.username });
});

router.post('/logout', (req, res) => {
  const token = req.cookies?.sentinel_token;
  if (token) {
    try {
      const payload = jwt.decode(token);
      if (payload?.jti) revokeSession(payload.jti);
      if (payload?.username) logEvent('LOGOUT', `User "${payload.username}" logged out`);
    } catch { /* malformed cookie — nothing to revoke */ }
  }
  res.clearCookie('sentinel_token', { path: '/' });
  res.json({ ok: true });
});

router.get('/check', (req, res) => {
  const token = req.cookies?.sentinel_token;
  if (!token) return res.json({ authenticated: false });
  try {
    const payload = verifyToken(token);
    res.json({ authenticated: true, username: payload.username });
  } catch {
    res.json({ authenticated: false });
  }
});

module.exports = router;
