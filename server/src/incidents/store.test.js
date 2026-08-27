'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = path.join(os.tmpdir(), `sentinel-test-incidentstore-${crypto.randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { migrate } = require('../db/migrate');
const { upsertResource } = require('../graph/resources');
const store = require('./store');

before(() => migrate());
after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(DB_PATH + suffix); } catch { /* already gone */ }
  }
});

function makeResource() {
  return upsertResource({ type: 'container', externalId: 'r-' + crypto.randomUUID(), name: 'r' });
}

test('createIncident starts at DETECTED and findOpenIncidentForResource finds it', () => {
  const resource = makeResource();
  const incident = store.createIncident({ resourceId: resource.id, triggerRule: 'container_exit', triggerSummary: 'exited' });
  assert.equal(incident.status, 'DETECTED');
  const open = store.findOpenIncidentForResource(resource.id);
  assert.equal(open.id, incident.id);
});

test('findOpenIncidentForResource returns null once the incident is terminal', () => {
  const resource = makeResource();
  const incident = store.createIncident({ resourceId: resource.id, triggerRule: 'x', triggerSummary: 'x' });
  store.updateIncidentStatus(incident.id, 'INVESTIGATING');
  store.updateIncidentStatus(incident.id, 'DISMISSED');
  assert.equal(store.findOpenIncidentForResource(resource.id), null);
});

test('updateIncidentStatus follows the legal path end to end', () => {
  const resource = makeResource();
  const incident = store.createIncident({ resourceId: resource.id, triggerRule: 'x', triggerSummary: 'x' });
  store.updateIncidentStatus(incident.id, 'INVESTIGATING');
  store.recordDiagnosis(incident.id, { rootCause: 'x', confidence: 0.8 });
  store.updateIncidentStatus(incident.id, 'AWAITING_APPROVAL');
  store.updateIncidentStatus(incident.id, 'REMEDIATING');
  store.updateIncidentStatus(incident.id, 'VERIFYING');
  const resolved = store.recordResolution(incident.id, 'RESOLVED');
  assert.equal(resolved.status, 'RESOLVED');
  assert.ok(resolved.resolved_at);
});

test('updateIncidentStatus throws IllegalTransitionError on an illegal skip', () => {
  const resource = makeResource();
  const incident = store.createIncident({ resourceId: resource.id, triggerRule: 'x', triggerSummary: 'x' });
  assert.throws(() => store.updateIncidentStatus(incident.id, 'RESOLVED'), store.IllegalTransitionError);
});

test('addEvidence + getEvidence round-trips rows in insertion order', () => {
  const resource = makeResource();
  const incident = store.createIncident({ resourceId: resource.id, triggerRule: 'x', triggerSummary: 'x' });
  store.addEvidence(incident.id, [
    { resourceId: resource.id, sourceTool: 'get_container_status', summary: 'ok', data: { a: 1 } },
    { resourceId: null, sourceTool: 'inspect_git_status', summary: 'clean', data: [] }
  ]);
  const evidence = store.getEvidence(incident.id);
  assert.equal(evidence.length, 2);
  assert.equal(evidence[0].source_tool, 'get_container_status');
  assert.deepEqual(evidence[0].data, { a: 1 });
});

test('addAction defaults to proposed status and updateActionStatus transitions it', () => {
  const resource = makeResource();
  const incident = store.createIncident({ resourceId: resource.id, triggerRule: 'x', triggerSummary: 'x' });
  const action = store.addAction(incident.id, {
    tool: 'restart_container', params: { id: 'x' }, claimedRisk: 'LOW', realRisk: 'MEDIUM_RISK', rationale: 'bring it back'
  });
  assert.equal(action.status, 'proposed');
  assert.equal(action.real_risk, 'MEDIUM_RISK');

  const approved = store.updateActionStatus(action.id, 'approved', { approved_by: null, approved_at: Date.now() });
  assert.equal(approved.status, 'approved');

  const actions = store.getActions(incident.id);
  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0].params, { id: 'x' });
});

test('recordInvestigationFailure preserves raw text without illegally changing status', () => {
  const resource = makeResource();
  const incident = store.createIncident({ resourceId: resource.id, triggerRule: 'x', triggerSummary: 'x' });
  store.updateIncidentStatus(incident.id, 'INVESTIGATING');
  const updated = store.recordInvestigationFailure(incident.id, 'not valid json');
  assert.equal(updated.status, 'INVESTIGATING');
  assert.equal(updated.diagnosis_raw_text, 'not valid json');
});

test('deleteIncident removes the incident and cascades to its evidence and actions', () => {
  const resource = makeResource();
  const incident = store.createIncident({ resourceId: resource.id, triggerRule: 'x', triggerSummary: 'x' });
  store.addEvidence(incident.id, [{ sourceTool: 't', summary: 's', data: null }]);
  store.addAction(incident.id, { tool: 'restart_container', params: {}, claimedRisk: 'LOW', realRisk: 'MEDIUM_RISK', rationale: 'x' });

  assert.equal(store.deleteIncident(incident.id), 1);
  assert.equal(store.getIncident(incident.id), null);
  assert.equal(store.getEvidence(incident.id).length, 0);
  assert.equal(store.getActions(incident.id).length, 0);
  assert.equal(store.deleteIncident(incident.id), 0); // already gone
});

test('deleteIncidents({status}) only clears that state; without a status clears everything', () => {
  const a = store.createIncident({ resourceId: makeResource().id, triggerRule: 'x', triggerSummary: 'x' });
  const b = store.createIncident({ resourceId: makeResource().id, triggerRule: 'x', triggerSummary: 'x' });
  store.updateIncidentStatus(a.id, 'INVESTIGATING');
  store.updateIncidentStatus(a.id, 'DISMISSED');

  const dismissedRemoved = store.deleteIncidents({ status: 'DISMISSED' });
  assert.ok(dismissedRemoved >= 1);
  assert.equal(store.getIncident(a.id), null);       // the DISMISSED one is gone
  assert.ok(store.getIncident(b.id));                // a non-DISMISSED one survives

  const cleared = store.deleteIncidents();
  assert.ok(cleared >= 1);
  assert.equal(store.listIncidents().length, 0);
});
