'use strict';

const crypto = require('crypto');
const { getDb } = require('../db/connection');

/**
 * Create a server-side session record and return its jti. The JWT itself
 * only proves the token was signed by us and hasn't expired by its own
 * clock — this table is what makes logout (and a future "revoke this
 * session" action) actually take effect immediately, rather than the
 * token remaining usable until its 12h expiry regardless.
 */
function createSession(userId, ttlSeconds) {
  const jti = crypto.randomUUID();
  const now = Date.now();
  getDb()
    .prepare('INSERT INTO auth_sessions (jti, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(jti, userId, now, now + ttlSeconds * 1000);
  return jti;
}

/** True if `jti` refers to a session that exists and hasn't expired. */
function isSessionValid(jti) {
  if (!jti) return false;
  const row = getDb().prepare('SELECT expires_at FROM auth_sessions WHERE jti = ?').get(jti);
  return !!row && row.expires_at > Date.now();
}

function revokeSession(jti) {
  getDb().prepare('DELETE FROM auth_sessions WHERE jti = ?').run(jti);
}

/** Opportunistic cleanup — called on login rather than run as a cron. */
function pruneExpiredSessions() {
  getDb().prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(Date.now());
}

module.exports = { createSession, isSessionValid, revokeSession, pruneExpiredSessions };
