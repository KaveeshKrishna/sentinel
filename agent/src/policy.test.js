'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isAuthorized, DEFAULT_AUTO_APPROVE } = require('./policy');

test('READ_ONLY auto-approves without an approval flag', () => {
  assert.equal(isAuthorized('READ_ONLY', false), true);
});

test('LOW_RISK and MEDIUM_RISK require explicit approval by default', () => {
  assert.equal(isAuthorized('LOW_RISK', false), false);
  assert.equal(isAuthorized('LOW_RISK', true), true);
  assert.equal(isAuthorized('MEDIUM_RISK', false), false);
  assert.equal(isAuthorized('MEDIUM_RISK', true), true);
});

test('HIGH_RISK requires explicit approval', () => {
  assert.equal(isAuthorized('HIGH_RISK', false), false);
  assert.equal(isAuthorized('HIGH_RISK', true), true);
});

test('DESTRUCTIVE never auto-approves even if policy config says it should', () => {
  const misconfigured = { ...DEFAULT_AUTO_APPROVE, DESTRUCTIVE: true };
  assert.equal(isAuthorized('DESTRUCTIVE', false, misconfigured), false);
  assert.equal(isAuthorized('DESTRUCTIVE', true, misconfigured), true);
});

test('an unknown risk level is rejected regardless of approval', () => {
  assert.equal(isAuthorized('NOT_A_REAL_RISK', true), false);
});
