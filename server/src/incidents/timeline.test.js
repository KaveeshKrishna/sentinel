'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = path.join(os.tmpdir(), `sentinel-test-timeline-${crypto.randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { migrate } = require('../db/migrate');
const { getDb } = require('../db/connection');
const { upsertResource } = require('../graph/resources');
const store = require('./store');
const { getTimeline, getTransitions, rollupPhases, PHASES } = require('./timeline');

before(() => migrate());
after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(DB_PATH + suffix); } catch { /* already gone */ }
  }
});

function makeIncident(triggerRule = 'container_exit') {
  const resource = upsertResource({ type: 'container', externalId: 'r-' + crypto.randomUUID(), name: 'demo-api' });
  return store.createIncident({ resourceId: resource.id, triggerRule, triggerSummary: 'exited 1' });
}

test('createIncident records the opening null -> DETECTED transition', () => {
  const incident = makeIncident();
  const rows = getTransitions(incident.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].from_status, null);
  assert.equal(rows[0].to_status, 'DETECTED');
});

test('every status change appends a transition row with its real predecessor', () => {
  const incident = makeIncident();
  store.updateIncidentStatus(incident.id, 'INVESTIGATING');
  store.updateIncidentStatus(incident.id, 'DIAGNOSED');
  store.updateIncidentStatus(incident.id, 'AWAITING_APPROVAL');

  const rows = getTransitions(incident.id);
  assert.deepEqual(rows.map(r => r.to_status), ['DETECTED', 'INVESTIGATING', 'DIAGNOSED', 'AWAITING_APPROVAL']);
  assert.deepEqual(rows.map(r => r.from_status), [null, 'DETECTED', 'INVESTIGATING', 'DIAGNOSED']);
});

test('an illegal transition records nothing', () => {
  const incident = makeIncident();
  assert.throws(() => store.updateIncidentStatus(incident.id, 'RESOLVED'), { name: 'IllegalTransitionError' });
  assert.equal(getTransitions(incident.id).length, 1); // just the DETECTED row
});

test('deleting an incident cascades its timeline rows away', () => {
  const incident = makeIncident();
  store.updateIncidentStatus(incident.id, 'INVESTIGATING');
  assert.equal(getTransitions(incident.id).length, 2);
  store.deleteIncident(incident.id);
  assert.equal(getTransitions(incident.id).length, 0);
});

test('getTimeline merges transitions, tool calls, AI attempts and actions in time order', () => {
  const incident = makeIncident();
  const db = getDb();

  store.updateIncidentStatus(incident.id, 'INVESTIGATING');
  db.prepare(`
    INSERT INTO tool_executions (incident_id, tool_name, params_json, real_risk, approved, requested_by,
                                 status, started_at, finished_at, duration_ms)
    VALUES (?, 'get_container_logs', '{}', 'READ_ONLY', 0, 'context', 'ok', ?, ?, 40)
  `).run(incident.id, Date.now(), Date.now());
  db.prepare(`
    INSERT INTO ai_runs (incident_id, purpose, provider, model, attempt, latency_ms, created_at,
                         prompt_tokens, completion_tokens, raw_response)
    VALUES (?, 'diagnosis', 'gemini', 'gemini-2.0-flash', 1, 900, ?, 120, 45, 'SHOULD NOT LEAK')
  `).run(incident.id, Date.now());
  store.updateIncidentStatus(incident.id, 'DIAGNOSED');
  store.addAction(incident.id, { tool: 'restart_container', params: { id: 'demo-api' }, claimedRisk: 'LOW_RISK', realRisk: 'MEDIUM_RISK', rationale: 'it exited' });

  const { entries } = getTimeline(incident.id, store.getIncident(incident.id));

  const kinds = new Set(entries.map(e => e.kind));
  assert.deepEqual([...kinds].sort(), ['action', 'ai', 'tool', 'transition']);

  for (let i = 1; i < entries.length; i++) {
    assert.ok(entries[i].at >= entries[i - 1].at, 'entries must be ascending by timestamp');
  }

  // ai_runs.raw_response can be many KB per attempt — the timeline is a
  // summary view and must never carry it.
  assert.ok(!JSON.stringify(entries).includes('SHOULD NOT LEAK'));

  const ai = entries.find(e => e.kind === 'ai');
  assert.equal(ai.phase, 'DIAGNOSE');
  assert.equal(ai.ok, true);
  assert.equal(ai.promptTokens, 120);

  const tool = entries.find(e => e.kind === 'tool');
  assert.equal(tool.phase, 'OBSERVE'); // requested_by 'context'
  assert.equal(tool.durationMs, 40);

  assert.equal(entries.find(e => e.kind === 'action').phase, 'PLAN');
});

