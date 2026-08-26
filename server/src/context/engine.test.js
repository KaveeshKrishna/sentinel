'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = path.join(os.tmpdir(), `sentinel-test-context-${crypto.randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { migrate } = require('../db/migrate');
const { getDb } = require('../db/connection');
const { registerRelationship } = require('../graph/relationships');
const { upsertResource } = require('../graph/resources');
const { _setClientForTesting, _resetClientForTesting } = require('../agent/client');
const { gatherEvidence, MAX_EVIDENCE_ROWS } = require('./engine');

before(() => migrate());
after(() => {
  _resetClientForTesting();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(DB_PATH + suffix); } catch { /* already gone */ }
  }
});

function makeIncidentFor(resourceId) {
  const db = getDb();
  const now = Date.now();
  return db.prepare(`
    INSERT INTO incidents (resource_id, status, trigger_rule, trigger_summary, detected_at, updated_at)
    VALUES (?, 'INVESTIGATING', 'container_exit', 'exited', ?, ?)
  `).run(resourceId, now, now).lastInsertRowid;
}

test('gathers per-type evidence for the incident resource and its neighbour, plus git status', async () => {
  const { from: api } = registerRelationship(
    { type: 'container', externalId: 'demo-api-' + crypto.randomUUID(), name: 'demo-api' },
    { type: 'container', externalId: 'demo-db-' + crypto.randomUUID(), name: 'demo-db' },
    'depends_on'
  );
  const incidentId = makeIncidentFor(api.id);

  _setClientForTesting({
    callTool: async (name) => {
      if (name === 'get_container_status') return { name: 'x', state: { Running: false }, restartCount: 0 };
      if (name === 'get_container_logs') return [{ stream: 'stderr', text: 'ECONNREFUSED' }];
      if (name === 'inspect_git_status') return [];
      throw new Error(`unexpected tool ${name}`);
    }
  });

  const evidence = await gatherEvidence({ id: incidentId, resource_id: api.id });
  const tools = evidence.map(e => e.sourceTool);
  assert.ok(tools.includes('get_container_status'));
  assert.ok(tools.includes('get_container_logs'));
  assert.ok(tools.includes('inspect_git_status'));
  // Two tools each for demo-api and its one neighbour demo-db = 4, + git status = 5
  assert.equal(evidence.length, 5);
  assert.ok(evidence.length <= MAX_EVIDENCE_ROWS);
});

test('bounds neighbours to at most 2 even when more are registered', async () => {
  const apiRef = { type: 'container', externalId: 'multi-api-' + crypto.randomUUID(), name: 'multi-api' };
  for (let i = 0; i < 5; i++) {
    registerRelationship(apiRef, { type: 'container', externalId: `dep-${i}-${crypto.randomUUID()}`, name: `dep-${i}` }, 'depends_on');
  }
  const api = upsertResource(apiRef);
  const incidentId = makeIncidentFor(api.id);

  _setClientForTesting({
    callTool: async (name) => {
      if (name === 'get_container_status') return { name: 'x', state: {}, restartCount: 0 };
      if (name === 'get_container_logs') return [];
      if (name === 'inspect_git_status') return [];
      throw new Error(`unexpected tool ${name}`);
    }
  });

  const evidence = await gatherEvidence({ id: incidentId, resource_id: api.id });
  // self (2 rows) + at most 2 neighbours (2 rows each = 4) + git status (1) = 7
  assert.equal(evidence.length, 7);
});

test('a tool failure produces an evidence row describing the failure, not a thrown error', async () => {
  const api = upsertResource({ type: 'container', externalId: 'fails-' + crypto.randomUUID(), name: 'fails' });
  const incidentId = makeIncidentFor(api.id);

  _setClientForTesting({ callTool: async () => { throw new Error('agent down'); } });

  const evidence = await gatherEvidence({ id: incidentId, resource_id: api.id });
  assert.ok(evidence.some(e => e.summary.includes('agent down')));
});
