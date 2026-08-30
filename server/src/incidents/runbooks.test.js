'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = path.join(os.tmpdir(), `sentinel-test-runbooks-${crypto.randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { migrate } = require('../db/migrate');
const { getDb } = require('../db/connection');
const { upsertResource } = require('../graph/resources');
const { findRunbook, findRunbookForIncident, TOOL_RESOURCE_PARAM } = require('./runbooks');

before(() => migrate());
after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(DB_PATH + suffix); } catch { /* already gone */ }
  }
});

/**
 * Seed a resolved-or-failed incident with one executed action, entirely
 * via raw SQL — bypassing the state machine's transition guard, which
 * would otherwise require walking every legal state in order just to
 * test a pure SQL query. This matches the codebase's existing precedent
 * (detector.test.js's own raw-SQL seeding for backdated timestamps).
 */
function seedIncident({ triggerRule, resourceType, toolName, outcome, executedAt, resolvedAt }) {
  const db = getDb();
  const resource = upsertResource({ type: resourceType, externalId: 'rb-' + crypto.randomUUID(), name: 'x' });
  const now = Date.now();
  const incidentId = db.prepare(`
    INSERT INTO incidents (resource_id, status, trigger_rule, trigger_summary, detected_at, updated_at, resolved_at)
    VALUES (?, ?, ?, 'x', ?, ?, ?)
  `).run(resource.id, outcome, triggerRule, now, now, resolvedAt ?? null).lastInsertRowid;

  db.prepare(`
    INSERT INTO incident_actions (incident_id, tool_name, params_json, real_risk, status, created_at, executed_at)
    VALUES (?, ?, '{}', 'MEDIUM_RISK', 'executed', ?, ?)
  `).run(incidentId, toolName, now, executedAt);

  return { incidentId, resource };
}

// ── Core matching rules ──────────────────────────────────────────────────

test('2 successes and nothing else is enough to match', () => {
  const rule = 'service_inactive-' + crypto.randomUUID();
  seedIncident({ triggerRule: rule, resourceType: 'service', toolName: 'restart_service', outcome: 'RESOLVED', executedAt: 1000, resolvedAt: 1500 });
  seedIncident({ triggerRule: rule, resourceType: 'service', toolName: 'restart_service', outcome: 'RESOLVED', executedAt: 2000, resolvedAt: 2600 });

  const match = findRunbook(rule, 'service');
  assert.ok(match);
  assert.equal(match.tool, 'restart_service');
  assert.equal(match.successes, 2);
  assert.equal(match.failures, 0);
});

test('a single success does not match', () => {
  const rule = 'container_exit-' + crypto.randomUUID();
  seedIncident({ triggerRule: rule, resourceType: 'container', toolName: 'restart_container', outcome: 'RESOLVED', executedAt: 1000, resolvedAt: 1200 });
  assert.equal(findRunbook(rule, 'container'), null);
});

test('a success ratio below 2/3 does not match, even with enough total successes', () => {
  const rule = 'container_unhealthy-' + crypto.randomUUID();
  // 2 successes, 2 failures = 50% — below the 2/3 floor.
  seedIncident({ triggerRule: rule, resourceType: 'container', toolName: 'restart_container', outcome: 'RESOLVED', executedAt: 1000, resolvedAt: 1200 });
  seedIncident({ triggerRule: rule, resourceType: 'container', toolName: 'restart_container', outcome: 'RESOLVED', executedAt: 2000, resolvedAt: 2200 });
  seedIncident({ triggerRule: rule, resourceType: 'container', toolName: 'restart_container', outcome: 'FAILED', executedAt: 3000 });
  seedIncident({ triggerRule: rule, resourceType: 'container', toolName: 'restart_container', outcome: 'FAILED', executedAt: 4000 });

  assert.equal(findRunbook(rule, 'container'), null);
});

test('a tool not in TOOL_RESOURCE_PARAM never matches, even with a perfect record', () => {
  const rule = 'container_exit-' + crypto.randomUUID();
  seedIncident({ triggerRule: rule, resourceType: 'container', toolName: 'deploy_repository', outcome: 'RESOLVED', executedAt: 1000, resolvedAt: 1100 });
  seedIncident({ triggerRule: rule, resourceType: 'container', toolName: 'deploy_repository', outcome: 'RESOLVED', executedAt: 2000, resolvedAt: 2100 });
  seedIncident({ triggerRule: rule, resourceType: 'container', toolName: 'deploy_repository', outcome: 'RESOLVED', executedAt: 3000, resolvedAt: 3100 });

  assert.equal(findRunbook(rule, 'container'), null, 'params cannot be safely reconstructed for this tool');
  assert.ok(!('deploy_repository' in TOOL_RESOURCE_PARAM));
});

