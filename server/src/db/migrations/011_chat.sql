-- "Ask Sentinel" conversations.
--
-- Persisted rather than kept in browser memory for two reasons: a chat
-- that ran READ_ONLY tools against the host is part of the audit story
-- (each of those calls also lands in tool_executions, and each model
-- round trip in ai_runs with purpose='chat'), and a session survives a
-- page reload, which matters when a turn takes several tool calls.
--
-- `tool_calls_json` holds the [{tool, params, ok, summary}] trail for an
-- assistant turn, so a reloaded session redraws the tool chips rather
-- than just the final answer.

CREATE TABLE IF NOT EXISTS chat_sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,          -- 'user' | 'assistant'
  content         TEXT NOT NULL,
  tool_calls_json TEXT,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated ON chat_sessions(updated_at DESC);
