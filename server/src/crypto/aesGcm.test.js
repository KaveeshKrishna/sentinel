'use strict';

const crypto = require('crypto');
process.env.SENTINEL_SECRET_KEY = crypto.randomBytes(32).toString('hex');

const test = require('node:test');
const assert = require('node:assert/strict');
const { encrypt, decrypt } = require('./aesGcm');

test('encrypt then decrypt round-trips the original plaintext', () => {
  const plaintext = 'sk-super-secret-api-key-1234567890';
  const blob = encrypt(plaintext);
  assert.notEqual(blob, plaintext);
  assert.equal(decrypt(blob), plaintext);
});

test('encrypt is non-deterministic (random IV per call)', () => {
  const blobA = encrypt('same input');
  const blobB = encrypt('same input');
  assert.notEqual(blobA, blobB);
});

test('decrypt throws on a tampered blob', () => {
  const blob = encrypt('untampered');
  const raw = Buffer.from(blob, 'base64');
  raw[raw.length - 1] ^= 0xff; // flip a bit in the ciphertext
  assert.throws(() => decrypt(raw.toString('base64')));
});
