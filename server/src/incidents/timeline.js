'use strict';

const { getDb } = require('../db/connection');
const { isTerminal } = require('./states');

/**
 * The five stages of Sentinel's reasoning loop, in order. Every timeline
 * entry is tagged with exactly one of these so the UI can draw the loop
 * itself rather than an undifferentiated list of rows.
 */
const PHASES = ['OBSERVE', 'DIAGNOSE', 'PLAN', 'ACT', 'VERIFY'];

/** Which phase an incident *entering* a given state represents. */
const STATUS_PHASE = {
  DETECTED:          'OBSERVE',
  INVESTIGATING:     'OBSERVE',
  DIAGNOSED:         'DIAGNOSE',
  AWAITING_APPROVAL: 'PLAN',
  REMEDIATING:       'ACT',
  VERIFYING:         'VERIFY',
  RESOLVED:          'VERIFY',
  FAILED:            'VERIFY',
  DISMISSED:         'VERIFY'
};

/**
 * Which phase a tool call belongs to, keyed by the `requested_by` the
 * caller passed to callToolAudited. 'investigation' is an approved
 * READ_ONLY action — it gathers *more* evidence, so it re-enters OBSERVE
 * even though it happens after PLAN.
 */
const REQUESTED_BY_PHASE = {
  context:        'OBSERVE',
  investigation:  'OBSERVE',
  detector:       'OBSERVE',
  diagnosis:      'DIAGNOSE',
  remediation:    'ACT',
  verification:   'VERIFY'
};

const AI_PURPOSE_PHASE = {
  diagnosis: 'DIAGNOSE',
  report:    'VERIFY'
};

/**
 * Append one state-transition row. Called from store.js on every
 * create/transition — deliberately here rather than inline in the store
 * so the timeline's schema stays owned by the module that reads it.
 */
function recordTransition(incidentId, fromStatus, toStatus, note, at = Date.now()) {
  getDb().prepare(`
    INSERT INTO incident_timeline (incident_id, from_status, to_status, note, at)
    VALUES (?, ?, ?, ?, ?)
  `).run(incidentId, fromStatus, toStatus, note || null, at);
}

function getTransitions(incidentId) {
  return getDb()
    .prepare('SELECT * FROM incident_timeline WHERE incident_id = ? ORDER BY at, id')
    .all(incidentId);
}

/**
 * Incidents created before migration 010 have no transition rows at all.
 * Rather than render an empty timeline for them, approximate one from
 * the timestamps the incidents row has always carried — flagged
 * `synthesized` so the UI can say so instead of implying this is the
 * real recorded history.
 */
function synthesizeTransitions(incident) {
  const rows = [{ from_status: null, to_status: 'DETECTED', at: incident.detected_at, synthesized: true }];
  if (incident.status !== 'DETECTED') {
    rows.push({
      from_status: null,
      to_status: incident.status,
      at: incident.resolved_at || incident.updated_at,
      synthesized: true
    });
  }
  return rows;
}

/**
 * Every recorded thing that happened to one incident, merged from the
 * four tables that already store it (transitions, evidence-gathering and
 * remediation tool calls, AI attempts, proposed actions) into a single
 * time-ordered list, plus a per-phase rollup for the loop strip.
 *
 * ai_runs.raw_response is deliberately never included — it is redacted
 * but can be many KB per attempt, and the timeline is a summary view.
 */
function getTimeline(incidentId, incident) {
  const db = getDb();
  const entries = [];

  const transitions = getTransitions(incidentId);
  const rows = transitions.length > 0
    ? transitions
    : (incident ? synthesizeTransitions(incident) : []);

  for (const t of rows) {
    entries.push({
      kind: 'transition',
      phase: STATUS_PHASE[t.to_status] || 'OBSERVE',
      at: t.at,
      from: t.from_status,
      to: t.to_status,
      note: t.note || null,
      synthesized: !!t.synthesized
    });
  }

  for (const t of db.prepare('SELECT * FROM tool_executions WHERE incident_id = ? ORDER BY started_at, id').all(incidentId)) {
    entries.push({
      kind: 'tool',
      phase: REQUESTED_BY_PHASE[t.requested_by] || 'OBSERVE',
      at: t.started_at,
      tool: t.tool_name,
      status: t.status,
      approved: !!t.approved,
      requestedBy: t.requested_by,
      realRisk: t.real_risk,
      durationMs: t.duration_ms,
      error: t.error || null
    });
  }

  for (const r of db.prepare('SELECT * FROM ai_runs WHERE incident_id = ? ORDER BY created_at, id').all(incidentId)) {
    entries.push({
      kind: 'ai',
      phase: AI_PURPOSE_PHASE[r.purpose] || 'DIAGNOSE',
      at: r.created_at,
      purpose: r.purpose,
      provider: r.provider,
      model: r.model,
      attempt: r.attempt,
      ok: !r.error,
      error: r.error || null,
      promptTokens: r.prompt_tokens,
      completionTokens: r.completion_tokens,
      latencyMs: r.latency_ms
    });
  }

  for (const a of db.prepare('SELECT * FROM incident_actions WHERE incident_id = ? ORDER BY created_at, id').all(incidentId)) {
    entries.push({
      kind: 'action',
      phase: 'PLAN',
      at: a.created_at,
      actionId: a.id,
      tool: a.tool_name,
      realRisk: a.real_risk,
      status: a.status,
      rationale: a.rationale || null,
      approvedVia: a.approved_via || null,
      approvedAt: a.approved_at,
      executedAt: a.executed_at
    });
  }

  entries.sort((a, b) => a.at - b.at);
  return { entries, phases: rollupPhases(entries, incident) };
}

/**
 * Collapse the entry list into one status per loop stage, for the strip.
 *
 * 'skipped' is a real outcome, not a rendering detail: an incident whose
 * only approved action was a READ_ONLY investigation never enters ACT,
 * and showing that stage as merely "pending" while later stages are done
 * would misrepresent what happened.
 */
function rollupPhases(entries, incident) {
  const firstAt = new Map();
  for (const e of entries) {
    if (!firstAt.has(e.phase)) firstAt.set(e.phase, e.at);
  }

  let reached = -1;
  for (const e of entries) {
    reached = Math.max(reached, PHASES.indexOf(e.phase));
  }

  const terminal = incident ? isTerminal(incident.status) : false;
  const failed = incident ? incident.status === 'FAILED' : false;

  return PHASES.map((phase, i) => {
    let status;
    if (i > reached) status = 'pending';
    else if (i < reached) status = firstAt.has(phase) ? 'done' : 'skipped';
    else if (failed) status = 'failed';
    else if (terminal) status = 'done';
    else status = 'active';
    return { phase, status, at: firstAt.get(phase) ?? null };
  });
}

module.exports = { PHASES, recordTransition, getTransitions, getTimeline, rollupPhases };
