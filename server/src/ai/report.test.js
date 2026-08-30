'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = path.join(os.tmpdir(), `sentinel-test-report-${crypto.randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;
process.env.SENTINEL_SECRET_KEY = crypto.randomBytes(32).toString('hex');

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { migrate } = require('../db/migrate');
const { getDb } = require('../db/connection');
const { upsertResource } = require('../graph/resources');
const { setAIConfig, clearAIConfig } = require('../settings/aiConfig');
const { _setProviderForTesting, _resetProviderForTesting } = require('./provider');
const store = require('../incidents/store');
const { generateReport, getReport, renderReportMarkdown, buildReportMessage } = require('./report');

// A credential that fails with a rate-limit-shaped error is put into a
// real cooldown (settings/aiCredentials.js) and skipped on later calls —
// correct in production, but it would leak between tests here, since one
// test below deliberately fails with "quota exhausted".
beforeEach(() => {
  const { listCredentials, clearHealth } = require('../settings/aiCredentials');
  for (const c of listCredentials()) clearHealth(c.id);
});

before(() => {
  migrate();
  setAIConfig({ provider: 'anthropic', model: 'test-model', apiKey: 'sk-test-key' });
});
after(() => {
  _resetProviderForTesting();
  clearAIConfig();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(DB_PATH + suffix); } catch { /* already gone */ }
  }
});

const GOOD_REPORT = {
  title: 'demo-db exited and took demo-api with it',
  summary: 'demo-db exited with code 1 at 02:14; demo-api became unhealthy 20s later.',
  impact: 'The demo stack was unavailable for about 3 minutes.',
  rootCause: 'demo-db was OOM-killed; its memory limit was lower than its steady-state usage.',
  resolution: 'Sentinel restarted demo-db and verified it reached running.',
  timeline: ['02:14 demo-db exited (1)', '02:17 restart verified'],
  prevention: ['Raise demo-db memory limit to 512Mi', 'Add a healthcheck to demo-api']
};

function fixedProvider(payload) {
  return {
    chat: async () => ({
      text: typeof payload === 'string' ? payload : JSON.stringify(payload),
      toolCalls: [],
      usage: { promptTokens: 800, completionTokens: 200 }
    })
  };
}

function closedIncident(finalStatus = 'RESOLVED') {
  const resource = upsertResource({ type: 'container', externalId: 'rep-' + crypto.randomUUID(), name: 'demo-db' });
  const incident = store.createIncident({ resourceId: resource.id, severity: 'high', triggerRule: 'container_exit', triggerSummary: 'exited (1)' });
  store.addEvidence(incident.id, [{ resourceId: resource.id, sourceTool: 'get_container_logs', summary: 'OOM', data: null }]);
  store.updateIncidentStatus(incident.id, 'INVESTIGATING');
  store.updateIncidentStatus(incident.id, 'DIAGNOSED');
  store.updateIncidentStatus(incident.id, 'AWAITING_APPROVAL');
  store.updateIncidentStatus(incident.id, 'REMEDIATING');
  store.updateIncidentStatus(incident.id, 'VERIFYING');
  store.recordResolution(incident.id, finalStatus);
  return store.getIncident(incident.id);
}

test('a valid report is stored on the incident and readable back', async () => {
  _setProviderForTesting(fixedProvider(GOOD_REPORT));
  const incident = closedIncident();

  const result = await generateReport(incident.id);
  assert.equal(result.ok, true);
  assert.equal(result.report.rootCause, GOOD_REPORT.rootCause);

  const stored = getReport(incident.id);
  assert.equal(stored.report.title, GOOD_REPORT.title);
  assert.ok(stored.generatedAt > 0);
});

test('the report round trip is recorded in ai_runs with purpose=report', async () => {
  _setProviderForTesting(fixedProvider(GOOD_REPORT));
  const incident = closedIncident();
  await generateReport(incident.id);

  const rows = getDb().prepare("SELECT * FROM ai_runs WHERE incident_id = ? AND purpose = 'report'").all(incident.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].error, null);
  assert.equal(rows[0].prompt_tokens, 800);
});

