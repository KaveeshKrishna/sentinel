'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { redact, MAX_LENGTH } = require('./redact');

test('redacts an Anthropic-style key', () => {
  assert.equal(redact('key is sk-ant-api03-abcdefgh12345678'), 'key is [REDACTED]');
});

test('redacts an OpenAI-style key', () => {
  assert.equal(redact('key is sk-abcdefghijklmnop1234'), 'key is [REDACTED]');
});

test('redacts a Bearer header value', () => {
  assert.equal(redact('Authorization: Bearer abc123def456ghi789'), 'Authorization: [REDACTED]');
});

test('redacts an api_key=... assignment', () => {
  assert.equal(redact('curl -H "api_key=abcdef123456"'), 'curl -H "[REDACTED]"');
});

test('does not redact a git commit SHA or container ID', () => {
  const sha = 'a1b2c3d4e5f6789012345678901234567890abcd';
  assert.equal(redact(`commit ${sha}`), `commit ${sha}`);
});

test('truncates strings past the max length', () => {
  const long = 'x'.repeat(MAX_LENGTH + 500);
  const out = redact(long);
  assert.ok(out.length < long.length);
  assert.ok(out.endsWith('[truncated]'));
});

test('passes through non-string input unchanged', () => {
  const obj = { a: 1 };
  assert.equal(redact(obj), obj);
});
