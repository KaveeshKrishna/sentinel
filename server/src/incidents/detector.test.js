'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = path.join(os.tmpdir(), `sentinel-test-detector-${crypto.randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { migrate } = require('../db/migrate');
const { getDb } = require('../db/connection');
const { registerRelationship } = require('../graph/relationships');
const { getResourceByRef } = require('../graph/resources');
const { _setClientForTesting, _resetClientForTesting } = require('../agent/client');
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
  await new Promise(r => setTimeout(r, 50)); // let any fire-and-forget investigations settle
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(DB_PATH + suffix); } catch { /* already gone */ }
  }
});

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
