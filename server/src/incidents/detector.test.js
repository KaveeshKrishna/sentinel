'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = path.join(os.tmpdir(), `sentinel-test-detector-${crypto.randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;
process.env.SENTINEL_SECRET_KEY = crypto.randomBytes(32).toString('hex');

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { migrate } = require('../db/migrate');
const { getDb } = require('../db/connection');
const { registerRelationship } = require('../graph/relationships');
const { getResourceByRef, upsertResource, getResource } = require('../graph/resources');
const { _setClientForTesting, _resetClientForTesting } = require('../agent/client');
const { setAIConfig, clearAIConfig } = require('../settings/aiConfig');
const { _setProviderForTesting, _resetProviderForTesting } = require('../ai/provider');
const store = require('./store');
const detector = require('./detector');

function flatAgent(overrides = {}) {
  return {
    listTools: async () => [],
    callTool: async (name, params) => {
      if (overrides[name]) return overrides[name](params);
      if (name === 'get_docker_events') return [];
      if (name === 'list_containers') return [];
      if (name === 'list_services') return [];
      return {};
    },
    verifyTool: async () => ({ ok: true })
  };
}

before(() => migrate());
beforeEach(() => detector._resetForTesting());
after(async () => {
  _resetClientForTesting();
  _resetProviderForTesting();
  clearAIConfig();
  await new Promise(r => setTimeout(r, 50)); // let any fire-and-forget investigations settle
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(DB_PATH + suffix); } catch { /* already gone */ }
  }
});

/**
 * Put a resource on the auto-remediation opt-in list — which is also
 * what gates unattended diagnosis (detector.js's shouldAutoDiagnose),
 * so any test about the automatic path needs it.
 */
function optIn(resource) {
  const { getAutoRemediateList, setAutoRemediateList, resourceKey } = require('../settings/autoRemediate');
  const key = resourceKey(resource.type, resource.external_id);
  if (!getAutoRemediateList().includes(key)) {
    setAutoRemediateList([...getAutoRemediateList(), key]);
  }
}

test('a container dying with a non-zero exit code raises an incident', async () => {
  const name = 'app-' + crypto.randomUUID();
  const agent = flatAgent({ get_docker_events: () => [{ type: 'die', name, exitCode: '1', ts: Date.now() }] });
  _setClientForTesting(agent);
  await detector.checkContainerEvents(agent);
  const resource = getResourceByRef('container', name);
  assert.ok(store.findOpenIncidentForResource(resource.id));
});

test('a clean exit (code 0) with no dependents does NOT raise an incident', async () => {
  const name = 'clean-' + crypto.randomUUID();
  const agent = flatAgent({ get_docker_events: () => [{ type: 'die', name, exitCode: '0', ts: Date.now() }] });
  _setClientForTesting(agent);
  await detector.checkContainerEvents(agent);
  const resource = getResourceByRef('container', name);
  assert.equal(store.findOpenIncidentForResource(resource.id), null);
});

test('a clean exit (code 0) WITH a registered dependent DOES raise an incident (demo scenario)', async () => {
  const dbName = 'demo-db-' + crypto.randomUUID();
  const apiName = 'demo-api-' + crypto.randomUUID();
  registerRelationship(
    { type: 'container', externalId: apiName, name: apiName },
    { type: 'container', externalId: dbName, name: dbName },
    'depends_on'
  );
  const agent = flatAgent({ get_docker_events: () => [{ type: 'die', name: dbName, exitCode: '0', ts: Date.now() }] });
  _setClientForTesting(agent);
  await detector.checkContainerEvents(agent);
  const resource = getResourceByRef('container', dbName);
  assert.ok(store.findOpenIncidentForResource(resource.id));
});

test('an OOM event always raises an incident', async () => {
  const name = 'oomed-' + crypto.randomUUID();
  const agent = flatAgent({ get_docker_events: () => [{ type: 'oom', name, ts: Date.now() }] });
  _setClientForTesting(agent);
  await detector.checkContainerEvents(agent);
  const resource = getResourceByRef('container', name);
  assert.ok(store.findOpenIncidentForResource(resource.id));
});

