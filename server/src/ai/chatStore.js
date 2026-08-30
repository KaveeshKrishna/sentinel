'use strict';

const { getDb } = require('../db/connection');

const TITLE_LIMIT = 60;

function createSession(firstMessage) {
  const now = Date.now();
  const title = (firstMessage || 'New conversation').slice(0, TITLE_LIMIT);
  const id = getDb()
    .prepare('INSERT INTO chat_sessions (title, created_at, updated_at) VALUES (?, ?, ?)')
    .run(title, now, now).lastInsertRowid;
  return getSession(id);
}

function getSession(id) {
  return getDb().prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id) || null;
}

function listSessions(limit = 30) {
  return getDb()
    .prepare('SELECT * FROM chat_sessions ORDER BY updated_at DESC LIMIT ?')
    .all(Math.min(limit, 100));
}

function deleteSession(id) {
  return getDb().prepare('DELETE FROM chat_sessions WHERE id = ?').run(id).changes;
}

function touchSession(id) {
  getDb().prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(Date.now(), id);
}

function addMessage(sessionId, { role, content, toolCalls = null }) {
  const id = getDb().prepare(`
    INSERT INTO chat_messages (session_id, role, content, tool_calls_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(sessionId, role, content, toolCalls ? JSON.stringify(toolCalls) : null, Date.now()).lastInsertRowid;
  touchSession(sessionId);
  return getDb().prepare('SELECT * FROM chat_messages WHERE id = ?').get(id);
}

function getMessages(sessionId) {
  return getDb()
    .prepare('SELECT * FROM chat_messages WHERE session_id = ? ORDER BY id')
    .all(sessionId)
    .map(row => ({ ...row, toolCalls: row.tool_calls_json ? JSON.parse(row.tool_calls_json) : null }));
}

module.exports = {
  createSession, getSession, listSessions, deleteSession,
  addMessage, getMessages, TITLE_LIMIT
};
