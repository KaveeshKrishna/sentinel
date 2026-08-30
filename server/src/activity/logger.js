'use strict';

const { getDb } = require('../db/connection');
const { publish } = require('../events/publish');

const EVENT_META = {
  SSH_LOGIN:            { icon: 'lock', color: '#3b82f6' },
  LOGIN:                { icon: 'key', color: '#3b82f6' },
  LOGOUT:                { icon: 'unlock', color: '#7d8590' },
  DEPLOYMENT:           { icon: 'rocket', color: '#22c55e' },
  DOCKER_START:         { icon: 'check', color: '#22c55e' },
  DOCKER_STOP:          { icon: 'square', color: '#f59e0b' },
  DOCKER_RESTART:       { icon: 'refresh-cw', color: '#3b82f6' },
  CONTAINER_CRASH:      { icon: 'zap-off', color: '#ef4444' },
  SERVICE_START:        { icon: 'check', color: '#22c55e' },
  SERVICE_STOP:         { icon: 'x', color: '#f59e0b' },
  SERVICE_RESTART:      { icon: 'refresh-cw', color: '#3b82f6' },
  RECORDING_START:      { icon: 'circle', color: '#ef4444' },
  RECORDING_STOP:       { icon: 'square', color: '#7d8590' },
  SYSTEM_START:         { icon: 'arrow-up', color: '#a855f7' },
  CADDY_RELOAD:         { icon: 'globe', color: '#06b6d4' },
  SETUP_COMPLETED:      { icon: 'shield', color: '#a855f7' },
  INCIDENT_DETECTED:        { icon: 'alert-circle', color: '#ef4444' },
  INCIDENT_DIAGNOSED:       { icon: 'brain', color: '#a855f7' },
  INCIDENT_APPROVED:        { icon: 'check-circle', color: '#22c55e' },
  INCIDENT_DISMISSED:       { icon: 'slash-circle', color: '#7d8590' },
  INCIDENT_ACTION_EXECUTED: { icon: 'settings', color: '#3b82f6' },
  INCIDENT_RESOLVED:        { icon: 'check', color: '#22c55e' },
  INCIDENT_FAILED:          { icon: 'x-circle', color: '#ef4444' },
  // Emitted by engine.js/detector.js since the post-cutover rounds but
  // never registered here, so they rendered with the generic '•'.
  INCIDENT_AUTO_REMEDIATE:  { icon: 'cpu', color: '#06b6d4' },
  INCIDENT_REDIAGNOSE:      { icon: 'refresh-cw', color: '#a855f7' },
  INCIDENT_STALE_REDIAGNOSE:{ icon: 'refresh-cw', color: '#a855f7' },
  INCIDENT_ACTION_FAILED:   { icon: 'alert-triangle', color: '#ef4444' },
  INCIDENT_ACTION_REJECTED: { icon: 'corner-up-left', color: '#f59e0b' },
  AI_CALL_FAILED:           { icon: 'alert-triangle', color: '#f59e0b' },
  // AI credential failover (ai/failover.js). FAILOVER means a lower-
  // priority key rescued the call; EXHAUSTED means every one failed and
  // the reasoning loop actually stalled — different severities.
  AI_PROVIDER_FAILOVER:     { icon: 'shuffle', color: '#f59e0b' },
  AI_PROVIDER_EXHAUSTED:    { icon: 'slash-circle', color: '#ef4444' }
};

/**
 * The Activity timeline is a rolling recent-events view, not the audit
 * trail — anything that must survive lives in its own table
 * (`incident_timeline`, `tool_executions`, `ai_runs`,
 * `incident_actions`). Keeping only the newest N rows stops the table
 * growing without bound on a busy host and keeps the page's own render
 * cheap. Pruned on write rather than on a timer so the cap can never
 * drift while the process is idle.
 */
const MAX_ACTIVITY_EVENTS = 50;

let insertStmt = null;
let selectStmt = null;
let pruneStmt = null;

function getStmts() {
  if (insertStmt) return { insertStmt, selectStmt, pruneStmt };
  const db = getDb();
  insertStmt = db.prepare('INSERT INTO activity_events (type, message, details, timestamp) VALUES (?, ?, ?, ?)');
  selectStmt = db.prepare('SELECT * FROM activity_events ORDER BY id DESC LIMIT ?');
  // One indexed lookup for the cut-off id, then a range delete — cheaper
  // than a NOT IN subquery, and a no-op once the table is at the cap and
  // the offset row doesn't exist.
  pruneStmt = db.prepare(
    `DELETE FROM activity_events WHERE id <= (
       SELECT id FROM activity_events ORDER BY id DESC LIMIT 1 OFFSET ?
     )`
  );
  return { insertStmt, selectStmt, pruneStmt };
}

/**
 * Drop everything older than the newest MAX_ACTIVITY_EVENTS rows.
 * Exported for tests and for a one-shot trim at boot (an install
 * upgrading from the unbounded table starts with far more than the cap).
 * @returns {number} rows deleted
 */
function pruneEvents() {
  const { pruneStmt: prune } = getStmts();
  // OFFSET is the count to keep, so the subquery yields the id of the
  // first row past the cap; `id <=` then deletes that one and everything
  // older. Under the cap the subquery is NULL and nothing is deleted.
  return prune.run(MAX_ACTIVITY_EVENTS).changes;
}

/**
 * Log an event, persisted to SQLite (previously an in-memory ring buffer
 * that lost everything on restart — not much of an audit trail).
 * @param {string} type - one of EVENT_META keys (unknown types still log,
 *   just with a generic icon — this is descriptive metadata, not a schema)
 * @param {string} message - human-readable description
 * @param {object|null} details - optional extra data (never put secrets here)
 */
function logEvent(type, message, details = null) {
  const { insertStmt: insert } = getStmts();
  const timestamp = Date.now();
  const id = insert.run(type, message, details ? JSON.stringify(details) : null, timestamp).lastInsertRowid;
  pruneEvents();
  console.log(`[${type}] ${message}`);

  // Push to any connected browser in the same shape getEvents() returns,
  // so the Activity timeline can prepend it without a refetch.
  publish('activity', {
    id, timestamp, type, message, details,
    ...(EVENT_META[type] || { icon: '•', color: '#7d8590' })
  });
}

function getEvents(limit = MAX_ACTIVITY_EVENTS) {
  const { selectStmt: select } = getStmts();
  return select.all(Math.min(limit, MAX_ACTIVITY_EVENTS)).map(row => {
    const meta = EVENT_META[row.type] || { icon: '•', color: '#7d8590' };
    return {
      id: row.id,
      timestamp: row.timestamp,
      type: row.type,
      message: row.message,
      details: row.details ? JSON.parse(row.details) : null,
      ...meta
    };
  });
}

module.exports = { logEvent, getEvents, pruneEvents, MAX_ACTIVITY_EVENTS };