test('container_unhealthy requires 2 consecutive polls before firing', async () => {
  const name = 'flaky-' + crypto.randomUUID();
  const agent = flatAgent({ list_containers: () => [{ name, health: 'unhealthy' }] });
  _setClientForTesting(agent);

  await detector.checkContainerHealth(agent);
  assert.equal(store.findOpenIncidentForResource(getResourceByRef('container', name)?.id || -1), null);

  await detector.checkContainerHealth(agent);
  const resource = getResourceByRef('container', name);
  assert.ok(store.findOpenIncidentForResource(resource.id));
});

test('container_unhealthy streak resets once the container reports healthy again', async () => {
  const name = 'recovers-' + crypto.randomUUID();
  let health = 'unhealthy';
  const agent = { callTool: async (n) => (n === 'list_containers' ? [{ name, health }] : []) };
  _setClientForTesting(agent);

  await detector.checkContainerHealth(agent); // streak 1
  health = 'healthy';
  await detector.checkContainerHealth(agent); // resets
  health = 'unhealthy';
  await detector.checkContainerHealth(agent); // streak 1 again — should not fire yet

  const resource = getResourceByRef('container', name);
  assert.equal(resource && store.findOpenIncidentForResource(resource.id), null);
});

test('an inactive managed service raises an incident immediately (no streak needed)', async () => {
  const name = 'svc-' + crypto.randomUUID();
  const agent = flatAgent({ list_services: () => [{ name, status: 'failed' }] });
  _setClientForTesting(agent);
  await detector.checkServices(agent);
  const resource = getResourceByRef('service', name);
  assert.ok(store.findOpenIncidentForResource(resource.id));
});

test('sustained CPU over threshold for 3 consecutive polls raises an incident', async () => {
  const agent = flatAgent({
    get_system_metrics: () => ({ cpu: { usage: 95 }, memory: { usedPercent: 10 } }),
    inspect_disk: () => ({ usage: { usedPercent: 10 } })
  });
  _setClientForTesting(agent);
  await detector.checkSystemMetrics(agent);
  await detector.checkSystemMetrics(agent);
  let resource = getResourceByRef('host', 'localhost');
  assert.equal(resource && store.findOpenIncidentForResource(resource.id), null);

  await detector.checkSystemMetrics(agent);
  resource = getResourceByRef('host', 'localhost');
  assert.ok(store.findOpenIncidentForResource(resource.id));
});

test('disk usage over threshold raises an incident with no sustain window', async () => {
  const db = getDb();
  db.prepare("DELETE FROM incidents").run(); // isolate from the CPU test's host incident above
  const agent = flatAgent({
    get_system_metrics: () => ({ cpu: { usage: 5 }, memory: { usedPercent: 5 } }),
    inspect_disk: () => ({ usage: { usedPercent: 95 } })
  });
  _setClientForTesting(agent);
  await detector.checkSystemMetrics(agent);
  const resource = getResourceByRef('host', 'localhost');
  assert.ok(store.findOpenIncidentForResource(resource.id));
});

test('raising the same rule twice for an already-open incident does not create a duplicate', async () => {
  const name = 'dup-' + crypto.randomUUID();
  const agent = flatAgent({ list_services: () => [{ name, status: 'failed' }] });
  _setClientForTesting(agent);
  await detector.checkServices(agent);
  await detector.checkServices(agent);
  const resource = getResourceByRef('service', name);
  const count = getDb().prepare('SELECT COUNT(*) c FROM incidents WHERE resource_id = ?').get(resource.id).c;
  assert.equal(count, 1);
});

test('a cooldown blocks a new incident right after resolution, but allows one once it has elapsed', async () => {
  const name = 'cooled-' + crypto.randomUUID();
  const agent = flatAgent({ list_services: () => [{ name, status: 'failed' }] });
  _setClientForTesting(agent);

  await detector.checkServices(agent);
  const resource = getResourceByRef('service', name);
  const incident = store.findOpenIncidentForResource(resource.id);
  store.updateIncidentStatus(incident.id, 'INVESTIGATING');
  store.recordResolution(incident.id, 'FAILED'); // resolved_at = now

  await detector.checkServices(agent); // still within cooldown
  const countWithinCooldown = getDb().prepare('SELECT COUNT(*) c FROM incidents WHERE resource_id = ?').get(resource.id).c;
  assert.equal(countWithinCooldown, 1);

  // Backdate the resolution past the cooldown window and try again.
  getDb().prepare('UPDATE incidents SET resolved_at = ? WHERE id = ?').run(Date.now() - 120000, incident.id);
  await detector.checkServices(agent);
  const countAfterCooldown = getDb().prepare('SELECT COUNT(*) c FROM incidents WHERE resource_id = ?').get(resource.id).c;
  assert.equal(countAfterCooldown, 2);
});

