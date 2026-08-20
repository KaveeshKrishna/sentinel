'use strict';

const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';
const SESSION_TTL = 12 * 60 * 60; // 12 hours in seconds

// Dummy hash for constant-time comparison on wrong username
const DUMMY_HASH = '$2b$12$invalidhashXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  // Always run bcrypt to prevent timing attacks on username enumeration
  const hashToCompare = username === ADMIN_USERNAME ? ADMIN_PASSWORD_HASH : DUMMY_HASH;
  const valid = await bcrypt.compare(password, hashToCompare);

  if (!valid || username !== ADMIN_USERNAME) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: SESSION_TTL });

  res.cookie('sentinel_token', token, {
    httpOnly: true,
    secure: false,       // Cloudflare Tunnel handles TLS; cookie travels over localhost HTTP
    sameSite: 'strict',
    maxAge: SESSION_TTL * 1000,
    path: '/'
  });

  res.json({ ok: true, username });
});

router.post('/logout', (req, res) => {
  res.clearCookie('sentinel_token', { path: '/' });
  res.json({ ok: true });
});

router.get('/check', (req, res) => {
  const token = req.cookies?.sentinel_token;
  if (!token) return res.json({ authenticated: false });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    res.json({ authenticated: true, username: payload.username });
  } catch {
    res.json({ authenticated: false });
  }
});

module.exports = router;
