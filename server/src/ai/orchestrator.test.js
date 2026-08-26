'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = path.join(os.tmpdir(), `sentinel-test-orchestrator-${crypto.randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;
process.env.SENTINEL_SECRET_KEY = crypto.randomBytes(32).toString('hex');

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { migrate } = require('../db/migrate');
const { setAIConfig, clearAIConfig } = require('../settings/aiConfig');
const { _setClientForTesting, _resetClientForTesting } = require('../agent/client');
const { _setProviderForTesting, _resetProviderForTesting } = require('./provider');
const { runDiagnosis } = require('./orchestrator');
const { getDb } = require('../db/connection');

const FAKE_CATALOG = [
  { name: 'restart_container', description: 'restart', risk: 'MEDIUM_RISK', parameters: {} },
  { name: 'get_container_logs', description: 'logs', risk: 'READ_ONLY', parameters: {} }
];

before(() => migrate());
after(() => {
  _resetClientForTesting();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(DB_PATH + suffix); } catch { /* already gone */ }
  }
});

beforeEach(() => {
  clearAIConfig();
  setAIConfig({ provider: 'openai-compatible', model: 'test-model', baseUrl: '', apiKey: 'test-key' });
  _setClientForTesting({ listTools: async () => FAKE_CATALOG });
});

function fakeIncident() {
  const db = getDb();
  const now = Date.now();
  const resourceId = db.prepare(
    'INSERT INTO resources (type, external_id, name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)'
  ).run('container', 'demo-db-' + crypto.randomUUID(), 'demo-db', now, now).lastInsertRowid;
  const incidentId = db.prepare(`
    INSERT INTO incidents (resource_id, status, trigger_rule, trigger_summary, detected_at, updated_at)
    VALUES (?, 'INVESTIGATING', 'container_exit', 'exited', ?, ?)
  `).run(resourceId, now, now).lastInsertRowid;
  return { id: incidentId, resource_id: resourceId, resourceName: 'demo-db', trigger_rule: 'container_exit', trigger_summary: 'exited' };
}

test('a well-formed diagnosis on the first attempt is accepted', async () => {
  _setProviderForTesting({
    chat: async () => ({
      text: JSON.stringify({
        rootCause: 'demo-db stopped', confidence: 0.9, evidence: ['exit code 0'],
        affectedComponents: ['demo-db'], requiresApproval: true,
        recommendedActions: [{ tool: 'restart_container', params: { id: 'demo-db' }, risk: 'LOW', rationale: 'bring it back' }]
      }),
      toolCalls: [], usage: { promptTokens: 1, completionTokens: 1 }
    })
  });

  const result = await runDiagnosis(fakeIncident(), []);
  assert.equal(result.ok, true);
  assert.equal(result.diagnosis.rootCause, 'demo-db stopped');
  assert.equal(result.diagnosis.actions.length, 1);
  assert.equal(result.diagnosis.actions[0].realRisk, 'MEDIUM_RISK'); // from catalog, not the AI's claimed "LOW"
  assert.equal(result.diagnosis.actions[0].claimedRisk, 'LOW');
  _resetProviderForTesting();
});

test('an unrecognized recommended tool is silently dropped, never passed through', async () => {
  _setProviderForTesting({
    chat: async () => ({
      text: JSON.stringify({
        rootCause: 'x', confidence: 0.5, evidence: [], affectedComponents: [], requiresApproval: true,
        recommendedActions: [
          { tool: 'delete_everything', params: {}, risk: 'LOW', rationale: 'because I said so' },
          { tool: 'restart_container', params: { id: 'demo-db' }, risk: 'LOW', rationale: 'ok' }
        ]
      }),
      toolCalls: [], usage: {}
    })
  });

  const result = await runDiagnosis(fakeIncident(), []);
  assert.equal(result.ok, true);
  assert.equal(result.diagnosis.actions.length, 1);
  assert.equal(result.diagnosis.actions[0].tool, 'restart_container');
  _resetProviderForTesting();
});

test('malformed JSON on attempt 1 is retried once, then succeeds', async () => {
  let calls = 0;
  _setProviderForTesting({
    chat: async () => {
      calls++;
      if (calls === 1) return { text: 'not json at all', toolCalls: [], usage: {} };
      return {
        text: JSON.stringify({
          rootCause: 'recovered on retry', confidence: 0.7, evidence: [], affectedComponents: [],
          requiresApproval: false, recommendedActions: []
        }),
        toolCalls: [], usage: {}
      };
    }
  });

  const result = await runDiagnosis(fakeIncident(), []);
  assert.equal(calls, 2);
  assert.equal(result.ok, true);
  assert.equal(result.diagnosis.rootCause, 'recovered on retry');
  _resetProviderForTesting();
});

test('malformed JSON on both attempts falls back to ok:false with the raw text preserved', async () => {
  _setProviderForTesting({ chat: async () => ({ text: 'still not json', toolCalls: [], usage: {} }) });
  const result = await runDiagnosis(fakeIncident(), []);
  assert.equal(result.ok, false);
  assert.equal(result.rawText, 'still not json');
  _resetProviderForTesting();
});

test('a schema-invalid JSON response is retried, and failing twice falls back to ok:false', async () => {
  _setProviderForTesting({ chat: async () => ({ text: JSON.stringify({ rootCause: 'missing required fields' }), toolCalls: [], usage: {} }) });
  const result = await runDiagnosis(fakeIncident(), []);
  assert.equal(result.ok, false);
  _resetProviderForTesting();
});

test('returns ok:false immediately when no AI provider is configured', async () => {
  clearAIConfig();
  const result = await runDiagnosis(fakeIncident(), []);
  assert.equal(result.ok, false);
  assert.match(result.error, /No AI provider configured/);
});

