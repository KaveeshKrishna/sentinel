'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = path.join(os.tmpdir(), `sentinel-test-autoremediate-${crypto.randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { migrate } = require('../db/migrate');
const { getDb } = require('../db/connection');
const { upsertResource } = require('../graph/resources');
const store = require('../incidents/store');
const {
  MAX_AUTO_PER_WINDOW, setAutoRemediateList, getAutoRemediateList,
  isToolAutoRemediable, evaluateAutoRemediation
} = require('./autoRemediate');

before(() => migrate());
beforeEach(() => setAutoRemediateList([]));
after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(DB_PATH + suffix); } catch { /* already gone */ }
  }
});

const makeResource = (type, name) =>
  upsertResource({ type, externalId: name, name });

test('nothing is auto-remediable by default', () => {
  assert.deepEqual(getAutoRemediateList(), []);
  const caddy = makeResource('service', 'caddy-' + crypto.randomUUID().slice(0, 6));
  const { allowed, reason } = evaluateAutoRemediation({
    resource: caddy, toolName: 'start_service', realRisk: 'MEDIUM_RISK'
  });
  assert.equal(allowed, false);
  assert.match(reason, /not opted in/);
});

test('an opted-in resource with a restorative tool is allowed', () => {
  const caddy = makeResource('service', 'caddy-' + crypto.randomUUID().slice(0, 6));
  setAutoRemediateList([`service:${caddy.external_id}`]);
  assert.equal(evaluateAutoRemediation({
    resource: caddy, toolName: 'start_service', realRisk: 'MEDIUM_RISK'
  }).allowed, true);
});

test('opting in one resource never enables another', () => {
  const a = makeResource('service', 'a-' + crypto.randomUUID().slice(0, 6));
  const b = makeResource('service', 'b-' + crypto.randomUUID().slice(0, 6));
  setAutoRemediateList([`service:${a.external_id}`]);
  assert.equal(evaluateAutoRemediation({ resource: b, toolName: 'start_service', realRisk: 'MEDIUM_RISK' }).allowed, false);
});

test('destructive and non-restorative tools are never auto-remediable, however risk is labelled', () => {
  // The tool allowlist is the boundary — a stop is not a repair.
  assert.equal(isToolAutoRemediable('stop_service', 'LOW_RISK'), false);
  assert.equal(isToolAutoRemediable('stop_container', 'READ_ONLY'), false);
  assert.equal(isToolAutoRemediable('deploy_repository', 'MEDIUM_RISK'), false);
  assert.equal(isToolAutoRemediable('prune_images', 'DESTRUCTIVE'), false);
  // A rollback deploys different code just as much as a forward deploy
  // does — it must never run unattended, at any risk label, sibling to
  // the deploy_repository assertion above.
  assert.equal(isToolAutoRemediable('rollback_repository', 'MEDIUM_RISK'), false);
  assert.equal(isToolAutoRemediable('rollback_repository', 'LOW_RISK'), false);
});

test('a restorative tool above the risk ceiling is still refused', () => {
  assert.equal(isToolAutoRemediable('restart_service', 'MEDIUM_RISK'), true);
  assert.equal(isToolAutoRemediable('restart_service', 'HIGH_RISK'), false);
  assert.equal(isToolAutoRemediable('restart_service', 'DESTRUCTIVE'), false);
});

test('an opted-in resource asking for a non-allowlisted tool is refused with a reason', () => {
  const svc = makeResource('service', 'svc-' + crypto.randomUUID().slice(0, 6));
  setAutoRemediateList([`service:${svc.external_id}`]);
  const { allowed, reason } = evaluateAutoRemediation({
    resource: svc, toolName: 'stop_service', realRisk: 'HIGH_RISK'
  });
  assert.equal(allowed, false);
  assert.match(reason, /not an auto-remediable tool/);
});

test('the rate limit escalates to a human after repeated machine-approved attempts', () => {
  const svc = makeResource('service', 'flap-' + crypto.randomUUID().slice(0, 6));
  setAutoRemediateList([`service:${svc.external_id}`]);

  // Simulate a crash-looping service: MAX_AUTO_PER_WINDOW prior
  // auto-approvals (approved_via = 'auto' is what marks them machine-run).
  for (let i = 0; i < MAX_AUTO_PER_WINDOW; i++) {
    const incident = store.createIncident({ resourceId: svc.id, triggerRule: 'service_inactive', triggerSummary: 'down' });
    const action = store.addAction(incident.id, {
      tool: 'start_service', params: {}, claimedRisk: 'LOW', realRisk: 'MEDIUM_RISK', rationale: 'x'
    });
    store.updateActionStatus(action.id, 'executed', { approved_by: null, approved_at: Date.now(), approved_via: 'auto' });
    store.updateIncidentStatus(incident.id, 'INVESTIGATING');
    store.updateIncidentStatus(incident.id, 'DISMISSED');
  }

  const { allowed, reason } = evaluateAutoRemediation({
    resource: svc, toolName: 'start_service', realRisk: 'MEDIUM_RISK'
  });
  assert.equal(allowed, false);
  assert.match(reason, /rate limit reached/);
});