/** An incident already at INVESTIGATING with no diagnosis yet — the "detected before an AI provider was configured" state. */
function makeStuckIncident(ageMs, { autoDiagnose = true } = {}) {
  const resource = upsertResource({ type: 'container', externalId: 'stuck-' + crypto.randomUUID(), name: 'stuck' });
  // Unattended re-diagnosis is gated on the auto-remediation opt-in
  // (detector.js's shouldAutoDiagnose). These tests are about the
  // retry/backoff policy, so opt in by default; pass false to exercise
  // the gate itself.
  if (autoDiagnose) optIn(resource);
  const incident = store.createIncident({ resourceId: resource.id, triggerRule: 'container_unhealthy', triggerSummary: 'stuck' });
  store.updateIncidentStatus(incident.id, 'INVESTIGATING');
  getDb().prepare('UPDATE incidents SET updated_at = ? WHERE id = ?').run(Date.now() - ageMs, incident.id);
  return incident;
}

test('checkStuckInvestigations is a no-op when no AI provider is configured', async () => {
  clearAIConfig();
  _setClientForTesting(flatAgent());
  const incident = makeStuckIncident(60000);
  await detector.checkStuckInvestigations();
  assert.equal(store.getIncident(incident.id).status, 'INVESTIGATING');
  assert.equal(store.getIncident(incident.id).diagnosis, null);
});

test('checkStuckInvestigations re-drives diagnosis once a provider is configured and the incident is old enough', async () => {
  setAIConfig({ provider: 'openai-compatible', model: 'test-model', baseUrl: '', apiKey: 'test-key' });
  _setProviderForTesting({
    chat: async () => ({
      text: JSON.stringify({
        rootCause: 'now diagnosed', confidence: 0.8, evidence: [], affectedComponents: [],
        requiresApproval: false, recommendedActions: []
      }),
      toolCalls: [], usage: {}
    })
  });
  _setClientForTesting(flatAgent());

  const incident = makeStuckIncident(60000);
  await detector.checkStuckInvestigations();
  await new Promise(r => setTimeout(r, 50)); // re-investigation is fire-and-forget, like raiseIncident's

  const updated = store.getIncident(incident.id);
  assert.equal(updated.status, 'DIAGNOSED');
  assert.equal(updated.root_cause, 'now diagnosed');
});

test('checkStuckInvestigations leaves a recently-updated stuck incident alone (cooldown)', async () => {
  setAIConfig({ provider: 'openai-compatible', model: 'test-model', baseUrl: '', apiKey: 'test-key' });
  _setProviderForTesting({
    chat: async () => { throw new Error('should not be called within the cooldown window'); }
  });
  _setClientForTesting(flatAgent());

  const incident = makeStuckIncident(1000); // well under STUCK_RETRY_BASE_MS
  await detector.checkStuckInvestigations();

  assert.equal(store.getIncident(incident.id).status, 'INVESTIGATING');
  assert.equal(store.getIncident(incident.id).diagnosis, null);
});

test('checkStuckInvestigations backs off exponentially for an incident with repeated failed attempts, instead of retrying at a fixed interval forever', async () => {
  setAIConfig({ provider: 'openai-compatible', model: 'test-model', baseUrl: '', apiKey: 'test-key' });
  let chatCalls = 0;
  _setProviderForTesting({
    chat: async () => { chatCalls++; throw new Error('provider still down'); }
  });
  _setClientForTesting(flatAgent());

  const incident = makeStuckIncident(60000);
  // Simulate 3 prior failed diagnosis attempts — each a real ai_runs row,
  // as runDiagnosis itself writes on every failure path (see orchestrator.js).
  for (let i = 0; i < 3; i++) {
    getDb().prepare(`
      INSERT INTO ai_runs (incident_id, purpose, provider, model, attempt, error, created_at)
      VALUES (?, 'diagnosis', 'openai-compatible', 'test-model', 1, 'provider still down', ?)
    `).run(incident.id, Date.now());
  }

  // 3 attempts -> backoff = 30000 * 2^3 = 240000ms. 60s old is well within
  // that window, so this should NOT retry despite clearing the base filter.
  await detector.checkStuckInvestigations();
  await new Promise(r => setTimeout(r, 50));
  assert.equal(chatCalls, 0);

  // Backdate past the computed backoff and it should retry.
  getDb().prepare('UPDATE incidents SET updated_at = ? WHERE id = ?').run(Date.now() - 250000, incident.id);
  await detector.checkStuckInvestigations();
  await new Promise(r => setTimeout(r, 50));
  assert.equal(chatCalls, 1);
});

