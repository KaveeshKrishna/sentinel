'use strict';

const crypto = require('crypto');
const { countUsers } = require('../auth/users');
const { getSetting, setSetting } = require('../db/settings');

const SETUP_TOKEN_KEY = 'setup_token';

/**
 * If no admin user exists yet, ensure a one-time setup token exists and
 * print it (and the URL to use it at) prominently to stdout. Reuses the
 * same token across restarts — a process restart before setup completes
 * shouldn't strand the operator without the token they were shown, and
 * shouldn't invalidate a token an installer already printed/handed off.
 *
 * In production the installer generates and prints this same token
 * itself, immediately after a fresh install; this function is what makes
 * that work identically whether Sentinel was set up via the installer or
 * started directly (e.g. in development, or if the installer's own
 * token got lost and the operator just restarts the service).
 */
function ensureSetupToken(port) {
  if (countUsers() > 0) return null;

  let token = getSetting(SETUP_TOKEN_KEY);
  if (!token) {
    token = crypto.randomBytes(24).toString('base64url');
    setSetting(SETUP_TOKEN_KEY, token);
  }

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Sentinel — first-run setup required                          ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`  Visit:  http://localhost:${port}/setup`);
  console.log(`  Setup token:  ${token}`);
  console.log('  (This token is single-use and only needed once, to create the');
  console.log('   first admin account. It is safe to keep this in scrollback —');
  console.log('   it stops working the moment setup completes.)');
  console.log('');

  return token;
}

module.exports = { ensureSetupToken, SETUP_TOKEN_KEY };
