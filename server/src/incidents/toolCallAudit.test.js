'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = path.join(os.tmpdir(), `sentinel-test-toolcallaudit-${crypto.randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { migrate } = require('../db/migrate');
const { getDb } = require('../db/connection');
const { _setClientForTesting, _resetClientForTesting } = require('../agent/client');
const { callToolAudited } = require('./toolCallAudit');

before(() => migrate());
after(() => {
  _resetClientForTesting();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(DB_PATH + suffix); } catch { /* already gone */ }
  }
});

test('a successful call is recorded with status ok and the real result', async () => {
  _setClientForTesting({ callTool: async () => ({ state: 'running' }) });
  const result = await callToolAudited(null, 'get_container_status', { id: 'x' }, { requestedBy: 'context' });
  assert.deepEqual(result, { state: 'running' });

  const row = getDb().prepare('SELECT * FROM tool_executions ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.tool_name, 'get_container_status');
  assert.equal(row.status, 'ok');
  assert.equal(row.requested_by, 'context');
  assert.deepEqual(JSON.parse(row.result_json), { state: 'running' });
});

test('a failing call is recorded with status error and rethrows', async () => {
  _setClientForTesting({ callTool: async () => { throw new Error('agent unreachable'); } });
  await assert.rejects(
    callToolAudited(null, 'get_container_status', { id: 'x' }, { requestedBy: 'context' }),
    /agent unreachable/
  );
  const row = getDb().prepare('SELECT * FROM tool_executions ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.status, 'error');
  assert.equal(row.error, 'agent unreachable');
});

test('the approved flag is forwarded to the agent client and recorded', async () => {
  let sawApproved;
  _setClientForTesting({ callTool: async (name, params, opts) => { sawApproved = opts?.approved; return {}; } });
  await callToolAudited(null, 'restart_container', { id: 'x' }, { requestedBy: 'remediation', approved: true });
  assert.equal(sawApproved, true);
  const row = getDb().prepare('SELECT * FROM tool_executions ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.approved, 1);
});