test('checkStaleWaitingIncidents re-diagnoses an incident parked past the staleness window', async () => {
  const { _setClientForTesting, _resetClientForTesting } = require('../agent/client');
  const { _setProviderForTesting, _resetProviderForTesting } = require('../ai/provider');
  const { setAIConfig, clearAIConfig } = require('../settings/aiConfig');
  const store = require('./store');
  const { upsertResource } = require('../graph/resources');
  const detector = require('./detector');

  setAIConfig({ provider: 'openai-compatible', model: 'm', baseUrl: '', apiKey: 'k' });
  _setClientForTesting({
    listTools: async () => ([{ name: 'start_service', description: 's', risk: 'MEDIUM_RISK', parameters: {} }]),
    callTool: async () => ({}),
    verifyTool: async () => ({ ok: true })
  });
  let diagnosed = 0;
  _setProviderForTesting({
    chat: async () => {
      diagnosed++;
      return { text: JSON.stringify({ rootCause: 'still down', recommendedActions: [] }), usage: {} };
    }
  });

  const r = upsertResource({ type: 'service', externalId: 'stale-' + crypto.randomUUID(), name: 'caddy' });
  // Unattended re-diagnosis is gated on the auto-remediation opt-in
  // (detector.js's shouldAutoDiagnose) — this test is about the backoff
  // policy, so put the resource on that list.
  optIn(r);
  const incident = store.createIncident({ resourceId: r.id, triggerRule: 'service_inactive', triggerSummary: 'down' });
  store.updateIncidentStatus(incident.id, 'INVESTIGATING');
  store.recordDiagnosis(incident.id, { rootCause: 'old wrong diagnosis', confidence: 0.5 });
  store.addAction(incident.id, { tool: 'start_service', params: {}, claimedRisk: 'LOW', realRisk: 'MEDIUM_RISK', rationale: 'x' });
  store.updateIncidentStatus(incident.id, 'AWAITING_APPROVAL');
  // Backdate it well past the staleness window.
  require('../db/connection').getDb().prepare('UPDATE incidents SET updated_at = ? WHERE id = ?')
    .run(Date.now() - 60 * 60 * 1000, incident.id);

  await detector.checkStaleWaitingIncidents();
  await new Promise(r => setTimeout(r, 50)); // rediagnose is fire-and-forget

  assert.equal(diagnosed >= 1, true, 'a stale waiting incident should be re-diagnosed');
  assert.equal(store.getIncident(incident.id).root_cause, 'still down');

  clearAIConfig();
  _resetClientForTesting();
  _resetProviderForTesting();
});

test('checkStaleWaitingIncidents leaves a freshly-updated incident alone', async () => {
  const { setAIConfig, clearAIConfig } = require('../settings/aiConfig');
  const { _setProviderForTesting, _resetProviderForTesting } = require('../ai/provider');
  const store = require('./store');
  const { upsertResource } = require('../graph/resources');
  const detector = require('./detector');

  setAIConfig({ provider: 'openai-compatible', model: 'm', baseUrl: '', apiKey: 'k' });
  let diagnosed = 0;
  _setProviderForTesting({ chat: async () => { diagnosed++; return { text: '{}', usage: {} }; } });

  const r = upsertResource({ type: 'service', externalId: 'fresh-' + crypto.randomUUID(), name: 'x' });
  const incident = store.createIncident({ resourceId: r.id, triggerRule: 'service_inactive', triggerSummary: 'down' });
  optIn(r);
  store.updateIncidentStatus(incident.id, 'INVESTIGATING');
  store.recordDiagnosis(incident.id, { rootCause: 'recent', confidence: 0.5 });
  store.updateIncidentStatus(incident.id, 'AWAITING_APPROVAL'); // updated_at = now

  await detector.checkStaleWaitingIncidents();
  assert.equal(diagnosed, 0, 'a recently-updated incident must not be re-diagnosed');

  clearAIConfig();
  _resetProviderForTesting();
});


