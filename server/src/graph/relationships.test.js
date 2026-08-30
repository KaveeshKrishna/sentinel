'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = path.join(os.tmpdir(), `sentinel-test-relationships-${crypto.randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { migrate } = require('../db/migrate');
const { registerRelationship, getNeighbours, getDependents } = require('./relationships');
const { getResourceByRef } = require('./resources');

before(() => migrate());
after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(DB_PATH + suffix); } catch { /* already gone */ }
  }
});

test('registerRelationship upserts both endpoints and creates the edge', () => {
  registerRelationship(
    { type: 'container', externalId: 'demo-api', name: 'demo-api' },
    { type: 'container', externalId: 'demo-db', name: 'demo-db' },
    'depends_on'
  );
  const api = getResourceByRef('container', 'demo-api');
  const db = getResourceByRef('container', 'demo-db');
  assert.ok(api && db);

  const neighbours = getNeighbours(api.id);
  assert.equal(neighbours.length, 1);
  assert.equal(neighbours[0].external_id, 'demo-db');
  assert.equal(neighbours[0].direction, 'outgoing');
});

test('registering the same edge twice does not duplicate it', () => {
  registerRelationship(
    { type: 'container', externalId: 'demo-api', name: 'demo-api' },
    { type: 'container', externalId: 'demo-db', name: 'demo-db' },
    'depends_on'
  );
  const api = getResourceByRef('container', 'demo-api');
  assert.equal(getNeighbours(api.id).length, 1);
});

test('getDependents finds resources that depend_on this one', () => {
  const db = getResourceByRef('container', 'demo-db');
  const dependents = getDependents(db.id);
  assert.equal(dependents.length, 1);
  assert.equal(dependents[0].external_id, 'demo-api');
});

test('getNeighbours sees the incoming direction from the other side', () => {
  const db = getResourceByRef('container', 'demo-db');
  const neighbours = getNeighbours(db.id);
  assert.equal(neighbours.length, 1);
  assert.equal(neighbours[0].direction, 'incoming');
  assert.equal(neighbours[0].external_id, 'demo-api');
});
