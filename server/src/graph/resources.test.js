'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = path.join(os.tmpdir(), `sentinel-test-resources-${crypto.randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { migrate } = require('../db/migrate');
const { upsertResource, getResourceByRef, getResource, listResources } = require('./resources');

before(() => migrate());
after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(DB_PATH + suffix); } catch { /* already gone */ }
  }
});

test('upsertResource creates a new resource', () => {
  const r = upsertResource({ type: 'container', externalId: 'demo-api', name: 'demo-api' });
  assert.ok(r.id);
  assert.equal(r.type, 'container');
  assert.equal(r.external_id, 'demo-api');
});

test('upsertResource on the same (type, externalId) updates rather than duplicates', () => {
  const first = upsertResource({ type: 'service', externalId: 'caddy', name: 'caddy' });
  const second = upsertResource({ type: 'service', externalId: 'caddy', name: 'Caddy (renamed)', metadata: { note: 'x' } });
  assert.equal(first.id, second.id);
  assert.equal(getResource(first.id).name, 'Caddy (renamed)');
  assert.deepEqual(getResource(first.id).metadata, { note: 'x' });
});

test('getResourceByRef finds an existing resource by type+externalId', () => {
  upsertResource({ type: 'website', externalId: 'example.com', name: 'example.com' });
  const found = getResourceByRef('website', 'example.com');
  assert.ok(found);
  assert.equal(found.name, 'example.com');
});

test('getResourceByRef returns null for an unknown ref', () => {
  assert.equal(getResourceByRef('container', 'does-not-exist'), null);
});

test('listResources returns every upserted resource', () => {
  const before2 = listResources().length;
  upsertResource({ type: 'container', externalId: 'one-off-' + crypto.randomUUID(), name: 'x' });
  assert.equal(listResources().length, before2 + 1);
});

test('a later upsert with no metadata does not erase metadata an earlier upsert recorded', () => {
  // Regression: the detector observes the same container from two
  // different code paths in the same 5s tick — checkContainerHealth sets
  // compose labels for deploy correlation, but raiseIncident's own
  // upsert (e.g. on a container_exit event) never passes metadata at
  // all. Before the COALESCE fix, that second call's implicit `null`
  // would silently wipe the compose metadata right as an incident is
  // raised — exactly when deploy correlation needs it.
  const id = 'compose-container-' + crypto.randomUUID();
  upsertResource({ type: 'container', externalId: id, name: id, metadata: { composeProject: 'demo-api' } });
  const updated = upsertResource({ type: 'container', externalId: id, name: id }); // no metadata this time
  assert.deepEqual(updated.metadata, { composeProject: 'demo-api' });
});

test('explicitly passing metadata still replaces the old value (not merged, overwritten)', () => {
  const id = 'compose-container-' + crypto.randomUUID();
  upsertResource({ type: 'container', externalId: id, name: id, metadata: { composeProject: 'old' } });
  const updated = upsertResource({ type: 'container', externalId: id, name: id, metadata: { composeProject: 'new' } });
  assert.deepEqual(updated.metadata, { composeProject: 'new' });
});
