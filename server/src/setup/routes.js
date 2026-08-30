'use strict';

const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const path = require('path');
const router = express.Router();

const { countUsers, createUser } = require('../auth/users');
const { createSession } = require('../auth/sessions');
const { getSetting, deleteSetting } = require('../db/settings');
const { SETUP_TOKEN_KEY } = require('./bootstrap');
const { logEvent } = require('../activity/logger');

const JWT_SECRET = process.env.JWT_SECRET;
const SESSION_TTL = 12 * 60 * 60;

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(a || '');
  const bufB = Buffer.from(b || '');
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, Buffer.alloc(bufA.length));
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

router.get('/status', (_req, res) => {
  res.json({ needsSetup: countUsers() === 0 });
});

router.post('/complete', async (req, res) => {
  if (countUsers() > 0) {
    return res.status(409).json({ error: 'Setup has already been completed' });
  }

  const { token, username, password } = req.body || {};
  const expected = getSetting(SETUP_TOKEN_KEY);

  if (!expected || !token || !timingSafeEqual(token, expected)) {
    return res.status(401).json({ error: 'Invalid or missing setup token' });
  }
  if (!username || typeof username !== 'string' || username.trim().length < 1) {
    return res.status(400).json({ error: 'Username is required' });
  }
  if (!password || typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  // Narrow (not fully eliminate) the race between two concurrent setup
  // requests: re-check immediately before the write, after the token/
  // validation checks above but before the (slower) password hash.
  if (countUsers() > 0) {
    return res.status(409).json({ error: 'Setup has already been completed' });
  }

  const user = await createUser(username.trim(), password, 'owner');
  deleteSetting(SETUP_TOKEN_KEY);
  logEvent('SETUP_COMPLETED', `Initial admin account "${user.username}" created`);

  // Auto-login: no reason to make the operator log in a second time
  // immediately after setting their own password.
  const jti = createSession(user.id, SESSION_TTL);
  const jwtToken = jwt.sign({ username: user.username, sub: user.id, jti }, JWT_SECRET, {
    expiresIn: SESSION_TTL,
    algorithm: 'HS256'
  });
  res.cookie('sentinel_token', jwtToken, {
    httpOnly: true,
    secure: (req.headers['x-forwarded-proto'] || req.protocol) === 'https',
    sameSite: 'strict',
    maxAge: SESSION_TTL * 1000,
    path: '/'
  });

  res.json({ ok: true, username: user.username });
});

/** Serves the standalone setup page (not part of the React SPA bundle). */
function setupPageHandler(_req, res) {
  res.sendFile(path.join(__dirname, 'page.html'));
}

module.exports = { router, setupPageHandler };
