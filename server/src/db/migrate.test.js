'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = path.join(os.tmpdir(), `sentinel-test-migrate-${crypto.randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { migrate, MIGRATIONS_DIR } = require('./migrate');
const { getDb } = require('./connection');

after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(DB_PATH + suffix); } catch { /* already gone */ }
  }
});

test('migrate() creates every expected table from an empty database', () => {
  migrate();
  const db = getDb();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  for (const expected of [
    'sessions', 'samples', 'container_samples', 'service_samples',
    'users', 'settings', 'activity_events', 'auth_sessions', 'schema_migrations',
    'resources', 'resource_relationships',
    'incidents', 'incident_evidence', 'incident_actions',
    'tool_executions', 'ai_runs'
  ]) {
    assert.ok(tables.includes(expected), `missing table "${expected}"`);
  }
});

test('migrate() is idempotent — a second run applies nothing new', () => {
  migrate();
  const db = getDb();
  const appliedCount = db.prepare('SELECT COUNT(*) c FROM schema_migrations').get().c;
  const fileCount = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).length;
  assert.equal(appliedCount, fileCount);
});

test('migrate() does not touch existing data in already-migrated tables', () => {
  const db = getDb();
  db.prepare('INSERT INTO sessions (name, start_time) VALUES (?, ?)').run('pre-existing session', Date.now());
  const before = db.prepare('SELECT COUNT(*) c FROM sessions').get().c;

  migrate();

  const after2 = db.prepare('SELECT COUNT(*) c FROM sessions').get().c;
  assert.equal(after2, before);
});

test('a resource can have at most one open (non-terminal) incident at a time', () => {
  const db = getDb();
  const now = Date.now();
  const resourceId = db.prepare(
    'INSERT INTO resources (type, external_id, name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)'
  ).run('container', 'demo-db', 'demo-db', now, now).lastInsertRowid;

  const insertIncident = (status) => db.prepare(`
    INSERT INTO incidents (resource_id, status, trigger_rule, trigger_summary, detected_at, updated_at)
    VALUES (?, ?, 'container_exit', 'test', ?, ?)
  `).run(resourceId, status, now, now);

  insertIncident('DETECTED');
  assert.throws(() => insertIncident('INVESTIGATING'), /UNIQUE constraint failed/);

  // A second incident for the same resource is fine once the first is terminal.
  db.prepare("UPDATE incidents SET status = 'RESOLVED' WHERE resource_id = ?").run(resourceId);
  assert.doesNotThrow(() => insertIncident('DETECTED'));
});
