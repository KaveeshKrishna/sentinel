'use strict';

// Isolated in its own file (node --test runs each file in its own
// process) specifically so the login rate limiter's in-memory counter —
// a module-level singleton for the life of the process — starts fresh
// and isn't polluted by login attempts made in other test files.

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = path.join(os.tmpdir(), `sentinel-test-ratelimit-${crypto.randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;
process.env.JWT_SECRET = 'test-jwt-secret-not-used-in-production';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const { migrate } = require('../db/migrate');
migrate();

const { createApp } = require('../app');
const { createUser } = require('./users');

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

test('login is rate-limited after 5 attempts from the same client within the window', async () => {
  await createUser('admin', 'longenough123', 'owner');

  await withServer(async (base) => {
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      const res = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'wrong-every-time' })
      });
      statuses.push(res.status);
    }
    assert.deepEqual(statuses.slice(0, 5), [401, 401, 401, 401, 401], 'first 5 attempts should be evaluated normally (and fail on bad password)');
    assert.equal(statuses[5], 429, 'the 6th attempt within the window should be rate-limited, not evaluated');
  });
});
