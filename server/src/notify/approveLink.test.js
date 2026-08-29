'use strict';

const crypto = require('crypto');
process.env.SENTINEL_SECRET_KEY = crypto.randomBytes(32).toString('hex');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { signApproveToken, verifyApproveToken, buildApproveUrl, TTL_MS } = require('./approveLink');

test('a freshly signed token verifies back to the exact incident and action', () => {
  const token = signApproveToken({ incidentId: 42, actionId: 7 });
  const claim = verifyApproveToken(token);
  assert.equal(claim.incidentId, 42);
  assert.equal(claim.actionId, 7);
  assert.ok(claim.expiresAt > Date.now());
});

test('a tampered payload is rejected — a link cannot be retargeted', () => {
  // The whole point: someone holding a valid link for action 7 must not
  // be able to turn it into a link for action 8.
  const token = signApproveToken({ incidentId: 42, actionId: 7 });
  const [, sig] = token.split('.');
  const forgedPayload = Buffer.from('42.8.' + (Date.now() + TTL_MS)).toString('base64url');
  assert.equal(verifyApproveToken(`${forgedPayload}.${sig}`), null);
});

test('a tampered signature is rejected', () => {
  const token = signApproveToken({ incidentId: 1, actionId: 1 });
  const [payload] = token.split('.');
  const bogus = Buffer.from(crypto.randomBytes(32)).toString('base64url');
  assert.equal(verifyApproveToken(`${payload}.${bogus}`), null);
});

test('a signature of the wrong length is rejected without throwing', () => {
  // timingSafeEqual throws on a length mismatch — the length check has
  // to come first or a short signature crashes the route.
  const [payload] = signApproveToken({ incidentId: 1, actionId: 1 }).split('.');
  assert.doesNotThrow(() => verifyApproveToken(`${payload}.AAAA`));
  assert.equal(verifyApproveToken(`${payload}.AAAA`), null);
});

test('an expired token is rejected even though its signature is valid', () => {
  const token = signApproveToken({ incidentId: 1, actionId: 1, expiresAt: Date.now() - 1000 });
  assert.equal(verifyApproveToken(token), null);
});

test('malformed input is rejected rather than throwing', () => {
  for (const bad of [null, undefined, '', 'nope', 'a.b.c', 42, {}, '....', '.']) {
    assert.doesNotThrow(() => verifyApproveToken(bad));
    assert.equal(verifyApproveToken(bad), null);
  }
});

test('a token signed with a different key never verifies', () => {
  const token = signApproveToken({ incidentId: 1, actionId: 1 });
  const { _resetForTesting } = require('../crypto/secretKey');
  const original = process.env.SENTINEL_SECRET_KEY;
  try {
    process.env.SENTINEL_SECRET_KEY = crypto.randomBytes(32).toString('hex');
    _resetForTesting();
    assert.equal(verifyApproveToken(token), null);
  } finally {
    process.env.SENTINEL_SECRET_KEY = original;
    _resetForTesting();
  }
});

test('buildApproveUrl produces a verifiable /a/<token> URL', () => {
  const url = buildApproveUrl('https://sentinel.example.com/', 9, 3);
  assert.match(url, /^https:\/\/sentinel\.example\.com\/a\//);
  const token = url.split('/a/')[1];
  assert.deepEqual(
    { incidentId: 9, actionId: 3 },
    { incidentId: verifyApproveToken(token).incidentId, actionId: verifyApproveToken(token).actionId }
  );
});

test('buildApproveUrl returns null without a base URL, rather than a broken link', () => {
  assert.equal(buildApproveUrl('', 1, 1), null);
  assert.equal(buildApproveUrl(null, 1, 1), null);
});