test('a provider failure leaves the incident untouched and reports the error', async () => {
  // A report is a document for a human — nothing downstream acts on it,
  // so failing to write one must never change the incident's outcome.
  _setProviderForTesting({ chat: async () => { throw new Error('quota exhausted'); } });
  const incident = closedIncident('RESOLVED');

  const result = await generateReport(incident.id);
  assert.equal(result.ok, false);
  assert.match(result.error, /quota exhausted/);

  const after = store.getIncident(incident.id);
  assert.equal(after.status, 'RESOLVED');
  assert.equal(getReport(incident.id), null);

  const runs = getDb().prepare("SELECT * FROM ai_runs WHERE incident_id = ? AND purpose = 'report'").all(incident.id);
  assert.match(runs[0].error, /quota exhausted/);
});

test('a non-JSON response is rejected without storing anything', async () => {
  _setProviderForTesting(fixedProvider('Here is your report! ```markdown ...'));
  const incident = closedIncident();

  const result = await generateReport(incident.id);
  assert.equal(result.ok, false);
  assert.match(result.error, /valid JSON/);
  assert.equal(getReport(incident.id), null);
});

test('a schema-invalid report is rejected without storing anything', async () => {
  _setProviderForTesting(fixedProvider({ summary: 'something happened' })); // no rootCause
  const incident = closedIncident();

  const result = await generateReport(incident.id);
  assert.equal(result.ok, false);
  assert.match(result.error, /validation/i);
  assert.equal(getReport(incident.id), null);
});

test('generateReport refuses cleanly with no provider configured', async () => {
  clearAIConfig();
  const prev = process.env.AI_API_KEY;
  delete process.env.AI_API_KEY;
  try {
    const incident = closedIncident();
    const result = await generateReport(incident.id);
    assert.equal(result.ok, false);
    assert.match(result.error, /No AI provider configured/);
  } finally {
    if (prev) process.env.AI_API_KEY = prev;
    setAIConfig({ provider: 'anthropic', model: 'test-model', apiKey: 'sk-test-key' });
  }
});

test('generateReport reports a missing incident rather than throwing', async () => {
  const result = await generateReport(999999);
  assert.equal(result.ok, false);
  assert.match(result.error, /not found/);
});

test('renderReportMarkdown produces every section it was given', () => {
  const incident = { id: 42, status: 'RESOLVED', detected_at: 1000, resolved_at: 5000 };
  const md = renderReportMarkdown(GOOD_REPORT, incident);

  assert.match(md, /^# demo-db exited and took demo-api with it/);
  assert.match(md, /## Summary/);
  assert.match(md, /## Impact/);
  assert.match(md, /## Root cause/);
  assert.match(md, /## Resolution/);
  assert.match(md, /- 02:14 demo-db exited \(1\)/);
  assert.match(md, /- Raise demo-db memory limit to 512Mi/);
  assert.match(md, /\*\*Status:\*\* RESOLVED/);
});

test('renderReportMarkdown omits sections a terse model left out', () => {
  const md = renderReportMarkdown({ summary: 's', rootCause: 'r' }, { id: 1, status: 'FAILED', detected_at: 1 });
  assert.match(md, /## Summary/);
  assert.match(md, /## Root cause/);
  assert.ok(!md.includes('## Prevention'));
  assert.ok(!md.includes('## Timeline'));
  assert.ok(!md.includes('## Impact'));
});

test('the prompt carries the real evidence, actions and final status', () => {
  const resource = upsertResource({ type: 'container', externalId: 'msg-' + crypto.randomUUID(), name: 'demo-db' });
  const incident = store.createIncident({ resourceId: resource.id, triggerRule: 'container_oom', triggerSummary: 'oom killed' });
  const evidence = [{ source_tool: 'get_container_logs', summary: 'out of memory' }];
  const actions = [{ tool_name: 'restart_container', real_risk: 'MEDIUM_RISK', status: 'executed', approved_via: 'auto', error: null }];

  const msg = buildReportMessage(store.getIncident(incident.id), resource, evidence, actions, []);
  assert.match(msg, /container_oom/);
  assert.match(msg, /out of memory/);
  assert.match(msg, /restart_container \(MEDIUM_RISK\) — executed approved via auto/);
  assert.match(msg, /demo-db \(container\)/);
});
