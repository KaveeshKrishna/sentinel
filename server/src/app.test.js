'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = path.join(os.tmpdir(), `sentinel-test-app-${crypto.randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;
process.env.JWT_SECRET = 'test-jwt-secret-not-used-in-production';
process.env.NODE_ENV = 'test';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const { migrate } = require('./db/migrate');
migrate();

const { createApp } = require('./app');
const { getSetting, setSetting } = require('./db/settings');
const { SETUP_TOKEN_KEY } = require('./setup/bootstrap');
const { countUsers } = require('./auth/users');

// createApp() doesn't run server.js's bootstrap (ensureSetupToken), so
// seed a setup token the same way it would, up front — tests below
// exercise the /api/setup routes against this known token.
const SETUP_TOKEN = crypto.randomBytes(24).toString('base64url');
setSetting(SETUP_TOKEN_KEY, SETUP_TOKEN);

after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(DB_PATH + suffix); } catch { /* already gone */ }
  }
});

async function withServer(fn) {
  const app = createApp();
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const port = server.address().port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

/** Parses a `Set-Cookie` header for the sentinel_token value, for tests that need to reuse it. */
function extractCookie(res) {
  const raw = res.headers.get('set-cookie') || '';
  const match = raw.match(/sentinel_token=([^;]+)/);
  return match ? match[1] : null;
}

test('GET /health requires no auth', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
  });
});

test('protected routes reject requests with no session cookie', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/activity`);
    assert.equal(res.status, 401);
  });
});

// ── Setup flow ────────────────────────────────────────────────────────────────

test('GET /api/setup/status reports needsSetup true before any user exists', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/setup/status`);
    const body = await res.json();
    assert.equal(body.needsSetup, true);
  });
});

test('POST /api/setup/complete rejects a wrong setup token', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/setup/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'wrong-token', username: 'admin', password: 'longenough123' })
    });
    assert.equal(res.status, 401);
    assert.equal(countUsers(), 0);
  });
});

test('POST /api/setup/complete rejects a short password', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/setup/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: SETUP_TOKEN, username: 'admin', password: 'short' })
    });
    assert.equal(res.status, 400);
    assert.equal(countUsers(), 0);
  });
});

test('POST /api/setup/complete with the correct token creates the admin and logs them in', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/setup/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: SETUP_TOKEN, username: 'admin', password: 'longenough123' })
    });
    assert.equal(res.status, 200);
    assert.equal(countUsers(), 1);
    assert.ok(extractCookie(res), 'setup should auto-login by setting the session cookie');
    assert.equal(getSetting(SETUP_TOKEN_KEY), null, 'setup token should be consumed');
  });
});

test('a second setup attempt is rejected once an admin exists', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/setup/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'anything', username: 'someone-else', password: 'longenough123' })
    });
    assert.equal(res.status, 409);
    assert.equal(countUsers(), 1);
  });
});

// ── Login flow (uses the admin user created above) ──────────────────────────

test('login with the correct password succeeds and sets a session cookie', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'longenough123' })
    });
    assert.equal(res.status, 200);
    const cookie = extractCookie(res);
    assert.ok(cookie);

    const checkRes = await fetch(`${base}/api/auth/check`, { headers: { Cookie: `sentinel_token=${cookie}` } });
    const checkBody = await checkRes.json();
    assert.equal(checkBody.authenticated, true);
    assert.equal(checkBody.username, 'admin');
  });
});

test('login with a wrong password fails with 401', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'totally-wrong' })
    });
    assert.equal(res.status, 401);
  });
});

test('login with an unknown username fails with 401 (not a different error)', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'nobody', password: 'irrelevant123' })
    });
    assert.equal(res.status, 401);
  });
});

test('logout revokes the session — the same cookie stops working afterward', async () => {
  await withServer(async (base) => {
    const loginRes = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'longenough123' })
    });
    const cookie = extractCookie(loginRes);

    const protectedBefore = await fetch(`${base}/api/activity`, { headers: { Cookie: `sentinel_token=${cookie}` } });
    assert.equal(protectedBefore.status, 200);

    await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { Cookie: `sentinel_token=${cookie}` } });

    const protectedAfter = await fetch(`${base}/api/activity`, { headers: { Cookie: `sentinel_token=${cookie}` } });
    assert.equal(protectedAfter.status, 401, 'the same JWT should be rejected once its session is revoked');
  });
});
