'use strict';

const { getDb } = require('../db/connection');
const { getSetting, setSetting } = require('../db/settings');

/**
 * Opt-in auto-remediation for named resources.
 *
 * This is the first path in Sentinel from "the AI proposed an action" to
 * "the action ran" without a human clicking approve, so the boundary is
 * deliberately drawn tighter than the general approval policy rather
 * than looser, in four independent ways. All four must pass:
 *
 *   1. The resource is explicitly opted in, by exact `type:externalId`.
 *      Empty by default. There is no wildcard and no "all services"
 *      switch — enabling this for something is always a deliberate,
 *      per-resource act.
 *   2. The proposed tool is in AUTO_REMEDIABLE_TOOLS below — a fixed,
 *      code-level allowlist of *restorative* operations (start/restart).
 *      It is not configurable at runtime, by design: a settings table an
 *      attacker (or a mistake) can write must never be able to widen
 *      what runs unattended. Note what is absent — every stop_*, every
 *      deploy, anything DESTRUCTIVE.
 *   3. The tool's *real* registered risk (from the agent's live catalog,
 *      never the model's claim) is at or below MAX_AUTO_RISK.
 *   4. The resource is under its rate limit. A service that fails
 *      immediately after every restart would otherwise be restarted
 *      forever; after MAX_AUTO_PER_WINDOW attempts the incident falls
 *      back to waiting for a human, which is the correct escalation —
 *      something auto-healing can't fix needs a person.
 *
 * Interaction with suppression.js worth knowing: stopping a service
 * through Sentinel's own UI suppresses detection for that window, so a
 * deliberate stop is not immediately undone. Once the window lapses,
 * an opted-in resource *will* be restarted — if you want it to stay
 * down, turn auto-remediation off for it first.
 */

// Restorative only. Deliberately code-level, not runtime-configurable.
const AUTO_REMEDIABLE_TOOLS = Object.freeze([
  'start_service',
  'restart_service',
  'start_container',
  'restart_container'
]);

// Even within the tool allowlist, never exceed this real risk level.
const MAX_AUTO_RISK = 'MEDIUM_RISK';
const RISK_ORDER = ['READ_ONLY', 'LOW_RISK', 'MEDIUM_RISK', 'HIGH_RISK', 'DESTRUCTIVE'];

const MAX_AUTO_PER_WINDOW = 3;
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

const SETTING_KEY = 'autoRemediate.resources';

const resourceKey = (type, externalId) => `${type}:${externalId}`;

