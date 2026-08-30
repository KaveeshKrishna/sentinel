-- Durable deploy history.
--
-- Nothing before this migration records WHEN a repo was deployed to or
-- what it changed. `commit.date` (from agent/src/tools/git.js's
-- getRepoInfo) is the git AUTHOR date, not deploy time — a commit
-- authored 3 days ago deployed 4 minutes ago still reports "3 days ago".
-- And `activity_events` (a DEPLOYMENT row per attempt) is capped at 50
-- rows total across every event type and pruned on every write, so it
-- is gone within an hour on a busy host — it was never a history.
--
-- `resource_id` is a best-effort cache only, not the correlation join
-- key: a deploy can affect multiple compose services, and a single FK
-- can't represent that ambiguity honestly. The real correlation query
-- (context/deployCorrelation.js) joins on `repo_name` against a
-- resource's own `metadata_json->composeProject`, matching Docker
-- Compose's own default project-name convention (the basename of the
-- directory holding the compose file — which for a repo under
-- APPS_PATH is the repo name itself, unless overridden).

CREATE TABLE IF NOT EXISTS deployments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_name      TEXT NOT NULL,
  resource_id    INTEGER,
  from_sha       TEXT,
  to_sha         TEXT,
  from_message   TEXT,
  to_message     TEXT,
  deployed_at    INTEGER NOT NULL,
  deployed_by    TEXT NOT NULL,      -- 'user' | 'auto' (always 'user' today — nothing deploys unattended)
  status         TEXT NOT NULL,      -- 'success' | 'failed' | 'up_to_date'
  steps_json     TEXT,
  FOREIGN KEY (resource_id) REFERENCES resources(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_deployments_repo_time ON deployments(repo_name, deployed_at DESC);
