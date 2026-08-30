'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = path.join(os.tmpdir(), `sentinel-test-access-${crypto.randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { migrate } = require('../db/migrate');
const { getDb } = require('../db/connection');
const { getAccessScope, setAccessScope, getAllowedRoots } = require('./accessScope');

before(() => migrate());
beforeEach(() => getDb().prepare("DELETE FROM settings WHERE key LIKE 'access.%'").run());
after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(DB_PATH + suffix); } catch { /* already gone */ }
  }
});

test('filesystem access is closed by default — the safe default is nothing', () => {
  assert.deepEqual(getAccessScope().paths, []);
  assert.deepEqual(getAllowedRoots(), []);
});

test("Sentinel's own records are readable by default — no host risk in them", () => {
  assert.equal(getAccessScope().ownData, true);
});

test('own-data access can be turned off explicitly', () => {
  setAccessScope({ ownData: false });
  assert.equal(getAccessScope().ownData, false);
  setAccessScope({ ownData: true });
  assert.equal(getAccessScope().ownData, true);
});

test('allowed paths round-trip with their labels', () => {
  setAccessScope({ paths: [{ path: '/var/log', label: 'logs' }, { path: '/srv/apps' }] });
  assert.deepEqual(getAllowedRoots(), ['/var/log', '/srv/apps']);
  assert.equal(getAccessScope().paths[0].label, 'logs');
  assert.equal(getAccessScope().paths[1].label, null);
});

test('a relative path is rejected — containment depends on absolute paths', () => {
  assert.throws(() => setAccessScope({ paths: ['var/log'] }), /must be absolute/);
});

test('a path containing ".." is rejected outright rather than normalised', () => {
  // Normalising would work, but refusing means what is stored is always
  // literally what the operator sees in the list.
  assert.throws(() => setAccessScope({ paths: ['/var/log/../../etc'] }), /must not contain/);
});

test('a trailing slash is normalised so one root cannot be listed twice', () => {
  setAccessScope({ paths: ['/var/log/', '/var/log'] });
  assert.deepEqual(getAllowedRoots(), ['/var/log']);
});

test('too many paths is refused', () => {
  const many = Array.from({ length: 30 }, (_, i) => `/tmp/dir${i}`);
  assert.throws(() => setAccessScope({ paths: many }), /At most/);
});

test('a malformed stored value falls back to closed, not to open', () => {
  const { setSetting } = require('../db/settings');
  setSetting('access.paths', 'not json at all');
  assert.deepEqual(getAccessScope().paths, [], 'corruption must never widen access');
});

test('updating one field leaves the other alone', () => {
  setAccessScope({ paths: ['/var/log'], ownData: false });
  setAccessScope({ paths: ['/var/log', '/srv/apps'] });
  assert.equal(getAccessScope().ownData, false, 'paths update must not silently re-enable own data');
});