test('the most-recent-attempt-failed guard refuses a stale winning streak', () => {
  const rule = 'service_inactive-' + crypto.randomUUID();
  // 3 old successes, then the most recent 2 attempts both failed — the
  // lifetime ratio (3/5 = 60%... actually let's make it clearly qualify
  // on ratio but fail on recency) is engineered below.
  seedIncident({ triggerRule: rule, resourceType: 'service', toolName: 'restart_service', outcome: 'RESOLVED', executedAt: 1000, resolvedAt: 1100 });
  seedIncident({ triggerRule: rule, resourceType: 'service', toolName: 'restart_service', outcome: 'RESOLVED', executedAt: 2000, resolvedAt: 2100 });
  seedIncident({ triggerRule: rule, resourceType: 'service', toolName: 'restart_service', outcome: 'RESOLVED', executedAt: 3000, resolvedAt: 3100 });
  seedIncident({ triggerRule: rule, resourceType: 'service', toolName: 'restart_service', outcome: 'FAILED', executedAt: 4000 });

  // Lifetime ratio is 3/4 = 75%, clears 2/3 — but the LAST attempt (at
  // 4000) failed, so this must not be proposed as "known good".
  assert.equal(findRunbook(rule, 'service'), null);
});

test('a tool that recovers after a failure (its most recent attempt succeeded) matches again', () => {
  const rule = 'service_inactive-' + crypto.randomUUID();
  seedIncident({ triggerRule: rule, resourceType: 'service', toolName: 'restart_service', outcome: 'RESOLVED', executedAt: 1000, resolvedAt: 1100 });
  seedIncident({ triggerRule: rule, resourceType: 'service', toolName: 'restart_service', outcome: 'FAILED', executedAt: 2000 });
  seedIncident({ triggerRule: rule, resourceType: 'service', toolName: 'restart_service', outcome: 'RESOLVED', executedAt: 3000, resolvedAt: 3200 });

  const match = findRunbook(rule, 'service');
  assert.ok(match, '2 successes / 3 total = 2/3, and the most recent attempt succeeded');
});

test('avgRecoveryMs is computed only over the successful attempts', () => {
  const rule = 'service_inactive-' + crypto.randomUUID();
  seedIncident({ triggerRule: rule, resourceType: 'service', toolName: 'restart_service', outcome: 'RESOLVED', executedAt: 1000, resolvedAt: 6000 }); // 5000ms
  seedIncident({ triggerRule: rule, resourceType: 'service', toolName: 'restart_service', outcome: 'RESOLVED', executedAt: 10000, resolvedAt: 13000 }); // 3000ms

  const match = findRunbook(rule, 'service');
  assert.equal(match.avgRecoveryMs, 4000);
});

test('a different resource type with an otherwise-identical trigger rule does not cross-match', () => {
  const rule = 'container_exit-' + crypto.randomUUID();
  seedIncident({ triggerRule: rule, resourceType: 'container', toolName: 'restart_container', outcome: 'RESOLVED', executedAt: 1000, resolvedAt: 1100 });
  seedIncident({ triggerRule: rule, resourceType: 'container', toolName: 'restart_container', outcome: 'RESOLVED', executedAt: 2000, resolvedAt: 2100 });

  assert.ok(findRunbook(rule, 'container'));
  assert.equal(findRunbook(rule, 'service'), null, 'a service history for the same trigger name would be a different rule in practice, but must not leak across types regardless');
});

// ── Deploy-correlation safety gate ───────────────────────────────────────

test('a recent deploy suppresses an otherwise-valid runbook match', () => {
  const rule = 'container_exit-' + crypto.randomUUID();
  const repoName = 'runbook-deploy-' + crypto.randomUUID();
  const { resource } = seedIncident({ triggerRule: rule, resourceType: 'container', toolName: 'restart_container', outcome: 'RESOLVED', executedAt: 1000, resolvedAt: 1100 });
  seedIncident({ triggerRule: rule, resourceType: 'container', toolName: 'restart_container', outcome: 'RESOLVED', executedAt: 2000, resolvedAt: 2100 });

  // Confirm the runbook alone WOULD match...
  assert.ok(findRunbook(rule, 'container'));

  // ...but findRunbookForIncident refuses when a deploy just happened for
  // THIS resource's repo — a tool that's fixed this 3 times before is not
  // trustworthy the one time a bad deploy is the actual cause.
  const resourceWithRepo = { ...resource, metadata: { composeProject: repoName } };
  getDb().prepare(`
    INSERT INTO deployments (repo_name, from_sha, to_sha, deployed_at, deployed_by, status, steps_json)
    VALUES (?, 'a', 'b', ?, 'user', 'success', '[]')
  `).run(repoName, Date.now() - 60000);

  const incident = { trigger_rule: rule, detected_at: Date.now() };
  assert.equal(findRunbookForIncident(incident, resourceWithRepo), null);
});

test('findRunbookForIncident matches normally when no deploy correlates', () => {
  const rule = 'service_inactive-' + crypto.randomUUID();
  seedIncident({ triggerRule: rule, resourceType: 'service', toolName: 'restart_service', outcome: 'RESOLVED', executedAt: 1000, resolvedAt: 1100 });
  seedIncident({ triggerRule: rule, resourceType: 'service', toolName: 'restart_service', outcome: 'RESOLVED', executedAt: 2000, resolvedAt: 2100 });

  const incident = { trigger_rule: rule, detected_at: Date.now() };
  const resource = { type: 'service', metadata: null };
  assert.ok(findRunbookForIncident(incident, resource));
});
