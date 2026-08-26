'use strict';

const { getDb } = require('../db/connection');

const EVENT_META = {
  SSH_LOGIN:            { icon: '🔐', color: '#3b82f6' },
  LOGIN:                { icon: '🔑', color: '#3b82f6' },
  LOGOUT:                { icon: '🔓', color: '#7d8590' },
  DEPLOYMENT:           { icon: '🚀', color: '#22c55e' },
  DOCKER_START:         { icon: '▶',  color: '#22c55e' },
  DOCKER_STOP:          { icon: '■',  color: '#f59e0b' },
  DOCKER_RESTART:       { icon: '↺',  color: '#3b82f6' },
  CONTAINER_CRASH:      { icon: '💥', color: '#ef4444' },
  SERVICE_START:        { icon: '✓',  color: '#22c55e' },
  SERVICE_STOP:         { icon: '✗',  color: '#f59e0b' },
  SERVICE_RESTART:      { icon: '↺',  color: '#3b82f6' },
  RECORDING_START:      { icon: '⏺',  color: '#ef4444' },
  RECORDING_STOP:       { icon: '⏹',  color: '#7d8590' },
  SYSTEM_START:         { icon: '⬆',  color: '#a855f7' },
  CADDY_RELOAD:         { icon: '🌐', color: '#06b6d4' },
  SETUP_COMPLETED:      { icon: '🛡',  color: '#a855f7' },
  INCIDENT_DETECTED:        { icon: '🔴', color: '#ef4444' },
  INCIDENT_DIAGNOSED:       { icon: '🧠', color: '#a855f7' },
  INCIDENT_APPROVED:        { icon: '✅', color: '#22c55e' },
  INCIDENT_DISMISSED:       { icon: '🚫', color: '#7d8590' },
  INCIDENT_ACTION_EXECUTED: { icon: '⚙',  color: '#3b82f6' },
  INCIDENT_RESOLVED:        { icon: '✔',  color: '#22c55e' },
  INCIDENT_FAILED:          { icon: '❌', color: '#ef4444' },
  AI_CALL_FAILED:           { icon: '⚠',  color: '#f59e0b' }
};

let insertStmt = null;
let selectStmt = null;

function getStmts() {
  if (insertStmt) return { insertStmt, selectStmt };
  const db = getDb();
  insertStmt = db.prepare('INSERT INTO activity_events (type, message, details, timestamp) VALUES (?, ?, ?, ?)');
  selectStmt = db.prepare('SELECT * FROM activity_events ORDER BY id DESC LIMIT ?');
  return { insertStmt, selectStmt };
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
  insert.run(type, message, details ? JSON.stringify(details) : null, timestamp);
  console.log(`[${type}] ${message}`);
}

function getEvents(limit = 100) {
  const { selectStmt: select } = getStmts();
  return select.all(Math.min(limit, 500)).map(row => {
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

module.exports = { logEvent, getEvents };
