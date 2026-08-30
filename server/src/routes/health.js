'use strict';

const express = require('express');
const router = express.Router();
const { getAgentClient } = require('../agent/client');
const { getDb } = require('../db/connection');
const { listCredentials } = require('../settings/aiCredentials');

/**
 * A new, distinct, AUTHENTICATED prefix — deliberately not layered onto
 * the existing root `GET /health`, which is public liveness for the
 * installer/systemd (no session, no DB query). Mixing an aggregate-stats
 * endpoint that reads tool_executions/ai_runs onto that same
 * unauthenticated path would leak that data without a session.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** Selectable AI-spend windows for the Sentinel Health page's dropdown. */
const AI_WINDOWS = {
  '24h': DAY_MS,
  '7d': WEEK_MS,
  '15d': 15 * DAY_MS,
  '30d': 30 * DAY_MS
};

function resolveAiWindowMs(param) {
  return AI_WINDOWS[param] || WEEK_MS; // unknown/missing -> the original default
}

/** Agent reachability + round-trip latency, via the same AgentClient every real call already uses. */
async function checkAgent() {
  const startedAt = Date.now();
  try {
    const tools = await getAgentClient().listTools();
    return { reachable: true, latencyMs: Date.now() - startedAt, toolCount: tools.length, error: null };
  } catch (err) {
    return { reachable: false, latencyMs: Date.now() - startedAt, toolCount: null, error: err.message };
  }
}

function checkDb() {
  const db = getDb();
  const pageCount = db.pragma('page_count', { simple: true });
  const pageSize = db.pragma('page_size', { simple: true });
  return { sizeKb: Math.round((pageCount * pageSize) / 1024) };
}

/** p95 computed in JS from an ordered result set — fine at this row volume, no window-function dependency. */
function p95(sorted) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[idx];
}

function toolExecutionsSummary() {
  const since = Date.now() - DAY_MS;
  const rows = getDb().prepare(
    'SELECT tool_name, duration_ms, status FROM tool_executions WHERE started_at >= ?'
  ).all(since);

  const byTool = new Map();
  for (const row of rows) {
    const entry = byTool.get(row.tool_name) || { toolName: row.tool_name, count: 0, errors: 0, durations: [] };
    entry.count++;
    if (row.status === 'error') entry.errors++;
    entry.durations.push(row.duration_ms);
    byTool.set(row.tool_name, entry);
  }

  const summary = [...byTool.values()].map(e => {
    const sorted = [...e.durations].sort((a, b) => a - b);
    return {
      toolName: e.toolName,
      count: e.count,
      errorRate: e.count > 0 ? Math.round((e.errors / e.count) * 1000) / 1000 : 0,
      avgDurationMs: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
      p95DurationMs: p95(sorted)
    };
  }).sort((a, b) => (b.p95DurationMs || 0) - (a.p95DurationMs || 0));

  return {
    byTool: summary,
    totalCalls: rows.length,
    totalErrors: rows.filter(r => r.status === 'error').length
  };
}

function aiRunsSummary(windowMs) {
  const since = Date.now() - windowMs;
  const rows = getDb().prepare(
    'SELECT credential_id, purpose, prompt_tokens, completion_tokens, latency_ms, error FROM ai_runs WHERE created_at >= ?'
  ).all(since);

  const credentialLabels = new Map(listCredentials().map(c => [c.id, c.label]));

  const groupBy = (keyFn) => {
    const groups = new Map();
    for (const row of rows) {
      const key = keyFn(row);
      const entry = groups.get(key) || { requests: 0, promptTokens: 0, completionTokens: 0, latencies: [], errors: 0 };
      entry.requests++;
      if (row.prompt_tokens != null) entry.promptTokens += row.prompt_tokens;
      if (row.completion_tokens != null) entry.completionTokens += row.completion_tokens;
      if (row.latency_ms != null) entry.latencies.push(row.latency_ms);
      if (row.error) entry.errors++;
      groups.set(key, entry);
    }
    return groups;
  };

  const byCredential = [...groupBy(r => r.credential_id).entries()].map(([credentialId, e]) => ({
    credentialId,
    label: credentialLabels.get(credentialId) || (credentialId ? `#${credentialId}` : 'Environment fallback'),
    requests: e.requests,
    promptTokens: e.promptTokens,
    completionTokens: e.completionTokens,
    avgLatencyMs: e.latencies.length ? Math.round(e.latencies.reduce((a, b) => a + b, 0) / e.latencies.length) : null,
    errorCount: e.errors
  }));

  const byPurpose = [...groupBy(r => r.purpose).entries()].map(([purpose, e]) => ({
    purpose,
    requests: e.requests,
    promptTokens: e.promptTokens,
    completionTokens: e.completionTokens,
    avgLatencyMs: e.latencies.length ? Math.round(e.latencies.reduce((a, b) => a + b, 0) / e.latencies.length) : null
  }));

  return { byCredential, byPurpose };
}

router.get('/overview', async (req, res) => {
  const aiWindowMs = resolveAiWindowMs(req.query.aiWindow);
  const [agent, toolExecutions, aiRuns] = await Promise.all([
    checkAgent(),
    Promise.resolve(toolExecutionsSummary()),
    Promise.resolve(aiRunsSummary(aiWindowMs))
  ]);
  res.json({ agent, db: checkDb(), toolExecutions, aiRuns: { ...aiRuns, windowMs: aiWindowMs } });
});

module.exports = router;
