'use strict';

const { getDb } = require('../db/connection');
const { findRecentDeployForResource } = require('../context/deployCorrelation');
const { getDetectorConfig } = require('../settings/detectorConfig');

/**
 * Learned runbooks: for problems Sentinel has already fixed the same way
 * more than once, propose that exact fix again without asking the AI —
 * "for common problems it should not rely on AI anyway."
 *
 * A derived query over existing `incident_actions`/`incidents`/`resources`
 * rather than a new table: at personal-VPS incident volumes this touches
 * at most a few hundred rows ever, and a cache table would need its own
 * invalidation story (when does a cached runbook go stale?) for no real
 * benefit. Migration 016 adds the two indexes this query pattern wants.
 */

const RUNBOOK_MIN_SUCCESSES = 2;
const RUNBOOK_MIN_SUCCESS_RATIO = 2 / 3;

/**
 * Tools whose full params can be reconstructed from the resource alone —
 * the only tools a runbook can safely propose blind. Deliberately
 * excludes `deploy_repository` (a blind redeploy could ship unintended
 * code) and `rollback_repository` (its required `sha` cannot be derived
 * from a resource's identity the way `restart_container{id}` can — a
 * runbook has no way to know WHICH sha to propose without a fresh
 * deploy-correlation lookup, which is exactly what Feature 1 already
 * does at evidence-gathering time).
 */
const TOOL_RESOURCE_PARAM = Object.freeze({
  restart_service: 'service',
  start_service: 'service',
  stop_service: 'service',
  restart_container: 'id',
  start_container: 'id',
  stop_container: 'id'
});

/**
 * The best-track-record tool for this exact (trigger_rule, resource_type)
 * pair, or null if nothing qualifies. Only ever called with a resource
 * TYPE, not a specific resource — a runbook for "service_inactive on any
 * service" should apply to caddy AND cloudflared alike.
 */
function findRunbook(triggerRule, resourceType) {
  if (!triggerRule || !resourceType) return null;

  const rows = getDb().prepare(`
    SELECT a.tool_name AS tool,
           SUM(CASE WHEN i.status = 'RESOLVED' THEN 1 ELSE 0 END) AS successes,
           SUM(CASE WHEN i.status = 'FAILED'   THEN 1 ELSE 0 END) AS failures,
           MAX(a.executed_at) AS lastAt,
           MAX(CASE WHEN i.status = 'RESOLVED' THEN a.executed_at END) AS lastSuccessAt,
           AVG(CASE WHEN i.status = 'RESOLVED' THEN i.resolved_at - a.executed_at END) AS avgRecoveryMs
      FROM incident_actions a
      JOIN incidents i ON i.id = a.incident_id
      JOIN resources r ON r.id = i.resource_id
     WHERE i.trigger_rule = ? AND r.type = ? AND a.status = 'executed'
       AND i.status IN ('RESOLVED', 'FAILED')
     GROUP BY a.tool_name
     ORDER BY successes DESC, lastAt DESC
  `).all(triggerRule, resourceType);

  for (const row of rows) {
    if (!(row.tool in TOOL_RESOURCE_PARAM)) continue;
    if (row.successes < RUNBOOK_MIN_SUCCESSES) continue;

    const total = row.successes + row.failures;
    if (row.successes / total < RUNBOOK_MIN_SUCCESS_RATIO) continue;

    // The most recent attempt of this tool must itself have been a
    // success — a tool with an old winning streak that has since
    // started failing must not keep getting proposed as "known good"
    // just because its LIFETIME ratio still clears the bar.
    if (row.lastAt !== row.lastSuccessAt) continue;

    return {
      tool: row.tool,
      paramKey: TOOL_RESOURCE_PARAM[row.tool],
      successes: row.successes,
      failures: row.failures,
      total,
      avgRecoveryMs: row.avgRecoveryMs != null ? Math.round(row.avgRecoveryMs) : null
    };
  }
  return null;
}

/**
 * The runbook check for a real incident, wrapping `findRunbook` with the
 * one safety gate that needs an actual incident+resource to evaluate: a
 * tool that's fixed this before is not trustworthy the one time a recent
 * deploy is the actual cause. If a deploy correlates, the runbook check
 * is skipped entirely — the incident falls through to the normal AI/
 * Deploy-Correlation path instead, which is what Feature 1 already
 * decides to do here.
 */
function findRunbookForIncident(incident, resource) {
  const windowMs = getDetectorConfig().deployCorrelationWindowMs;
  if (findRecentDeployForResource(resource, incident.detected_at, windowMs)) return null;
  return findRunbook(incident.trigger_rule, resource?.type);
}

module.exports = { findRunbook, findRunbookForIncident, TOOL_RESOURCE_PARAM, RUNBOOK_MIN_SUCCESSES, RUNBOOK_MIN_SUCCESS_RATIO };