test('an approved READ_ONLY investigation is tagged OBSERVE, a remediation ACT', () => {
  const incident = makeIncident();
  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO tool_executions (incident_id, tool_name, params_json, real_risk, approved, requested_by,
                                 status, started_at, finished_at, duration_ms)
    VALUES (?, ?, '{}', ?, 1, ?, 'ok', ?, ?, 5)
  `);
  insert.run(incident.id, 'get_service_logs', 'READ_ONLY', 'investigation', 1000, 1005);
  insert.run(incident.id, 'restart_service', 'MEDIUM_RISK', 'remediation', 2000, 2005);

  const { entries } = getTimeline(incident.id, store.getIncident(incident.id));
  const byTool = Object.fromEntries(entries.filter(e => e.kind === 'tool').map(e => [e.tool, e.phase]));
  assert.equal(byTool.get_service_logs, 'OBSERVE');
  assert.equal(byTool.restart_service, 'ACT');
});

test('an incident with no recorded transitions still renders a synthesized history', () => {
  // Incidents created before migration 010 have no rows in
  // incident_timeline; the reader must approximate rather than render
  // an empty strip, and must say that it did.
  const incident = makeIncident();
  getDb().prepare('DELETE FROM incident_timeline WHERE incident_id = ?').run(incident.id);
  getDb().prepare("UPDATE incidents SET status = 'RESOLVED', resolved_at = ? WHERE id = ?")
    .run(incident.detected_at + 5000, incident.id);

  const { entries } = getTimeline(incident.id, store.getIncident(incident.id));
  const transitions = entries.filter(e => e.kind === 'transition');
  assert.equal(transitions.length, 2);
  assert.ok(transitions.every(t => t.synthesized === true));
  assert.deepEqual(transitions.map(t => t.to), ['DETECTED', 'RESOLVED']);
});

test('rollupPhases marks reached-but-empty stages skipped, not pending', () => {
  // An incident whose only approved action was a READ_ONLY investigation
  // never enters ACT. Showing that as "pending" while VERIFY is done
  // would misrepresent what happened.
  const entries = [
    { phase: 'OBSERVE', at: 1 },
    { phase: 'DIAGNOSE', at: 2 },
    { phase: 'VERIFY', at: 3 }
  ];
  const phases = rollupPhases(entries, { status: 'RESOLVED' });
  assert.deepEqual(phases.map(p => p.status), ['done', 'done', 'skipped', 'skipped', 'done']);
  assert.deepEqual(phases.map(p => p.phase), PHASES);
});

test('rollupPhases marks the furthest stage active while open and failed on FAILED', () => {
  const entries = [{ phase: 'OBSERVE', at: 1 }, { phase: 'DIAGNOSE', at: 2 }];
  assert.equal(rollupPhases(entries, { status: 'INVESTIGATING' })[1].status, 'active');
  assert.equal(rollupPhases(entries, { status: 'FAILED' })[1].status, 'failed');
  assert.equal(rollupPhases(entries, { status: 'INVESTIGATING' })[2].status, 'pending');
});
