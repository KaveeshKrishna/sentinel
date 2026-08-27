'use strict';

const { getDb } = require('../db/connection');
const { getAgentClient } = require('../agent/client');
const { getProvider } = require('./provider');
const { getAIConfig, getDecryptedAPIKey } = require('../settings/aiConfig');
const { validate } = require('./schema');
const { redact } = require('./redact');

const MAX_ATTEMPTS = 2;

function buildSystemPrompt(toolCatalog) {
  const toolList = toolCatalog
    .map(t => `- ${t.name} (risk: ${t.risk}): ${t.description}`)
    .join('\n');

  return [
    'You are Sentinel, an AI infrastructure engineer diagnosing a single incident.',
    'You are given evidence collected from a monitored host and must respond with ONLY a JSON object',
    'matching the required schema — no prose, no markdown fences.',
    '',
    'You may only recommend actions using these EXACT tool names (any other name will be discarded):',
    toolList,
    '',
    'Ground your rootCause and recommendedActions strictly in the evidence provided. Never invent',
    'evidence. If you are not confident an action will help, leave recommendedActions empty and',
    'explain why in rootCause instead.'
  ].join('\n');
}

function buildUserMessage(incident, evidence) {
  const lines = [
    `Incident on resource: ${incident.resourceName || incident.resource_id} (${incident.trigger_rule})`,
    `Trigger: ${incident.trigger_summary}`,
    '',
    'Evidence:'
  ];
  for (const e of evidence) {
    lines.push(`- [${e.source_tool}] ${redact(e.summary)}`);
  }
  return lines.join('\n');
}

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

/**
 * Cross-checks every AI-recommended action against the agent's REAL, live
 * tool catalog. This is the security-critical step: the model's own
 * `risk` field is untrusted output and is kept only as `claimedRisk` for
 * UI display — `realRisk` (from the catalog) is what the approval gate
 * and the agent's own isAuthorized() actually use. An unrecognized tool
 * name is dropped entirely; it never reaches a route or the agent.
 */
function reconcileActions(recommendedActions, toolCatalog) {
  const byName = new Map(toolCatalog.map(t => [t.name, t]));
  const kept = [];
  for (const action of recommendedActions || []) {
    const tool = byName.get(action.tool);
    if (!tool) continue; // unknown tool name — never passed through
    kept.push({
      tool: tool.name,
      params: action.params || {},
      claimedRisk: action.risk || null,
      realRisk: tool.risk,
      rationale: action.rationale
    });
  }
  return kept;
}

/**
 * Run one diagnosis attempt (with one retry on malformed/invalid JSON,
 * feeding the validation error back). Returns either:
 *   { ok: true, diagnosis: { rootCause, confidence, evidence, affectedComponents, requiresApproval, actions } }
 *   { ok: false, rawText } — caller leaves the incident at INVESTIGATING.
 */
async function runDiagnosis(incident, evidence) {
  const config = getAIConfig();
  if (!config.configured) {
    return { ok: false, rawText: null, error: 'No AI provider configured' };
  }

  const apiKey = getDecryptedAPIKey();
  const adapter = getProvider(config.provider);
  const toolCatalog = await getAgentClient().listTools();

  const system = buildSystemPrompt(toolCatalog);
  let userContent = buildUserMessage(incident, evidence);
  let lastRawText = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const startedAt = Date.now();
    let result;
    try {
      result = await adapter.chat({
        system,
        messages: [{ role: 'user', content: userContent }],
        responseSchema: require('./schema').DIAGNOSIS_SCHEMA,
        apiKey,
        model: config.model,
        baseUrl: config.baseUrl
      });
    } catch (err) {
      recordAiRun({
        incidentId: incident.id, purpose: 'diagnosis', provider: config.provider, model: config.model,
        attempt, requestSummary: userContent, rawResponse: null, parsedJson: null,
        error: err.message, usage: null, latencyMs: Date.now() - startedAt
      });
      return { ok: false, rawText: null, error: err.message };
    }

    lastRawText = result.text;
    let parsed;
    try {
      parsed = JSON.parse(result.text);
    } catch {
      recordAiRun({
        incidentId: incident.id, purpose: 'diagnosis', provider: config.provider, model: config.model,
        attempt, requestSummary: userContent, rawResponse: result.text, parsedJson: null,
        error: 'Response was not valid JSON', usage: result.usage, latencyMs: Date.now() - startedAt
      });
      userContent = `${userContent}\n\nYour previous response was not valid JSON. Respond with ONLY the JSON object, no other text.`;
      continue;
    }

    const { valid, errors } = validate(parsed);
    if (!valid) {
      recordAiRun({
        incidentId: incident.id, purpose: 'diagnosis', provider: config.provider, model: config.model,
        attempt, requestSummary: userContent, rawResponse: result.text, parsedJson: parsed,
        error: `Schema validation failed: ${errors.join('; ')}`, usage: result.usage, latencyMs: Date.now() - startedAt
      });
      userContent = `${userContent}\n\nYour previous response failed schema validation: ${errors.join('; ')}. Respond again with a corrected JSON object.`;
      continue;
    }

    recordAiRun({
      incidentId: incident.id, purpose: 'diagnosis', provider: config.provider, model: config.model,
      attempt, requestSummary: userContent, rawResponse: result.text, parsedJson: parsed,
      error: null, usage: result.usage, latencyMs: Date.now() - startedAt
    });

    return {
      ok: true,
      diagnosis: {
        rootCause: parsed.rootCause,
        confidence: parsed.confidence,
        evidence: parsed.evidence,
        affectedComponents: parsed.affectedComponents,
        requiresApproval: parsed.requiresApproval,
        actions: reconcileActions(parsed.recommendedActions, toolCatalog)
      }
    };
  }

  return { ok: false, rawText: lastRawText, error: 'AI response failed validation after retry' };
}

/**
 * How many diagnosis attempts (each one a distinct ai_runs row — every
 * failure path in runDiagnosis records one, incl. a provider-level
 * error) have already been made for this incident. Used by the
 * detector's stuck-investigation re-drive (detector.js) to back off
 * exponentially instead of retrying a persistently-failing provider
 * (bad key, exhausted quota) at a fixed short interval forever.
 */
function countDiagnosisAttempts(incidentId) {
  const row = getDb().prepare(
    `SELECT COUNT(*) c FROM ai_runs WHERE incident_id = ? AND purpose = 'diagnosis'`
  ).get(incidentId);
  return row.c;
}

module.exports = { runDiagnosis, reconcileActions, buildSystemPrompt, buildUserMessage, countDiagnosisAttempts };