// ── Auto-diagnosis is opt-in ────────────────────────────────────────────
// Detection is free; a diagnosis is a provider request, and a free tier's
// daily allowance (20/day on the Gemini tier this install uses) is easily
// spent by routine container churn nobody was watching. Only a resource
// the operator has opted into auto-remediation is diagnosed unattended.

test('an incident for a NON-opted-in resource is raised but never sent to the AI', async () => {
  setAIConfig({ provider: 'openai-compatible', model: 'm', baseUrl: '', apiKey: 'k' });
  let chatCalls = 0;
  _setProviderForTesting({ chat: async () => { chatCalls++; return { text: '{}', usage: {} }; } });
  _setClientForTesting(flatAgent());

  const name = 'unlisted-' + crypto.randomUUID();
  await detector.raiseIncident({
    resourceRef: { type: 'container', externalId: name, name },
    severity: 'high', triggerRule: 'container_exit', triggerSummary: 'exited 1'
  });
  await new Promise(r => setTimeout(r, 60));

  const resource = upsertResource({ type: 'container', externalId: name, name });
  const incident = store.findOpenIncidentForResource(resource.id);
  assert.ok(incident, 'the incident is still detected and recorded — only the AI call is withheld');
  assert.equal(incident.status, 'DETECTED', 'it waits for a human to press Diagnose');
  assert.equal(chatCalls, 0, 'no provider request was spent');

  clearAIConfig();
  _resetProviderForTesting();
  _resetClientForTesting();
});

test('an incident for an opted-in resource IS diagnosed automatically', async () => {
  setAIConfig({ provider: 'openai-compatible', model: 'm', baseUrl: '', apiKey: 'k' });
  let chatCalls = 0;
  _setProviderForTesting({
    chat: async () => {
      chatCalls++;
      return { text: JSON.stringify({ rootCause: 'it exited', recommendedActions: [] }), usage: {} };
    }
  });
  _setClientForTesting(flatAgent());

  const name = 'listed-' + crypto.randomUUID();
  optIn(upsertResource({ type: 'container', externalId: name, name }));

  await detector.raiseIncident({
    resourceRef: { type: 'container', externalId: name, name },
    severity: 'high', triggerRule: 'container_exit', triggerSummary: 'exited 1'
  });
  await new Promise(r => setTimeout(r, 80));

  const resource = upsertResource({ type: 'container', externalId: name, name });
  const incident = store.findOpenIncidentForResource(resource.id);
  assert.equal(chatCalls, 1, 'a resource Sentinel may heal unattended is worth diagnosing unattended');
  assert.equal(incident.root_cause, 'it exited');

  clearAIConfig();
  _resetProviderForTesting();
  _resetClientForTesting();
});

test('checkStuckInvestigations skips a non-opted-in incident rather than retrying it forever', async () => {
  setAIConfig({ provider: 'openai-compatible', model: 'm', baseUrl: '', apiKey: 'k' });
  let chatCalls = 0;
  _setProviderForTesting({ chat: async () => { chatCalls++; return { text: '{}', usage: {} }; } });
  _setClientForTesting(flatAgent());

  makeStuckIncident(60000, { autoDiagnose: false });
  await detector.checkStuckInvestigations();
  await new Promise(r => setTimeout(r, 60));

  assert.equal(chatCalls, 0, 'an unattended retry is still an unattended provider call');

  clearAIConfig();
  _resetProviderForTesting();
  _resetClientForTesting();
});

// ── Compose metadata sync (deploy correlation) ──────────────────────────

test('checkContainerHealth records compose project/service labels onto the resource', async () => {
  const name = 'demo-api-' + crypto.randomUUID();
  const agent = flatAgent({
    list_containers: () => [
      { name, health: 'healthy', composeProject: 'demo-api', composeService: 'web', composeDependsOn: null }
    ]
  });

  await detector.checkContainerHealth(agent);

  const resource = getResourceByRef('container', name);
  assert.ok(resource);
  assert.deepEqual(resource.metadata, { composeProject: 'demo-api', composeService: 'web' });
});

