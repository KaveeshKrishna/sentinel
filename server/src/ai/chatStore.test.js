'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = path.join(os.tmpdir(), `sentinel-test-chatstore-${crypto.randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { migrate } = require('../db/migrate');
const { getDb } = require('../db/connection');
const store = require('./chatStore');

before(() => migrate());
after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(DB_PATH + suffix); } catch { /* already gone */ }
  }
});

test('createSession starts empty and titles itself from the first message', () => {
  const session = store.createSession('why is cpu high?');
  assert.equal(session.title, 'why is cpu high?');
  assert.deepEqual(store.getMessages(session.id), []);
});

test('a title longer than TITLE_LIMIT is truncated', () => {
  const long = 'x'.repeat(store.TITLE_LIMIT + 40);
  const session = store.createSession(long);
  assert.equal(session.title.length, store.TITLE_LIMIT);
});

test('a missing first message falls back to a generic title, not "undefined"', () => {
  const session = store.createSession(undefined);
  assert.equal(session.title, 'New conversation');
});

// ── Per-session memory ────────────────────────────────────────────────
// The whole point of persisting chat at all: each session accumulates
// its own, independent message history, and messages are returned in
// the order they happened so a reconstructed conversation reads right.

test('messages accumulate on their own session, in order', () => {
  const session = store.createSession('q1');
  store.addMessage(session.id, { role: 'user', content: 'q1' });
  store.addMessage(session.id, { role: 'assistant', content: 'a1' });
  store.addMessage(session.id, { role: 'user', content: 'q2 — remember a1?' });
  store.addMessage(session.id, { role: 'assistant', content: 'a2, yes I do' });

  const messages = store.getMessages(session.id);
  assert.deepEqual(messages.map(m => m.content), ['q1', 'a1', 'q2 — remember a1?', 'a2, yes I do']);
  assert.deepEqual(messages.map(m => m.role), ['user', 'assistant', 'user', 'assistant']);
});

test('two sessions never see each other\'s messages', () => {
  const a = store.createSession('session a');
  const b = store.createSession('session b');
  store.addMessage(a.id, { role: 'user', content: 'only in a' });
  store.addMessage(b.id, { role: 'user', content: 'only in b' });

  assert.deepEqual(store.getMessages(a.id).map(m => m.content), ['only in a']);
  assert.deepEqual(store.getMessages(b.id).map(m => m.content), ['only in b']);
});

test('toolCalls round-trip through JSON via getMessages, and a message with none stores null', () => {
  const session = store.createSession('q');
  const withTools = store.addMessage(session.id, {
    role: 'assistant', content: 'checked it',
    toolCalls: { calls: [{ tool: 'get_system_metrics', ok: true, summary: '{}' }], suggestedIncident: null }
  });
  store.addMessage(session.id, { role: 'user', content: 'thanks' });

  // addMessage's own return is the raw row — tool_calls_json, not a
  // parsed toolCalls field. Only getMessages() parses it back out.
  assert.equal(withTools.tool_calls_json, JSON.stringify({
    calls: [{ tool: 'get_system_metrics', ok: true, summary: '{}' }], suggestedIncident: null
  }));

  const [first, second] = store.getMessages(session.id);
  assert.equal(first.toolCalls.calls[0].tool, 'get_system_metrics');
  assert.equal(second.toolCalls, null);
});

test('adding a message bumps the session to the top of listSessions', () => {
  const older = store.createSession('older');
  const newer = store.createSession('newer');
  // Force a known relative order between just these two, independent of
  // whatever real Date.now() timestamps earlier tests in this file left
  // on other sessions (which would otherwise dwarf small hardcoded values
  // and make asserting on list[0] directly meaningless).
  getDb().prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(1000, older.id);
  getDb().prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(2000, newer.id);

  const rank = (list, id) => list.findIndex(s => s.id === id);

  let list = store.listSessions(100);
  assert.ok(rank(list, newer.id) < rank(list, older.id));

  store.addMessage(older.id, { role: 'user', content: 'wake up' });
  list = store.listSessions(100);
  assert.ok(
    rank(list, older.id) < rank(list, newer.id),
    'touching an older session should bring it ahead of one that was more recently updated before that'
  );
});

// ── Delete removes the data, not just API visibility ────────────────
// app.test.js already proves a deleted session 404s via the API; these
// prove the underlying rows are actually gone, which a broken/missing
// ON DELETE CASCADE would not affect (a plain "session not found" 404
// happens before chat_messages is ever queried, so that alone can't
// catch an orphaned-messages bug).

test('deleteSession removes the session row and reports one row changed', () => {
  const session = store.createSession('to delete');
  const changes = store.deleteSession(session.id);
  assert.equal(changes, 1);
  assert.equal(store.getSession(session.id), null);
});

test('deleting a session cascades to its messages — they are gone, not orphaned', () => {
  const session = store.createSession('to delete with messages');
  store.addMessage(session.id, { role: 'user', content: 'q' });
  store.addMessage(session.id, { role: 'assistant', content: 'a' });
  assert.equal(store.getMessages(session.id).length, 2);

  store.deleteSession(session.id);

  // Querying directly by session_id — independent of the session row's
  // own existence — is what actually proves the cascade ran rather than
  // just that the parent lookup now fails.
  assert.deepEqual(store.getMessages(session.id), []);
  const raw = getDb().prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ?').get(session.id);
  assert.equal(raw.n, 0);
});

test('deleting one session never touches another session\'s messages', () => {
  const keep = store.createSession('keep me');
  const drop = store.createSession('drop me');
  store.addMessage(keep.id, { role: 'user', content: 'still here' });
  store.addMessage(drop.id, { role: 'user', content: 'gone soon' });

  store.deleteSession(drop.id);

  assert.deepEqual(store.getMessages(keep.id).map(m => m.content), ['still here']);
  assert.equal(store.getSession(keep.id) !== null, true);
});

test('deleteSession on an unknown id reports zero changes rather than throwing', () => {
  assert.equal(store.deleteSession(999999), 0);
});
