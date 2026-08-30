'use strict';

const crypto = require('crypto');
const test = require('node:test');
const assert = require('node:assert/strict');

test('loadSecretKey reads a valid 32-byte hex key from the env override', () => {
  delete require.cache[require.resolve('./secretKey')];
  process.env.SENTINEL_SECRET_KEY = crypto.randomBytes(32).toString('hex');
  const { loadSecretKey } = require('./secretKey');
  const key = loadSecretKey();
  assert.equal(key.length, 32);
});

test('loadSecretKey caches the key across calls', () => {
  delete require.cache[require.resolve('./secretKey')];
  process.env.SENTINEL_SECRET_KEY = crypto.randomBytes(32).toString('hex');
  const { loadSecretKey } = require('./secretKey');
  const a = loadSecretKey();
  process.env.SENTINEL_SECRET_KEY = crypto.randomBytes(32).toString('hex');
  const b = loadSecretKey();
  assert.equal(a.toString('hex'), b.toString('hex'));
});

test('loadSecretKey rejects a key of the wrong length', () => {
  delete require.cache[require.resolve('./secretKey')];
  process.env.SENTINEL_SECRET_KEY = crypto.randomBytes(16).toString('hex');
  const { loadSecretKey } = require('./secretKey');
  assert.throws(() => loadSecretKey(), /32 bytes/);
});