test('a human-approved action does not count against the machine rate limit', () => {
  const svc = makeResource('service', 'human-' + crypto.randomUUID().slice(0, 6));
  setAutoRemediateList([`service:${svc.external_id}`]);
  const userId = getDb().prepare(
    `INSERT INTO users (username, password_hash, created_at) VALUES (?, 'x', ?)`
  ).run('u-' + crypto.randomUUID(), Date.now()).lastInsertRowid;

  for (let i = 0; i < MAX_AUTO_PER_WINDOW + 2; i++) {
    const incident = store.createIncident({ resourceId: svc.id, triggerRule: 'service_inactive', triggerSummary: 'down' });
    const action = store.addAction(incident.id, {
      tool: 'start_service', params: {}, claimedRisk: 'LOW', realRisk: 'MEDIUM_RISK', rationale: 'x'
    });
    store.updateActionStatus(action.id, 'executed', { approved_by: userId, approved_at: Date.now() });
    store.updateIncidentStatus(incident.id, 'INVESTIGATING');
    store.updateIncidentStatus(incident.id, 'DISMISSED');
  }

  assert.equal(evaluateAutoRemediation({
    resource: svc, toolName: 'start_service', realRisk: 'MEDIUM_RISK'
  }).allowed, true);
});

test('a malformed resource key is rejected rather than stored', () => {
  assert.throws(() => setAutoRemediateList(['no-colon']), /Invalid resource key/);
  assert.throws(() => setAutoRemediateList([42]), /Invalid resource key/);
  assert.throws(() => setAutoRemediateList('service:caddy'), /Expected an array/);
  assert.deepEqual(getAutoRemediateList(), []);
});

test('duplicate keys are de-duplicated on save', () => {
  assert.deepEqual(setAutoRemediateList(['service:caddy', 'service:caddy']), ['service:caddy']);
});

test('canonicalRemediation maps deterministic "not running" triggers to a restart', () => {
  const { canonicalRemediation } = require('./autoRemediate');
  const svc = { type: 'service', external_id: 'caddy' };
  const ctr = { type: 'container', external_id: 'app-api' };

  assert.deepEqual(canonicalRemediation('service_inactive', svc), { tool: 'restart_service', params: { service: 'caddy' } });
  assert.deepEqual(canonicalRemediation('container_exit', ctr), { tool: 'restart_container', params: { id: 'app-api' } });
  assert.deepEqual(canonicalRemediation('container_unhealthy', ctr), { tool: 'restart_container', params: { id: 'app-api' } });
  assert.deepEqual(canonicalRemediation('container_oom', ctr), { tool: 'restart_container', params: { id: 'app-api' } });
});

test('canonicalRemediation returns null for triggers a restart does not fix', () => {
  const { canonicalRemediation } = require('./autoRemediate');
  const host = { type: 'host', external_id: 'localhost' };
  assert.equal(canonicalRemediation('sustained_cpu', host), null);
  assert.equal(canonicalRemediation('sustained_ram', host), null);
  assert.equal(canonicalRemediation('disk_usage', host), null);
  assert.equal(canonicalRemediation('service_inactive', { type: 'container', external_id: 'x' }), null); // type mismatch
});

test('a one-click link approval does not consume the machine rate-limit budget', () => {
  // Both an auto-remediation and a link approval have approved_by NULL.
  // Counting on that alone (as this did before migration 012) meant a
  // human approving from their phone silently ate the budget meant to
  // stop *unattended* healing from looping.
  const svc = makeResource('service', 'link-' + crypto.randomUUID().slice(0, 6));
  setAutoRemediateList([`service:${svc.external_id}`]);

  for (let i = 0; i < MAX_AUTO_PER_WINDOW + 2; i++) {
    const incident = store.createIncident({ resourceId: svc.id, triggerRule: 'service_inactive', triggerSummary: 'down' });
    const action = store.addAction(incident.id, {
      tool: 'start_service', params: {}, claimedRisk: 'LOW', realRisk: 'MEDIUM_RISK', rationale: 'x'
    });
    store.updateActionStatus(action.id, 'executed', { approved_by: null, approved_at: Date.now(), approved_via: 'link' });
    store.updateIncidentStatus(incident.id, 'INVESTIGATING');
    store.updateIncidentStatus(incident.id, 'DISMISSED');
  }

  const { allowed } = evaluateAutoRemediation({
    resource: svc, toolName: 'start_service', realRisk: 'MEDIUM_RISK'
  });
  assert.equal(allowed, true);
});

test('machine approvals predating migration 012 still count against the limit', () => {
  // Historical rows have approved_via NULL; the fallback clause keeps
  // them counted so the limit does not silently reset on upgrade.
  const svc = makeResource('service', 'legacy-' + crypto.randomUUID().slice(0, 6));
  setAutoRemediateList([`service:${svc.external_id}`]);

  for (let i = 0; i < MAX_AUTO_PER_WINDOW; i++) {
    const incident = store.createIncident({ resourceId: svc.id, triggerRule: 'service_inactive', triggerSummary: 'down' });
    const action = store.addAction(incident.id, {
      tool: 'start_service', params: {}, claimedRisk: 'LOW', realRisk: 'MEDIUM_RISK', rationale: 'x'
    });
    // approved_via deliberately left NULL, as an upgraded database has it
    store.updateActionStatus(action.id, 'executed', { approved_by: null, approved_at: Date.now() });
    store.updateIncidentStatus(incident.id, 'INVESTIGATING');
    store.updateIncidentStatus(incident.id, 'DISMISSED');
  }

  const { allowed, reason } = evaluateAutoRemediation({
    resource: svc, toolName: 'start_service', realRisk: 'MEDIUM_RISK'
  });
  assert.equal(allowed, false);
  assert.match(reason, /rate limit reached/);
});