test('checkContainerHealth leaves an already-recorded compose label alone for a container reporting none this tick', async () => {
  const name = 'flaky-labels-' + crypto.randomUUID();
  upsertResource({ type: 'container', externalId: name, name, metadata: { composeProject: 'demo-api', composeService: 'web' } });

  const agent = flatAgent({
    // Simulates a container observed without compose labels this tick
    // (e.g. dockerode returned an incomplete inspect) — must not erase
    // what an earlier tick already recorded.
    list_containers: () => [{ name, health: 'healthy', composeProject: null, composeService: null }]
  });
  await detector.checkContainerHealth(agent);

  assert.deepEqual(getResourceByRef('container', name).metadata, { composeProject: 'demo-api', composeService: 'web' });
});

test('a container_exit upsert (no metadata passed) does not wipe compose metadata set earlier in the same tick', async () => {
  // Regression for the exact bug found during review: raiseIncident's own
  // upsertResource(resourceRef) call (on container_exit) never passes
  // metadata, so without graph/resources.js's COALESCE fix this would
  // silently erase the compose labels checkContainerHealth just set —
  // right as an incident is raised, exactly when deploy correlation
  // needs them.
  const name = 'dies-' + crypto.randomUUID();
  const agent = flatAgent({
    list_containers: () => [{ name, health: 'healthy', composeProject: 'demo-api', composeService: 'web' }],
    get_docker_events: () => [{ type: 'die', name, exitCode: '1', ts: Date.now() }]
  });

  await detector.checkContainerHealth(agent);
  await detector.checkContainerEvents(agent);

  assert.deepEqual(getResourceByRef('container', name).metadata, { composeProject: 'demo-api', composeService: 'web' });
});

// ── Learned runbooks (Feature 2) run unconditionally, ahead of the AI gate ──

test('a matching runbook fires for a non-opted-in resource, without ever calling the AI', async () => {
  const { getDb } = require('../db/connection');
  const triggerRule = 'container_exit';
  const resourceType = 'container';

  // Seed a 2/2 track record for restart_container on this trigger+type,
  // via raw SQL — the same house style detector.test.js already uses for
  // backdated timestamps, since walking the full state machine just to
  // seed history would obscure what's actually being tested.
  const seedIncident = () => {
    const r = upsertResource({ type: resourceType, externalId: 'seed-' + crypto.randomUUID(), name: 'seed' });
    const now = Date.now();
    const incidentId = getDb().prepare(`
      INSERT INTO incidents (resource_id, status, trigger_rule, trigger_summary, detected_at, updated_at, resolved_at)
      VALUES (?, 'RESOLVED', ?, 'x', ?, ?, ?)
    `).run(r.id, triggerRule, now, now, now + 500).lastInsertRowid;
    getDb().prepare(`
      INSERT INTO incident_actions (incident_id, tool_name, params_json, real_risk, status, created_at, executed_at)
      VALUES (?, 'restart_container', '{}', 'MEDIUM_RISK', 'executed', ?, ?)
    `).run(incidentId, now, now);
  };
  seedIncident();
  seedIncident();

  setAIConfig({ provider: 'openai-compatible', model: 'm', baseUrl: '', apiKey: 'k' });
  let chatCalls = 0;
  _setProviderForTesting({ chat: async () => { chatCalls++; return { text: '{}', usage: {} }; } });
  _setClientForTesting({
    listTools: async () => [{ name: 'restart_container', risk: 'MEDIUM_RISK', description: 'x', parameters: {} }],
    callTool: async () => ({}),
    verifyTool: async () => ({ ok: true })
  });

  const name = 'runbook-target-' + crypto.randomUUID(); // NOT opted into auto-remediation
  await detector.raiseIncident({
    resourceRef: { type: 'container', externalId: name, name },
    severity: 'high', triggerRule, triggerSummary: 'exited 1'
  });
  await new Promise(r => setTimeout(r, 80));

  const resource = getResourceByRef('container', name);
  const incident = store.findOpenIncidentForResource(resource.id);
  assert.ok(incident, 'a non-opted-in resource is still detected');
  assert.equal(incident.status, 'AWAITING_APPROVAL', 'the runbook proposal still needs a human click, since this resource is not auto-remediate-opted-in');
  assert.equal(incident.diagnosis?.source, 'runbook');
  assert.equal(chatCalls, 0, 'the runbook match must never spend a provider request');

  clearAIConfig();
  _resetProviderForTesting();
  _resetClientForTesting();
});
