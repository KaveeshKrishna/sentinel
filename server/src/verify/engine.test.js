'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { _setClientForTesting, _resetClientForTesting } = require('../agent/client');
const { verifyAction } = require('./engine');

test('succeeds immediately when the first check reports ok', async () => {
  _setClientForTesting({ verifyTool: async () => ({ ok: true, detail: { Running: true } }) });
  const result = await verifyAction('restart_container', { id: 'x' }, { maxAttempts: 3, retryDelayMs: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.checks.length, 1);
  _resetClientForTesting();
});

test('retries until ok, then stops polling', async () => {
  let calls = 0;
  _setClientForTesting({
    verifyTool: async () => {
      calls++;
      return { ok: calls >= 3, detail: { attempt: calls } };
    }
  });
  const result = await verifyAction('restart_container', { id: 'x' }, { maxAttempts: 5, retryDelayMs: 0 });
  assert.equal(result.ok, true);
  assert.equal(calls, 3);
  assert.equal(result.checks.length, 3);
  _resetClientForTesting();
});

test('returns ok:false after exhausting all attempts without ever succeeding', async () => {
  _setClientForTesting({ verifyTool: async () => ({ ok: false, detail: { Running: false } }) });
  const result = await verifyAction('restart_container', { id: 'x' }, { maxAttempts: 3, retryDelayMs: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.checks.length, 3);
  _resetClientForTesting();
});

test('a thrown error from the verify call itself is recorded as a failed check, not an uncaught rejection', async () => {
  _setClientForTesting({ verifyTool: async () => { throw new Error('agent unreachable'); } });
  const result = await verifyAction('restart_container', { id: 'x' }, { maxAttempts: 2, retryDelayMs: 0 });
  assert.equal(result.ok, false);
  assert.match(result.checks[0].detail, /agent unreachable/);
  _resetClientForTesting();
});

test('a 404 (tool has no verify check) fails fast as unverifiable instead of burning every retry', async () => {
  const { AgentError } = require('../agent/client');
  let calls = 0;
  _setClientForTesting({
    verifyTool: async () => {
      calls++;
      throw new AgentError('Tool "get_container_logs" has no verify check', 404, {});
    }
  });

  const result = await verifyAction('get_container_logs', { id: 'x' }, { maxAttempts: 5, retryDelayMs: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.unverifiable, true);
  assert.equal(calls, 1, 'a deterministic 404 must not be retried');
  _resetClientForTesting();
});
