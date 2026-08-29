'use strict';

const { getDb } = require('../db/connection');
const { canTransition } = require('./states');
const { recordTransition } = require('./timeline');
const { publish } = require('../events/publish');

/**
 * The shape pushed to browsers on any incident create/transition. Kept
 * deliberately small — enough for a toast and a "something changed,
 * refetch" signal, not a replacement for GET /api/incidents/:id.
 */
function publishIncident(incident, previousStatus = null) {
  if (!incident) return;
  publish('incident', {
    id: incident.id,
    status: incident.status,
    previousStatus,
    severity: incident.severity,
    resourceId: incident.resource_id,
    triggerRule: incident.trigger_rule,
    triggerSummary: incident.trigger_summary,
    rootCause: incident.root_cause,
    updatedAt: incident.updated_at
  });
}

class IllegalTransitionError extends Error {
  constructor(from, to) {
    super(`Illegal incident transition: ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
    this.from = from;
    this.to = to;
  }
}

function deserializeIncident(row) {
  if (!row) return null;
  return {
    ...row,
    diagnosis: row.diagnosis_json ? JSON.parse(row.diagnosis_json) : null
  };
}

/** Most recent resolution time for a resource, used by the detector's post-resolution cooldown. */
function getLastResolvedAt(resourceId) {
  const row = getDb().prepare(`
    SELECT resolved_at FROM incidents WHERE resource_id = ? AND resolved_at IS NOT NULL
    ORDER BY resolved_at DESC LIMIT 1
  `).get(resourceId);
  return row ? row.resolved_at : null;
}

/**
 * Incidents that hit INVESTIGATING (evidence gathered, diagnosis
 * attempted) but never got a diagnosis — most commonly because no AI
 * provider was configured yet at the time. `updated_at <= cutoff` is a
 * cheap first-pass floor (the caller's minimum possible retry interval)
 * so this doesn't even query candidates worth reconsidering on every
 * single poll tick; the detector applies its own per-incident
 * exponential backoff on top of this for incidents that keep failing
 * (see detector.js's checkStuckInvestigations).
 */
function findStuckInvestigations(olderThanMs) {
  const cutoff = Date.now() - olderThanMs;
  const rows = getDb().prepare(`
    SELECT * FROM incidents
    WHERE status = 'INVESTIGATING' AND diagnosis_json IS NULL AND updated_at <= ?
  `).all(cutoff);
  return rows.map(deserializeIncident);
}

/**
 * Incidents parked at DIAGNOSED / AWAITING_APPROVAL and untouched for a
 * while. Two detector uses:
 *
 *  - re-check auto-remediation against their already-proposed actions
 *    (an operator can opt a resource in *after* its incident was raised);
 *  - re-diagnose a genuinely stale one, so a diagnosis written for a
 *    problem that has since changed (or resolved) doesn't sit forever
 *    blocking a fresh incident for that resource via the dedupe rule.
 */
function findWaitingIncidents(olderThanMs = 0) {
  const cutoff = Date.now() - olderThanMs;
  return getDb().prepare(`
    SELECT * FROM incidents
    WHERE status IN ('DIAGNOSED', 'AWAITING_APPROVAL') AND updated_at <= ?
    ORDER BY id
  `).all(cutoff).map(deserializeIncident);
}

/** Backed by the partial unique index on incidents(resource_id) WHERE status NOT IN (terminal). */
function findOpenIncidentForResource(resourceId) {
  const row = getDb().prepare(`
    SELECT * FROM incidents WHERE resource_id = ? AND status NOT IN ('RESOLVED', 'FAILED', 'DISMISSED')
  `).get(resourceId);
  return deserializeIncident(row);
}

function createIncident({ resourceId, severity = 'unknown', triggerRule, triggerSummary }) {
  const now = Date.now();
  const id = getDb().prepare(`
    INSERT INTO incidents (resource_id, status, severity, trigger_rule, trigger_summary, detected_at, updated_at)
    VALUES (?, 'DETECTED', ?, ?, ?, ?, ?)
  `).run(resourceId, severity, triggerRule, triggerSummary, now, now).lastInsertRowid;
  recordTransition(id, null, 'DETECTED', triggerSummary, now);
  const incident = getIncident(id);
  publishIncident(incident, null);
  return incident;
}

function getIncident(id) {
  return deserializeIncident(getDb().prepare('SELECT * FROM incidents WHERE id = ?').get(id));
}

function listIncidents({ status } = {}) {
  const db = getDb();
  const rows = status
    ? db.prepare('SELECT * FROM incidents WHERE status = ? ORDER BY detected_at DESC').all(status)
    : db.prepare('SELECT * FROM incidents ORDER BY detected_at DESC').all();
  return rows.map(deserializeIncident);
}

/**
 * Hard-delete one incident and (via ON DELETE CASCADE — foreign_keys is
 * ON, see db/connection.js) its evidence, actions, tool_executions and
 * ai_runs. Returns the number of incident rows removed (0 if no such id).
 */
function deleteIncident(id) {
  return getDb().prepare('DELETE FROM incidents WHERE id = ?').run(id).changes;
}

/**
 * Bulk hard-delete. With a `status` it removes only incidents in that
 * state (the UI's filter-aware "Clear" button); without one it removes
 * every incident. Same cascade as deleteIncident. Returns rows removed.
 */
function deleteIncidents({ status } = {}) {
  const db = getDb();
  const res = status
    ? db.prepare('DELETE FROM incidents WHERE status = ?').run(status)
    : db.prepare('DELETE FROM incidents').run();
  return res.changes;
}

/** Throws IllegalTransitionError rather than silently applying a bad transition. */
function updateIncidentStatus(id, newStatus, extra = {}) {
  const current = getIncident(id);
  if (!current) throw new Error(`Incident ${id} not found`);
  if (!canTransition(current.status, newStatus)) throw new IllegalTransitionError(current.status, newStatus);

  const now = Date.now();
  const fields = { updated_at: now, status: newStatus, ...extra };
  const setClause = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  getDb().prepare(`UPDATE incidents SET ${setClause} WHERE id = ?`).run(...Object.values(fields), id);
  recordTransition(id, current.status, newStatus, null, now);
  const incident = getIncident(id);
  publishIncident(incident, current.status);
  return incident;
}

function recordDiagnosis(id, diagnosis) {
  return updateIncidentStatus(id, 'DIAGNOSED', {
    root_cause: diagnosis.rootCause,
    confidence: diagnosis.confidence,
    diagnosis_json: JSON.stringify(diagnosis)
  });
}

function recordInvestigationFailure(id, rawText) {
  const current = getIncident(id);
  getDb().prepare('UPDATE incidents SET diagnosis_raw_text = ?, updated_at = ? WHERE id = ?')
    .run(rawText || null, Date.now(), id);
  // Stays at INVESTIGATING (self-loop) unless already there — this call
  // only ever follows a DETECTED->INVESTIGATING transition already made
  // by the caller, so no additional status change is needed here.
  return getIncident(current.id);
}

function recordResolution(id, finalStatus) {
  return updateIncidentStatus(id, finalStatus, { resolved_at: Date.now() });
}

function addEvidence(incidentId, evidenceRows) {
  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO incident_evidence (incident_id, resource_id, source_tool, summary, data_json, collected_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const now = Date.now();
  const insertMany = db.transaction((rows) => {
    for (const row of rows) {
      insert.run(incidentId, row.resourceId ?? null, row.sourceTool, row.summary, row.data ? JSON.stringify(row.data) : null, now);
    }
  });
  insertMany(evidenceRows);
}

function getEvidence(incidentId) {
  return getDb().prepare('SELECT * FROM incident_evidence WHERE incident_id = ? ORDER BY id').all(incidentId)
    .map(row => ({ ...row, data: row.data_json ? JSON.parse(row.data_json) : null }));
}

function addAction(incidentId, action) {
  const now = Date.now();
  const id = getDb().prepare(`
    INSERT INTO incident_actions (incident_id, tool_name, params_json, claimed_risk, real_risk, rationale, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?)
  `).run(incidentId, action.tool, JSON.stringify(action.params || {}), action.claimedRisk, action.realRisk, action.rationale, now).lastInsertRowid;
  return getAction(id);
}

function getAction(id) {
  const row = getDb().prepare('SELECT * FROM incident_actions WHERE id = ?').get(id);
  return row ? { ...row, params: JSON.parse(row.params_json) } : null;
}

function getActions(incidentId) {
  return getDb().prepare('SELECT * FROM incident_actions WHERE incident_id = ? ORDER BY id').all(incidentId)
    .map(row => ({ ...row, params: JSON.parse(row.params_json) }));
}

function updateActionStatus(id, status, extra = {}) {
  const fields = { status, ...extra };
  const setClause = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  getDb().prepare(`UPDATE incident_actions SET ${setClause} WHERE id = ?`).run(...Object.values(fields), id);
  return getAction(id);
}

module.exports = {
  IllegalTransitionError,
  findOpenIncidentForResource, findStuckInvestigations, findWaitingIncidents, getLastResolvedAt, createIncident, getIncident, listIncidents,
  deleteIncident, deleteIncidents,
  updateIncidentStatus, recordDiagnosis, recordInvestigationFailure, recordResolution,
  addEvidence, getEvidence,
  addAction, getAction, getActions, updateActionStatus
};
