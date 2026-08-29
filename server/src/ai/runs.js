'use strict';

const { getDb } = require('../db/connection');
const { redact } = require('./redact');

/**
 * One `ai_runs` row per provider round trip — success or failure, every
 * attempt. This is the audit trail for everything the AI was asked and
 * everything it said back, and the source the detector's exponential
 * backoff counts attempts from.
 *
 * Extracted from ai/orchestrator.js (where it was private) so the chat
 * and post-incident-report paths record identically rather than growing
 * their own INSERTs. `purpose` is free text in the schema; in use it is
 * 'diagnosis' | 'chat' | 'report'.
 *
 * Both the request summary and the raw response are redacted before they
 * are written — this table is read back by scripts/ai-runs.js and by the
 * incident timeline.
 */
function recordAiRun({ incidentId, purpose, provider, model, attempt, requestSummary, rawResponse, parsedJson, error, usage, latencyMs }) {
  getDb().prepare(`
    INSERT INTO ai_runs (incident_id, purpose, provider, model, attempt, request_summary, raw_response,
                          parsed_json, error, prompt_tokens, completion_tokens, latency_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    incidentId ?? null, purpose, provider, model, attempt,
    requestSummary ? redact(requestSummary) : null,
    rawResponse ? redact(rawResponse) : null,
    parsedJson ? JSON.stringify(parsedJson) : null,
    error || null,
    usage?.promptTokens ?? null, usage?.completionTokens ?? null, latencyMs, Date.now()
  );
}

module.exports = { recordAiRun };