/** @returns {string[]} opted-in resource keys, e.g. ['service:caddy']. */
function getAutoRemediateList() {
  const raw = getSetting(SETTING_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function setAutoRemediateList(keys) {
  if (!Array.isArray(keys)) throw new Error('Expected an array of resource keys');
  for (const key of keys) {
    if (typeof key !== 'string' || !/^[a-z]+:.+$/.test(key)) {
      throw new Error(`Invalid resource key "${key}" — expected "<type>:<externalId>"`);
    }
  }
  const unique = [...new Set(keys)];
  setSetting(SETTING_KEY, JSON.stringify(unique));
  return unique;
}

function isResourceEnabled(type, externalId) {
  return getAutoRemediateList().includes(resourceKey(type, externalId));
}

function isToolAutoRemediable(toolName, realRisk) {
  if (!AUTO_REMEDIABLE_TOOLS.includes(toolName)) return false;
  const idx = RISK_ORDER.indexOf(realRisk);
  return idx !== -1 && idx <= RISK_ORDER.indexOf(MAX_AUTO_RISK);
}

/**
 * How many actions have already been auto-approved for this resource in
 * the rate window. Counted from `incident_actions` joined to the
 * incident's resource, so it survives a restart — an in-memory counter
 * would reset exactly when a crash-looping service needs the limit most.
 *
 * Counts `approved_via = 'auto'` specifically, NOT `approved_by IS NULL`.
 * Those were the same thing until one-click approval from a notification
 * arrived: that path also has no user id, and a human deliberately
 * approving from their phone must not consume the budget meant to stop
 * *unattended* healing from looping. Rows predating migration 012 have
 * approved_via NULL, so the second clause keeps counting historical
 * machine approvals correctly.
 */
function countRecentAutoRemediations(resourceId) {
  const row = getDb().prepare(`
    SELECT COUNT(*) AS n
    FROM incident_actions a
    JOIN incidents i ON i.id = a.incident_id
    WHERE i.resource_id = ?
      AND (a.approved_via = 'auto' OR (a.approved_via IS NULL AND a.approved_by IS NULL))
      AND a.approved_at >= ?
      AND a.status IN ('approved', 'executed', 'failed')
  `).get(resourceId, Date.now() - RATE_WINDOW_MS);
  return row?.n ?? 0;
}

/**
 * The single decision point. Returns `{allowed, reason}` — `reason` is
 * always populated so the refusal can be logged and shown, rather than
 * an action silently not auto-running.
 */
function evaluateAutoRemediation({ resource, toolName, realRisk }) {
  if (!resource) return { allowed: false, reason: 'no resource' };

  if (!isResourceEnabled(resource.type, resource.external_id)) {
    return { allowed: false, reason: 'resource is not opted in to auto-remediation' };
  }
  if (!isToolAutoRemediable(toolName, realRisk)) {
    return { allowed: false, reason: `${toolName} (${realRisk}) is not an auto-remediable tool` };
  }
  const recent = countRecentAutoRemediations(resource.id);
  if (recent >= MAX_AUTO_PER_WINDOW) {
    return {
      allowed: false,
      reason: `rate limit reached (${recent}/${MAX_AUTO_PER_WINDOW} auto-remediations in the last hour) — escalating to a human`
    };
  }
  return { allowed: true, reason: `auto-remediation enabled for ${resourceKey(resource.type, resource.external_id)}` };
}

/**
 * The canonical restorative action for a deterministic "it isn't
 * running" trigger. `service_inactive` / `container_exit` /
 * `container_unhealthy` / `container_oom` are ground-truth signals from
 * systemd and Docker, not AI judgement — "restart it" is the obvious
 * response and does not depend on the model having proposed it. Used as
 * a fallback in maybeAutoRemediate when the diagnosis recommends no
 * restorative action (a weaker model often just recommends looking at
 * the logs). Still gated by every check in evaluateAutoRemediation —
 * opt-in, the tool allowlist, the risk ceiling, the rate limit.
 *
 * Deliberately absent: sustained_cpu / sustained_ram / disk_usage —
 * a restart is not a fix for those and there is no single obvious action.
 *
 * @returns {{tool: string, params: object}|null}
 */
const CANONICAL_REMEDIATION = {
  service_inactive: (r) => r.type === 'service' ? { tool: 'restart_service', params: { service: r.external_id } } : null,
  container_exit: (r) => r.type === 'container' ? { tool: 'restart_container', params: { id: r.external_id } } : null,
  container_unhealthy: (r) => r.type === 'container' ? { tool: 'restart_container', params: { id: r.external_id } } : null,
  container_oom: (r) => r.type === 'container' ? { tool: 'restart_container', params: { id: r.external_id } } : null
};

function canonicalRemediation(triggerRule, resource) {
  const fn = CANONICAL_REMEDIATION[triggerRule];
  return fn && resource ? fn(resource) : null;
}

module.exports = {
  canonicalRemediation,
  AUTO_REMEDIABLE_TOOLS, MAX_AUTO_RISK, MAX_AUTO_PER_WINDOW, RATE_WINDOW_MS,
  resourceKey, getAutoRemediateList, setAutoRemediateList, isResourceEnabled,
  isToolAutoRemediable, countRecentAutoRemediations, evaluateAutoRemediation
};
