'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = path.join(os.tmpdir(), `sentinel-test-incidentengine-${crypto.randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;
process.env.SENTINEL_SECRET_KEY = crypto.randomBytes(32).toString('hex');

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { migrate } = require('../db/migrate');
const { getDb } = require('../db/connection');
const { upsertResource } = require('../graph/resources');
const { setAIConfig, clearAIConfig } = require('../settings/aiConfig');
const { _setClientForTesting, _resetClientForTesting } = require('../agent/client');
const { _setProviderForTesting, _resetProviderForTesting } = require('../ai/provider');
const store = require('./store');
const engine = require('./engine');

const FAKE_CATALOG = [
  { name: 'restart_container', description: 'restart', risk: 'MEDIUM_RISK', parameters: {} },
  { name: 'get_container_status', description: 'status', risk: 'READ_ONLY', parameters: {} },
  { name: 'get_container_logs', description: 'logs', risk: 'READ_ONLY', parameters: {} },
  { name: 'inspect_git_status', description: 'git', risk: 'READ_ONLY', parameters: {} }
];

before(() => migrate());
after(() => {
  _resetClientForTesting();
  _resetProviderForTesting();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(DB_PATH + suffix); } catch { /* already gone */ }
  }
});

beforeEach(() => {
  clearAIConfig();
  setAIConfig({ provider: 'openai-compatible', model: 'test-model', baseUrl: '', apiKey: 'test-key' });
});

function makeUser() {
  return getDb().prepare(`
    INSERT INTO users (username, password_hash, created_at) VALUES (?, 'x', ?)
  `).run('user-' + crypto.randomUUID(), Date.now()).lastInsertRowid;
}

function makeOpenIncident() {
  const resource = upsertResource({ type: 'container', externalId: 'engine-' + crypto.randomUUID(), name: 'demo-db' });
  return store.createIncident({ resourceId: resource.id, triggerRule: 'container_exit', triggerSummary: 'exited' });
}

function fakeAgent({ callTool, verifyTool } = {}) {
  return {
    listTools: async () => FAKE_CATALOG,
    callTool: callTool || (async () => ({})),
    verifyTool: verifyTool || (async () => ({ ok: true }))
  };
}

test('startInvestigation with one recommended action moves to AWAITING_APPROVAL', async () => {
  _setClientForTesting(fakeAgent({ callTool: async () => ({ status: 'ok' }) }));
  _setProviderForTesting({
    chat: async () => ({
      text: JSON.stringify({
        rootCause: 'demo-db exited', confidence: 0.9, evidence: ['exit'], affectedComponents: ['demo-db'],
        requiresApproval: true,
        recommendedActions: [{ tool: 'restart_container', params: { id: 'demo-db' }, risk: 'LOW', rationale: 'restart it' }]
      }),
      toolCalls: [], usage: {}
    })
  });

  const incident = makeOpenIncident();
  const updated = await engine.startInvestigation(incident.id);
  assert.equal(updated.status, 'AWAITING_APPROVAL');
  assert.equal(updated.root_cause, 'demo-db exited');

  const actions = store.getActions(incident.id);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].status, 'proposed');
  assert.equal(actions[0].real_risk, 'MEDIUM_RISK');
});

test('startInvestigation with zero recommended actions stays at DIAGNOSED', async () => {
  _setClientForTesting(fakeAgent());
  _setProviderForTesting({
    chat: async () => ({
      text: JSON.stringify({
        rootCause: 'transient blip, nothing to do', confidence: 0.4, evidence: [], affectedComponents: [],
        requiresApproval: false, recommendedActions: []
      }),
      toolCalls: [], usage: {}
    })
  });

  const incident = makeOpenIncident();
  const updated = await engine.startInvestigation(incident.id);
  assert.equal(updated.status, 'DIAGNOSED');
});

