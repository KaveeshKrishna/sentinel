'use strict';

// broadcaster.js pulls in auth/middleware.js, which exits the process if
// JWT_SECRET isn't set at require time — set a throwaway one before the
// require below (isAllowedOrigin itself never touches auth or the DB).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-not-used-in-production';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isAllowedOrigin } = require('./broadcaster');

test('allows a same-site handshake (Origin host matches Host)', () => {
  assert.equal(isAllowedOrigin({
    headers: { origin: 'https://sentinel.example.com', host: 'sentinel.example.com' }
  }), true);
});

test('allows a handshake with no Origin header (non-browser clients)', () => {
  assert.equal(isAllowedOrigin({ headers: { host: 'sentinel.example.com' } }), true);
});

test('rejects a cross-site Origin', () => {
  assert.equal(isAllowedOrigin({
    headers: { origin: 'https://evil.example.com', host: 'sentinel.example.com' }
  }), false);
});

test('rejects a mismatched port, since that is a different origin', () => {
  assert.equal(isAllowedOrigin({
    headers: { origin: 'https://sentinel.example.com:8443', host: 'sentinel.example.com' }
  }), false);
});

test('rejects a malformed Origin header rather than throwing', () => {
  assert.equal(isAllowedOrigin({
    headers: { origin: 'not-a-url', host: 'sentinel.example.com' }
  }), false);
});
