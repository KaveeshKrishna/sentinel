'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = path.join(os.tmpdir(), `sentinel-test-sessions-${crypto.randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const { migrate } = require('../db/migrate');
migrate();

const { createUser } = require('./users');
const { createSession, isSessionValid, revokeSession, pruneExpiredSessions } = require('./sessions');

after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(DB_PATH + suffix); } catch { /* already gone */ }
  }
});

test('a freshly created session is valid', async () => {
  const user = await createUser('u1', 'password123', 'owner');
  const jti = createSession(user.id, 3600);
  assert.equal(isSessionValid(jti), true);
});

test('a jti that was never created is invalid', () => {
  assert.equal(isSessionValid('not-a-real-jti'), false);
});

test('revokeSession invalidates the session immediately — this is what makes logout actually work', async () => {
  const user = await createUser('u2', 'password123', 'owner');
  const jti = createSession(user.id, 3600);
  assert.equal(isSessionValid(jti), true);
  revokeSession(jti);
  assert.equal(isSessionValid(jti), false);
});

test('a session created with a negative TTL is already invalid', async () => {
  const user = await createUser('u3', 'password123', 'owner');
  const jti = createSession(user.id, -10);
  assert.equal(isSessionValid(jti), false);
});

test('pruneExpiredSessions removes expired rows without touching valid ones', async () => {
  const user = await createUser('u4', 'password123', 'owner');
  const validJti = createSession(user.id, 3600);
  const expiredJti = createSession(user.id, -10);
  pruneExpiredSessions();
  assert.equal(isSessionValid(validJti), true);
  assert.equal(isSessionValid(expiredJti), false);
});
