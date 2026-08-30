'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = path.join(os.tmpdir(), `sentinel-test-discovery-${crypto.randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { migrate } = require('../db/migrate');
const { getResourceByRef } = require('./resources');
const { getDependents, getNeighbours } = require('./relationships');
const { discoverComposeEdges, parseDependsOn } = require('./discovery');

before(() => migrate());
after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(DB_PATH + suffix); } catch { /* already gone */ }
  }
});

const p = () => 'proj-' + crypto.randomUUID().slice(0, 8);

test('parseDependsOn strips compose condition suffixes and handles multiples', () => {
  assert.deepEqual(parseDependsOn('demo-db:service_started:false'), ['demo-db']);
  assert.deepEqual(parseDependsOn('db:service_healthy:true,cache:service_started:false'), ['db', 'cache']);
  assert.deepEqual(parseDependsOn(''), []);
  assert.deepEqual(parseDependsOn(null), []);
});

test('a compose depends_on label becomes a real depends_on edge', () => {
  const project = p();
  const count = discoverComposeEdges([
    { name: `${project}-demo-api-1`, composeProject: project, composeService: 'demo-api', composeDependsOn: 'demo-db:service_started:false' },
    { name: `${project}-demo-db-1`, composeProject: project, composeService: 'demo-db', composeDependsOn: null }
  ]);
  assert.equal(count, 1);

  // This is what makes a clean `docker stop demo-db` (exit 0) page at all.
  const db = getResourceByRef('container', `${project}-demo-db-1`);
  const dependents = getDependents(db.id);
  assert.equal(dependents.length, 1);
  assert.equal(dependents[0].external_id, `${project}-demo-api-1`);
});

test('the edge resolves through compose labels, not container-name guessing', () => {
  const project = p();
  discoverComposeEdges([
    { name: 'totally-custom-api-name', composeProject: project, composeService: 'api', composeDependsOn: 'db:service_started:false' },
    { name: 'totally-custom-db-name', composeProject: project, composeService: 'db', composeDependsOn: null }
  ]);
  const db = getResourceByRef('container', 'totally-custom-db-name');
  assert.equal(getDependents(db.id)[0].external_id, 'totally-custom-api-name');
});

test('re-running discovery is idempotent — no duplicate edges', () => {
  const project = p();
  const containers = [
    { name: `${project}-api-1`, composeProject: project, composeService: 'api', composeDependsOn: 'db:service_started:false' },
    { name: `${project}-db-1`, composeProject: project, composeService: 'db', composeDependsOn: null }
  ];
  discoverComposeEdges(containers);
  discoverComposeEdges(containers);
  discoverComposeEdges(containers);

  const db = getResourceByRef('container', `${project}-db-1`);
  assert.equal(getDependents(db.id).length, 1);
  assert.equal(getNeighbours(db.id).length, 1);
});

test('a dependency in a different compose project is never linked', () => {
  const a = p();
  const b = p();
  const count = discoverComposeEdges([
    { name: `${a}-api-1`, composeProject: a, composeService: 'api', composeDependsOn: 'db:service_started:false' },
    { name: `${b}-db-1`, composeProject: b, composeService: 'db', composeDependsOn: null }
  ]);
  assert.equal(count, 0, 'projects must stay isolated');
});

test('a depends_on naming a container that is not present is skipped, not invented', () => {
  const project = p();
  const count = discoverComposeEdges([
    { name: `${project}-api-1`, composeProject: project, composeService: 'api', composeDependsOn: 'never-created:service_started:false' }
  ]);
  assert.equal(count, 0);
});

test('non-compose containers are ignored entirely', () => {
  assert.equal(discoverComposeEdges([
    { name: 'plain-container', composeProject: null, composeService: null, composeDependsOn: null }
  ]), 0);
  assert.equal(discoverComposeEdges([]), 0);
  assert.equal(discoverComposeEdges(), 0);
});
