'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { canTransition, isTerminal, isValidState } = require('./states');

test('the happy path is fully connected: DETECTED -> ... -> RESOLVED', () => {
  const path = ['DETECTED', 'INVESTIGATING', 'DIAGNOSED', 'AWAITING_APPROVAL', 'REMEDIATING', 'VERIFYING', 'RESOLVED'];
  for (let i = 0; i < path.length - 1; i++) {
    assert.ok(canTransition(path[i], path[i + 1]), `${path[i]} -> ${path[i + 1]} should be allowed`);
  }
});

test('VERIFYING can also end in FAILED, not just RESOLVED', () => {
  assert.ok(canTransition('VERIFYING', 'FAILED'));
});

test('REMEDIATING can fail if the tool call itself throws, without reaching VERIFYING', () => {
  assert.ok(canTransition('REMEDIATING', 'FAILED'));
});

test('INVESTIGATING can self-loop on a malformed-diagnosis retry', () => {
  assert.ok(canTransition('INVESTIGATING', 'INVESTIGATING'));
});

test('DISMISSED is reachable from every non-terminal state', () => {
  for (const state of ['DETECTED', 'INVESTIGATING', 'DIAGNOSED', 'AWAITING_APPROVAL', 'REMEDIATING', 'VERIFYING']) {
    assert.ok(canTransition(state, 'DISMISSED'), `${state} -> DISMISSED should be allowed`);
  }
});

test('terminal states have no outgoing transitions', () => {
  for (const state of ['RESOLVED', 'FAILED', 'DISMISSED']) {
    assert.equal(canTransition(state, 'INVESTIGATING'), false);
    assert.ok(isTerminal(state));
  }
});

test('an illegal skip (e.g. DETECTED straight to RESOLVED) is rejected', () => {
  assert.equal(canTransition('DETECTED', 'RESOLVED'), false);
  assert.equal(canTransition('DETECTED', 'AWAITING_APPROVAL'), false);
});

test('an unknown state is never a valid transition target or source', () => {
  assert.equal(isValidState('NOT_A_REAL_STATE'), false);
  assert.equal(canTransition('DETECTED', 'NOT_A_REAL_STATE'), false);
  assert.equal(canTransition('NOT_A_REAL_STATE', 'DETECTED'), false);
});

test('approving something not in AWAITING_APPROVAL is illegal (e.g. DIAGNOSED -> REMEDIATING)', () => {
  assert.equal(canTransition('DIAGNOSED', 'REMEDIATING'), false);
});
