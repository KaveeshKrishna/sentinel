'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = path.join(os.tmpdir(), `sentinel-test-activity-${crypto.randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { migrate } = require('../db/migrate');
const { getDb } = require('../db/connection');
const { logEvent, getEvents, pruneEvents, MAX_ACTIVITY_EVENTS } = require('./logger');

before(() => migrate());
beforeEach(() => getDb().prepare('DELETE FROM activity_events').run());
after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(DB_PATH + suffix); } catch { /* already gone */ }
  }
});

function count() {
  return getDb().prepare('SELECT COUNT(*) c FROM activity_events').get().c;
}

test('an event round-trips with its display metadata attached', () => {
  logEvent('DOCKER_STOP', 'stopped demo-api', { container: 'demo-api' });
  const [event] = getEvents();
  assert.equal(event.type, 'DOCKER_STOP');
  assert.equal(event.message, 'stopped demo-api');
  assert.deepEqual(event.details, { container: 'demo-api' });
  assert.equal(event.icon, 'square');
});

test('an unknown event type still logs, with a generic icon', () => {
  logEvent('SOMETHING_NEW', 'a type nobody registered');
  assert.equal(getEvents()[0].icon, '•');
});

test('the timeline never grows past the cap, however many events arrive', () => {
  for (let i = 0; i < MAX_ACTIVITY_EVENTS + 40; i++) logEvent('LOGIN', `event ${i}`);
  assert.equal(count(), MAX_ACTIVITY_EVENTS);
});

test('pruning keeps the NEWEST events and drops the oldest', () => {
  for (let i = 0; i < MAX_ACTIVITY_EVENTS + 10; i++) logEvent('LOGIN', `event ${i}`);

  const messages = getEvents().map(e => e.message);
  assert.equal(messages[0], `event ${MAX_ACTIVITY_EVENTS + 9}`, 'newest first');
  assert.equal(
    messages[messages.length - 1], `event ${10}`,
    'the oldest 10 were discarded, not the newest'
  );
  assert.ok(!messages.includes('event 9'));
});

test('a table already over the cap (an install upgrading from the unbounded version) is trimmed', () => {
  const insert = getDb().prepare('INSERT INTO activity_events (type, message, details, timestamp) VALUES (?, ?, ?, ?)');
  for (let i = 0; i < 500; i++) insert.run('LOGIN', `legacy ${i}`, null, Date.now());
  assert.equal(count(), 500);

  // The boot-time SYSTEM_START event is what triggers this in production.
  const deleted = pruneEvents();
  assert.equal(deleted, 500 - MAX_ACTIVITY_EVENTS);
  assert.equal(count(), MAX_ACTIVITY_EVENTS);
  assert.equal(getEvents()[0].message, 'legacy 499', 'the most recent history survived the trim');
});

test('pruning an under-cap table is a no-op, not a truncation', () => {
  for (let i = 0; i < 5; i++) logEvent('LOGIN', `event ${i}`);
  assert.equal(pruneEvents(), 0);
  assert.equal(count(), 5);
});

test('getEvents never returns more than the cap even when asked for more', () => {
  for (let i = 0; i < MAX_ACTIVITY_EVENTS; i++) logEvent('LOGIN', `event ${i}`);
  assert.equal(getEvents(500).length, MAX_ACTIVITY_EVENTS);
  assert.equal(getEvents(5).length, 5, 'a smaller explicit limit is still honoured');
});
