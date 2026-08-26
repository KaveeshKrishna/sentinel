'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = path.join(os.tmpdir(), `sentinel-test-users-${crypto.randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');

const { migrate } = require('../db/migrate');
migrate();

const { countUsers, createUser, getUserByUsername, getUserById, touchLastLogin } = require('./users');

after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(DB_PATH + suffix); } catch { /* already gone */ }
  }
});

test('countUsers starts at 0 on a fresh database', () => {
  assert.equal(countUsers(), 0);
});

test('createUser hashes the password (never stores it in plaintext) and persists the user', async () => {
  const user = await createUser('admin', 'a-real-password-123', 'owner');
  assert.equal(user.username, 'admin');
  assert.equal(user.role, 'owner');
  assert.notEqual(user.password_hash, 'a-real-password-123');
  assert.ok(await bcrypt.compare('a-real-password-123', user.password_hash));
  assert.equal(countUsers(), 1);
});

test('getUserByUsername finds an existing user and returns undefined for an unknown one', () => {
  assert.ok(getUserByUsername('admin'));
  assert.equal(getUserByUsername('does-not-exist'), undefined);
});

test('touchLastLogin sets last_login_at', () => {
  const user = getUserByUsername('admin');
  assert.equal(user.last_login_at, null);
  touchLastLogin(user.id);
  const updated = getUserById(user.id);
  assert.ok(updated.last_login_at > 0);
});
