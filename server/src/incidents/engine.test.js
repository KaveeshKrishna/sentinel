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
  { name: 'inspect_git_status', description: 'git', risk: 'READ_ONLY', parameters: {} },
  { name: 'stop_container', description: 'stop', risk: 'MEDIUM_RISK', parameters: {} }
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

test('approve where the agent rejects the params before execution (400) reverts to AWAITING_APPROVAL, not FAILED', async () => {
  const { AgentError } = require('../agent/client');
  let verifyCalled = false;
  _setClientForTesting(fakeAgent({
    callTool: async () => { throw new AgentError('Invalid parameters', 400, { details: ['/id must be string'] }); },
    verifyTool: async () => { verifyCalled = true; return { ok: true }; }
  }));

  const incident = makeOpenIncident();
  store.updateIncidentStatus(incident.id, 'INVESTIGATING');
  store.recordDiagnosis(incident.id, { rootCause: 'x', confidence: 0.9 });
  const action = store.addAction(incident.id, { tool: 'restart_container', params: { id: 42 }, claimedRisk: 'LOW', realRisk: 'MEDIUM_RISK', rationale: 'x' });
  store.updateIncidentStatus(incident.id, 'AWAITING_APPROVAL');

  const result = await engine.approve(incident.id, { actionId: action.id });
  assert.equal(result.status, 'AWAITING_APPROVAL');
  assert.equal(result.resolved_at, null);
  assert.equal(verifyCalled, false);
  const rejected = store.getAction(action.id);
  assert.equal(rejected.status, 'rejected');
  assert.match(rejected.error, /Invalid parameters/);
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

test('approving a READ_ONLY investigation action runs it, appends evidence, and leaves the incident approvable', async () => {
  let verifyCalled = false;
  _setClientForTesting(fakeAgent({
    callTool: async () => ([{ stream: 'stdout', text: 'connection refused' }]),
    verifyTool: async () => { verifyCalled = true; return { ok: true }; }
  }));

  const incident = makeOpenIncident();
  store.updateIncidentStatus(incident.id, 'INVESTIGATING');
  store.recordDiagnosis(incident.id, { rootCause: 'cannot tell yet', confidence: 0.2 });
  const action = store.addAction(incident.id, {
    tool: 'get_container_logs', params: { id: 'demo-db', tail: 200 },
    claimedRisk: 'READ_ONLY', realRisk: 'READ_ONLY', rationale: 'need the logs'
  });
  store.updateIncidentStatus(incident.id, 'AWAITING_APPROVAL');
  const evidenceBefore = store.getEvidence(incident.id).length;

  const result = await engine.approve(incident.id, { actionId: action.id });

  // The whole point: a READ_ONLY action must never drive the remediation
  // path, which would verify a tool that has no verify check and so
  // always end FAILED.
  assert.equal(result.status, 'AWAITING_APPROVAL');
  assert.equal(verifyCalled, false);
  assert.equal(store.getAction(action.id).status, 'executed');

  const evidence = store.getEvidence(incident.id);
  assert.equal(evidence.length, evidenceBefore + 1);
  assert.equal(evidence.at(-1).source_tool, 'get_container_logs');
  assert.match(evidence.at(-1).summary, /connection refused/);
});

test('a failing READ_ONLY investigation action marks only the action, never the incident', async () => {
  _setClientForTesting(fakeAgent({
    callTool: async () => { throw new Error('docker socket unavailable'); }
  }));

  const incident = makeOpenIncident();
  store.updateIncidentStatus(incident.id, 'INVESTIGATING');
  store.recordDiagnosis(incident.id, { rootCause: 'x', confidence: 0.2 });
  const action = store.addAction(incident.id, {
    tool: 'get_container_logs', params: { id: 'demo-db' },
    claimedRisk: 'READ_ONLY', realRisk: 'READ_ONLY', rationale: 'x'
  });
  store.updateIncidentStatus(incident.id, 'AWAITING_APPROVAL');

  const result = await engine.approve(incident.id, { actionId: action.id });
  assert.equal(result.status, 'AWAITING_APPROVAL');
  assert.equal(store.getAction(action.id).status, 'failed');
});

test('rediagnose supersedes stale proposals and re-diagnoses against the accumulated evidence', async () => {
  let seenEvidenceCount = 0;
  _setClientForTesting(fakeAgent());
  _setProviderForTesting({
    chat: async ({ messages }) => {
      seenEvidenceCount = (messages[0].content.match(/^- \[/gm) || []).length;
      return {
        text: JSON.stringify({
          rootCause: 'now I can tell: demo-db is down',
          recommendedActions: [{ tool: 'restart_container', params: { id: 'demo-db' } }]
        }),
        usage: {}
      };
    }
  });

  const incident = makeOpenIncident();
  store.updateIncidentStatus(incident.id, 'INVESTIGATING');
  store.recordDiagnosis(incident.id, { rootCause: 'inconclusive', confidence: null });
  const stale = store.addAction(incident.id, {
    tool: 'get_container_logs', params: { id: 'demo-db' },
    claimedRisk: 'READ_ONLY', realRisk: 'READ_ONLY', rationale: 'x'
  });
  store.updateIncidentStatus(incident.id, 'AWAITING_APPROVAL');
  store.addEvidence(incident.id, [{ resourceId: null, sourceTool: 'get_container_logs', summary: 'connection refused', data: null }]);

  const result = await engine.rediagnose(incident.id);

  assert.equal(result.status, 'AWAITING_APPROVAL');
  assert.equal(result.root_cause, 'now I can tell: demo-db is down');
  assert.equal(store.getAction(stale.id).status, 'superseded');
  assert.ok(seenEvidenceCount >= 1, 'existing evidence should be replayed into the new prompt');

  const proposals = store.getActions(incident.id).filter(a => a.status === 'proposed');
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].tool_name, 'restart_container');
});

test('a diagnosis for an opted-in resource auto-remediates without a human, and verifies', async () => {
  const { setAutoRemediateList } = require('../settings/autoRemediate');
  let called = null;
  _setClientForTesting(fakeAgent({
    callTool: async (name) => { called = name; return { status: 'restarted' }; },
    verifyTool: async () => ({ ok: true })
  }));
  _setProviderForTesting({
    chat: async () => ({
      text: JSON.stringify({
        rootCause: 'caddy is down',
        recommendedActions: [{ tool: 'restart_container', params: { id: 'demo-db' } }]
      }), usage: {}
    })
  });

  const resource = upsertResource({ type: 'container', externalId: 'auto-' + crypto.randomUUID(), name: 'demo-db' });
  setAutoRemediateList([`container:${resource.external_id}`]);
  const incident = store.createIncident({ resourceId: resource.id, triggerRule: 'container_exit', triggerSummary: 'exited' });

  const result = await engine.startInvestigation(incident.id);

  assert.equal(called, 'restart_container');
  assert.equal(result.status, 'RESOLVED');
  const action = store.getActions(incident.id)[0];
  assert.equal(action.status, 'executed');
  assert.equal(action.approved_by, null, 'machine-approved actions must be distinguishable in the audit trail');
  setAutoRemediateList([]);
});

test('a diagnosis for a resource that is NOT opted in still waits for a human', async () => {
  // startInvestigation legitimately makes READ_ONLY evidence-gathering
  // calls first, so assert on the mutating tool specifically.
  const calls = [];
  _setClientForTesting(fakeAgent({ callTool: async (name) => { calls.push(name); return {}; } }));
  _setProviderForTesting({
    chat: async () => ({
      text: JSON.stringify({
        rootCause: 'x',
        recommendedActions: [{ tool: 'restart_container', params: { id: 'demo-db' } }]
      }), usage: {}
    })
  });

  const incident = makeOpenIncident();
  const result = await engine.startInvestigation(incident.id);

  assert.equal(result.status, 'AWAITING_APPROVAL');
  assert.equal(calls.includes('restart_container'), false, 'the remediation must not have executed');
});

test('auto-remediation never fires for a non-restorative tool, even on an opted-in resource', async () => {
  const { setAutoRemediateList } = require('../settings/autoRemediate');
  const calls = [];
  _setClientForTesting(fakeAgent({ callTool: async (name) => { calls.push(name); return {}; } }));
  _setProviderForTesting({
    chat: async () => ({
      text: JSON.stringify({
        rootCause: 'runaway container',
        recommendedActions: [{ tool: 'stop_container', params: { id: 'demo-db' } }]
      }), usage: {}
    })
  });

  const resource = upsertResource({ type: 'container', externalId: 'auto2-' + crypto.randomUUID(), name: 'demo-db' });
  setAutoRemediateList([`container:${resource.external_id}`]);
  const incident = store.createIncident({ resourceId: resource.id, triggerRule: 'container_exit', triggerSummary: 'exited' });

  const result = await engine.startInvestigation(incident.id);

  // The AI's non-restorative proposal is never auto-run. (The trigger is
  // container_exit and the resource is opted in, so the canonical
  // restart_container fallback DOES fire — that's intended: a restart is
  // safe, a stop is not.)
  assert.equal(calls.includes('stop_container'), false, 'a stop is not a repair — must never auto-run');
  setAutoRemediateList([]);
});

test('maybeAutoRemediate re-checks existing proposed actions when called with no explicit list', async () => {
  const { setAutoRemediateList } = require('../settings/autoRemediate');
  let called = null;
  _setClientForTesting(fakeAgent({
    callTool: async (name) => { called = name; return { ok: true }; },
    verifyTool: async () => ({ ok: true })
  }));

  // An incident already parked at AWAITING_APPROVAL with a restorative
  // action proposed — as if diagnosed before the operator opted in.
  const resource = upsertResource({ type: 'service', externalId: 'late-optin-' + crypto.randomUUID(), name: 'caddy' });
  const incident = store.createIncident({ resourceId: resource.id, triggerRule: 'service_inactive', triggerSummary: 'down' });
  store.updateIncidentStatus(incident.id, 'INVESTIGATING');
  store.recordDiagnosis(incident.id, { rootCause: 'caddy down', confidence: 0.9 });
  store.addAction(incident.id, { tool: 'restart_service', params: { service: 'caddy' }, claimedRisk: 'LOW', realRisk: 'MEDIUM_RISK', rationale: 'x' });
  store.updateIncidentStatus(incident.id, 'AWAITING_APPROVAL');

  // Not opted in yet -> no-op.
  await engine.maybeAutoRemediate(incident.id);
  assert.equal(called, null);
  assert.equal(store.getIncident(incident.id).status, 'AWAITING_APPROVAL');

  // Opt in, re-check -> fires.
  setAutoRemediateList([`service:${resource.external_id}`]);
  const result = await engine.maybeAutoRemediate(incident.id);
  assert.equal(called, 'restart_service');
  assert.equal(result.status, 'RESOLVED');
  setAutoRemediateList([]);
});

test('an opted-in resource auto-remediates via the canonical restart even when the diagnosis proposes only READ_ONLY actions', async () => {
  // The real failure the user hit: a weak model diagnosed `caddy` down
  // but recommended only get_service_logs / get_service_status.
  const { setAutoRemediateList } = require('../settings/autoRemediate');
  const calls = [];
  _setClientForTesting({
    listTools: async () => ([
      { name: 'restart_service', description: 'restart', risk: 'MEDIUM_RISK', parameters: {} },
      { name: 'get_service_logs', description: 'logs', risk: 'READ_ONLY', parameters: {} }
    ]),
    callTool: async (name) => { calls.push(name); return { ok: true }; },
    verifyTool: async () => ({ ok: true })
  });
  _setProviderForTesting({
    chat: async () => ({
      text: JSON.stringify({
        rootCause: 'caddy is inactive; need logs to say why',
        recommendedActions: [
          { tool: 'get_service_logs', params: { service: 'caddy' } }
        ]
      }), usage: {}
    })
  });

  const resource = upsertResource({ type: 'service', externalId: 'caddy-canon-' + crypto.randomUUID(), name: 'caddy' });
  setAutoRemediateList([`service:${resource.external_id}`]);
  const incident = store.createIncident({ resourceId: resource.id, triggerRule: 'service_inactive', triggerSummary: 'caddy is failed' });

  const result = await engine.startInvestigation(incident.id);

  assert.equal(calls.includes('restart_service'), true, 'the canonical restart must have run');
  assert.equal(result.status, 'RESOLVED');
  const restartAction = store.getActions(incident.id).find(a => a.tool_name === 'restart_service');
  assert.ok(restartAction);
  assert.equal(restartAction.approved_by, null);
  assert.match(restartAction.rationale, /Canonical remediation/);
  setAutoRemediateList([]);
});

test('the canonical restart is NOT used for a resource that is not opted in', async () => {
  const calls = [];
  _setClientForTesting({
    listTools: async () => ([{ name: 'restart_service', description: 'r', risk: 'MEDIUM_RISK', parameters: {} }]),
    callTool: async (name) => { calls.push(name); return {}; },
    verifyTool: async () => ({ ok: true })
  });
  _setProviderForTesting({
    chat: async () => ({ text: JSON.stringify({ rootCause: 'down', recommendedActions: [] }), usage: {} })
  });

  const resource = upsertResource({ type: 'service', externalId: 'nocanon-' + crypto.randomUUID(), name: 'caddy' });
  const incident = store.createIncident({ resourceId: resource.id, triggerRule: 'service_inactive', triggerSummary: 'down' });

  const result = await engine.startInvestigation(incident.id);
  assert.equal(calls.includes('restart_service'), false);
  assert.equal(result.status, 'DIAGNOSED');
});

// ── applyRunbook (Feature 2) ──────────────────────────────────────────────

test('applyRunbook proposes the matched tool and leaves the incident at AWAITING_APPROVAL for a non-opted-in resource', async () => {
  _setClientForTesting(fakeAgent());
  const resource = upsertResource({ type: 'container', externalId: 'rb-engine-' + crypto.randomUUID(), name: 'x' });
  const incident = store.createIncident({ resourceId: resource.id, triggerRule: 'container_exit', triggerSummary: 'exited' });

  const match = { tool: 'restart_container', paramKey: 'id', successes: 3, failures: 0, total: 3, avgRecoveryMs: 4200 };
  const updated = await engine.applyRunbook(incident, resource, match);

  assert.equal(updated.status, 'AWAITING_APPROVAL');
  assert.equal(updated.diagnosis.source, 'runbook');
  assert.equal(updated.diagnosis.successes, 3);
  assert.match(updated.diagnosis.rootCause, /3\/3/);

  const action = store.getActions(incident.id)[0];
  assert.equal(action.tool_name, 'restart_container');
  assert.deepEqual(action.params, { id: resource.external_id });
  assert.equal(action.real_risk, 'MEDIUM_RISK'); // resolved from the fake catalog, not trusted blindly
});

test('applyRunbook for an opted-in resource auto-remediates through the normal gates, with zero AI calls', async () => {
  // Deliberately no AI provider configured for this one (beforeEach sets
  // one) — otherwise a RESOLVED outcome fires the unrelated
  // post-incident-report generation, a legitimate separate AI call this
  // test isn't about, and it would pollute the chatCalls count below.
  clearAIConfig();
  const { setAutoRemediateList } = require('../settings/autoRemediate');
  let calls = [];
  _setClientForTesting({
    listTools: async () => FAKE_CATALOG,
    callTool: async (name) => { calls.push(name); return {}; },
    verifyTool: async () => ({ ok: true })
  });
  let chatCalls = 0;
  _setProviderForTesting({ chat: async () => { chatCalls++; return { text: '{}', usage: {} }; } });

  const resource = upsertResource({ type: 'container', externalId: 'rb-auto-' + crypto.randomUUID(), name: 'x' });
  setAutoRemediateList([`container:${resource.external_id}`]);
  const incident = store.createIncident({ resourceId: resource.id, triggerRule: 'container_exit', triggerSummary: 'exited' });

  const match = { tool: 'restart_container', paramKey: 'id', successes: 2, failures: 0, total: 2, avgRecoveryMs: null };
  const updated = await engine.applyRunbook(incident, resource, match);

  assert.equal(calls.includes('restart_container'), true, 'auto-remediation ran the runbook-proposed action through the exact same path as an AI proposal');
  assert.equal(chatCalls, 0, 'a runbook match never spends a provider request, opted-in or not');
  assert.ok(['VERIFYING', 'RESOLVED', 'FAILED'].includes(updated.status));

  setAutoRemediateList([]);
});

test("applyRunbook falls back to a full AI diagnosis if the runbook's tool is no longer in the agent's catalog", async () => {
  _setClientForTesting({
    listTools: async () => ([{ name: 'get_container_status', description: 'x', risk: 'READ_ONLY', parameters: {} }]),
    callTool: async () => ({ status: 'ok' }),
    verifyTool: async () => ({ ok: true })
  });
  let chatCalls = 0;
  _setProviderForTesting({
    chat: async () => {
      chatCalls++;
      return { text: JSON.stringify({ rootCause: 'diagnosed for real', recommendedActions: [] }), usage: {} };
    }
  });

  const resource = upsertResource({ type: 'container', externalId: 'rb-gone-' + crypto.randomUUID(), name: 'x' });
  const incident = store.createIncident({ resourceId: resource.id, triggerRule: 'container_exit', triggerSummary: 'exited' });

  // Names a tool no longer registered — simulates a runbook remembering a
  // tool that has since been renamed or removed.
  const match = { tool: 'restart_container_v1_removed', paramKey: 'id', successes: 5, failures: 0, total: 5, avgRecoveryMs: null };
  const updated = await engine.applyRunbook(incident, resource, match);

  assert.equal(chatCalls, 1, 'falls through to a real diagnosis rather than proposing an unregistered tool');
  assert.equal(updated.root_cause, 'diagnosed for real');
  assert.notEqual(updated.diagnosis?.source, 'runbook');
});

// ── forceAiDiagnosis ("Ask AI instead") ──────────────────────────────────

test('forceAiDiagnosis gathers fresh evidence and re-diagnoses a runbook-only incident (which has none)', async () => {
  let statusCalls = 0;
  _setClientForTesting({
    listTools: async () => FAKE_CATALOG,
    callTool: async (name) => { if (name === 'get_container_status') statusCalls++; return { status: 'ok' }; },
    verifyTool: async () => ({ ok: true })
  });
  _setProviderForTesting({
    chat: async () => ({
      text: JSON.stringify({ rootCause: 'the AI\'s own answer', recommendedActions: [] }), usage: {}
    })
  });

  const resource = upsertResource({ type: 'container', externalId: 'force-ai-' + crypto.randomUUID(), name: 'x' });
  const incident = store.createIncident({ resourceId: resource.id, triggerRule: 'container_exit', triggerSummary: 'exited' });
  const match = { tool: 'restart_container', paramKey: 'id', successes: 4, failures: 0, total: 4, avgRecoveryMs: null };
  const runbookResult = await engine.applyRunbook(incident, resource, match);
  assert.equal(store.getEvidence(incident.id).length, 0, 'a runbook match gathers no evidence, by design');
  assert.equal(runbookResult.diagnosis.source, 'runbook');

  const forced = await engine.forceAiDiagnosis(incident.id);

  assert.equal(forced.root_cause, "the AI's own answer");
  assert.notEqual(forced.diagnosis?.source, 'runbook');
  assert.ok(statusCalls > 0, 'evidence was actually gathered this time, unlike the runbook path');
  assert.equal(store.getActions(incident.id).find(a => a.tool_name === 'restart_container').status, 'superseded');
});

test('forceAiDiagnosis works from AWAITING_APPROVAL too (not only DIAGNOSED)', async () => {
  const { setAutoRemediateList } = require('../settings/autoRemediate');
  _setClientForTesting({
    listTools: async () => FAKE_CATALOG,
    callTool: async () => ({ status: 'ok' }),
    verifyTool: async () => ({ ok: true })
  });
  _setProviderForTesting({
    chat: async () => ({ text: JSON.stringify({ rootCause: 'fresh answer', recommendedActions: [] }), usage: {} })
  });

  const resource = upsertResource({ type: 'container', externalId: 'force-ai-awaiting-' + crypto.randomUUID(), name: 'x' });
  const incident = store.createIncident({ resourceId: resource.id, triggerRule: 'container_exit', triggerSummary: 'exited' });
  // Not opted in, so applyRunbook leaves this at AWAITING_APPROVAL.
  const match = { tool: 'restart_container', paramKey: 'id', successes: 2, failures: 0, total: 2, avgRecoveryMs: null };
  const runbookResult = await engine.applyRunbook(incident, resource, match);
  assert.equal(runbookResult.status, 'AWAITING_APPROVAL');

  const forced = await engine.forceAiDiagnosis(incident.id);
  assert.equal(forced.root_cause, 'fresh answer');
  setAutoRemediateList([]);
});