test('startInvestigation with an unparseable AI response stays at INVESTIGATING with raw text preserved', async () => {
  _setClientForTesting(fakeAgent());
  _setProviderForTesting({ chat: async () => ({ text: 'not json', toolCalls: [], usage: {} }) });

  const incident = makeOpenIncident();
  const updated = await engine.startInvestigation(incident.id);
  assert.equal(updated.status, 'INVESTIGATING');
  assert.equal(updated.diagnosis_raw_text, 'not json');
});

test('approve executes the action then verifies successfully -> RESOLVED', async () => {
  _setClientForTesting(fakeAgent({
    callTool: async () => ({ status: 'restarted' }),
    verifyTool: async () => ({ ok: true, detail: { Running: true } })
  }));

  const incident = makeOpenIncident();
  store.updateIncidentStatus(incident.id, 'INVESTIGATING');
  store.recordDiagnosis(incident.id, { rootCause: 'x', confidence: 0.9 });
  const action = store.addAction(incident.id, { tool: 'restart_container', params: { id: 'demo-db' }, claimedRisk: 'LOW', realRisk: 'MEDIUM_RISK', rationale: 'x' });
  store.updateIncidentStatus(incident.id, 'AWAITING_APPROVAL');

  const userId = makeUser();
  const result = await engine.approve(incident.id, { actionId: action.id, userId });
  assert.equal(result.status, 'RESOLVED');
  assert.ok(result.resolved_at);

  const updatedAction = store.getAction(action.id);
  assert.equal(updatedAction.status, 'executed');
  assert.equal(updatedAction.approved_by, userId);
});

test('approve where the tool call itself throws goes straight to FAILED without ever verifying', async () => {
  let verifyCalled = false;
  _setClientForTesting(fakeAgent({
    callTool: async () => { throw new Error('container not found'); },
    verifyTool: async () => { verifyCalled = true; return { ok: true }; }
  }));

  const incident = makeOpenIncident();
  store.updateIncidentStatus(incident.id, 'INVESTIGATING');
  store.recordDiagnosis(incident.id, { rootCause: 'x', confidence: 0.9 });
  const action = store.addAction(incident.id, { tool: 'restart_container', params: { id: 'demo-db' }, claimedRisk: 'LOW', realRisk: 'MEDIUM_RISK', rationale: 'x' });
  store.updateIncidentStatus(incident.id, 'AWAITING_APPROVAL');

  const result = await engine.approve(incident.id, { actionId: action.id });
  assert.equal(result.status, 'FAILED');
  assert.equal(verifyCalled, false);
  assert.equal(store.getAction(action.id).status, 'failed');
});

test('approve where the action executes but verification never converges -> FAILED, not RESOLVED', async () => {
  _setClientForTesting(fakeAgent({
    callTool: async () => ({ status: 'restarted' }),
    verifyTool: async () => ({ ok: false, detail: { Running: false } })
  }));

  const incident = makeOpenIncident();
  store.updateIncidentStatus(incident.id, 'INVESTIGATING');
  store.recordDiagnosis(incident.id, { rootCause: 'x', confidence: 0.9 });
  const action = store.addAction(incident.id, { tool: 'restart_container', params: { id: 'demo-db' }, claimedRisk: 'LOW', realRisk: 'MEDIUM_RISK', rationale: 'x' });
  store.updateIncidentStatus(incident.id, 'AWAITING_APPROVAL');

  const result = await engine.approve(incident.id, { actionId: action.id, userId: null }, { maxAttempts: 1, retryDelayMs: 0 });
  assert.equal(result.status, 'FAILED');
  // the action itself DID execute — that's a distinct fact from the incident's FAILED verification
  assert.equal(store.getAction(action.id).status, 'executed');
});

test('dismiss moves an incident to DISMISSED from a non-terminal state', () => {
  const incident = makeOpenIncident();
  const result = engine.dismiss(incident.id);
  assert.equal(result.status, 'DISMISSED');
  assert.ok(result.resolved_at);
});
