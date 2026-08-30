'use strict';

process.env.SENTINEL_AGENT_TOKEN = 'test-token-123';

const test = require('node:test');
const assert = require('node:assert/strict');
const { authMiddleware, timingSafeEqual } = require('./auth');

function mockReqRes(headers) {
  const req = { headers };
  const result = { statusCode: null, body: null };
  const res = {
    status(code) { result.statusCode = code; return this; },
    json(payload) { result.body = payload; return this; }
  };
  return { req, res, result };
}

test('rejects a request with no Authorization header', () => {
  const { req, res, result } = mockReqRes({});
  let nextCalled = false;
  authMiddleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(result.statusCode, 401);
});

test('rejects a request with the wrong token', () => {
  const { req, res, result } = mockReqRes({ authorization: 'Bearer wrong-token' });
  let nextCalled = false;
  authMiddleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(result.statusCode, 401);
});

test('accepts a request with the correct token', () => {
  const { req, res } = mockReqRes({ authorization: 'Bearer test-token-123' });
  let nextCalled = false;
  authMiddleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test('timingSafeEqual compares equal and unequal strings correctly', () => {
  assert.equal(timingSafeEqual('abc', 'abc'), true);
  assert.equal(timingSafeEqual('abc', 'abd'), false);
  assert.equal(timingSafeEqual('abc', 'abcd'), false);
});
