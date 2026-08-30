'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = path.join(os.tmpdir(), `sentinel-test-localtools-${crypto.randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;
process.env.SENTINEL_SECRET_KEY = crypto.randomBytes(32).toString('hex');

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { migrate } = require('../db/migrate');
const { getDb } = require('../db/connection');
const { listLocalTools, isLocalTool, callLocalTool } = require('./localTools');
const { setAccessScope } = require('../settings/accessScope');
const recordingDb = require('../recording/db');

before(() => migrate());
beforeEach(() => {
  getDb().prepare("DELETE FROM settings WHERE key LIKE 'access.%'").run();
});
after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(DB_PATH + suffix); } catch { /* already gone */ }
  }
});

test('every local tool is READ_ONLY — there is no write path into Sentinel\'s own data', () => {
  const tools = listLocalTools();
  assert.ok(tools.length > 0);
  for (const tool of tools) assert.equal(tool.risk, 'READ_ONLY', `${tool.name} must be READ_ONLY`);
});

test('turning off own-data access removes the tools entirely, not just their answers', () => {
  setAccessScope({ ownData: false });
  assert.deepEqual(listLocalTools(), [], 'a disabled capability should not even be advertised');
  assert.equal(isLocalTool('list_recording_sessions'), false);
  // ...and calling it directly is still refused, not merely un-suggested.
  return assert.rejects(() => callLocalTool('list_recording_sessions', {}), /Unknown local tool/);
});

test('a recording session can be summarised — the question that motivated all this', async () => {
  const session = recordingDb.createSession('2026-08-29T15:19');
  recordingDb.saveSample(session.id ?? session,
    { cpu: { usage: 20 }, ram: { percent: 40 }, load: { load1: 0.5 } }, [], []);

  const list = await callLocalTool('list_recording_sessions', {});
  assert.ok(list.length >= 1);

  // Referred to by name, the way the Recordings page labels it — an id
  // is not what an operator has in front of them.
  const summary = await callLocalTool('get_recording_session', { name: '2026-08-29T15:19' });
  assert.equal(summary.name, '2026-08-29T15:19');
  assert.ok(summary.sampleCount >= 1);
});

test('a partial session name still resolves', async () => {
  recordingDb.createSession('nightly-backup-run');
  const summary = await callLocalTool('get_recording_session', { name: 'nightly' });
  assert.equal(summary.name, 'nightly-backup-run');
});

test('an unmatched session name lists what IS available instead of a bare failure', async () => {
  recordingDb.createSession('some-real-session');
  await assert.rejects(
    () => callLocalTool('get_recording_session', { name: 'no-such-session' }),
    /Available:.*some-real-session/s
  );
});

test('incidents and activity are queryable', async () => {
  const { upsertResource } = require('../graph/resources');
  const store = require('../incidents/store');
  const { logEvent } = require('../activity/logger');

  const r = upsertResource({ type: 'service', externalId: 'caddy-lt-' + crypto.randomUUID(), name: 'caddy' });
  store.createIncident({ resourceId: r.id, severity: 'high', triggerRule: 'service_inactive', triggerSummary: 'caddy is down' });
  logEvent('SERVICE_STOP', 'caddy stopped by hand');

  const incidents = await callLocalTool('list_incidents', {});
  assert.ok(incidents.some(i => i.summary === 'caddy is down'));

  const activity = await callLocalTool('search_activity', { query: 'caddy' });
  assert.ok(activity.some(e => e.message.includes('caddy stopped by hand')));
});
