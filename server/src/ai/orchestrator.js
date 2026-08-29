'use strict';

const { getDb } = require('../db/connection');
const { getAgentClient } = require('../agent/client');
const { getAIConfig } = require('../settings/aiConfig');
const { chatWithFailover } = require('./failover');
const { validate } = require('./schema');
const { redact } = require('./redact');
const { recordAiRun } = require('./runs');

const MAX_ATTEMPTS = 2;

/**
 * Render the agent's live tool catalog for a system prompt.
 *
 * The params JSON Schema is included deliberately, not just the name and
 * description: without it the model guesses the params shape and the
 * agent's strict validation rejects every recommended action with
 * `400 Invalid parameters` (found during the Phase 5 cutover rehearsal).
 * Shared with the chat orchestrator, which renders the same catalog
 * filtered to READ_ONLY.
 */
function renderToolCatalog(toolCatalog) {
  return toolCatalog
    .map(t => {
      const schema = JSON.stringify(t.parameters || { type: 'object', properties: {} });
      return `- ${t.name} (risk: ${t.risk}): ${t.description}\n    params schema: ${schema}`;
    })
    .join('\n');
}

function buildSystemPrompt(toolCatalog) {
  const toolList = renderToolCatalog(toolCatalog);

  return [
    'You are Sentinel, an AI infrastructure engineer diagnosing a single incident.',
    'You are given evidence collected from a monitored host and must respond with ONLY a JSON object',
    'matching the required schema — no prose, no markdown fences.',
    '',
    'You may only recommend actions using these EXACT tool names (any other name will be discarded).',
    'Each action\'s "params" object MUST conform exactly to that tool\'s params schema below: use only',
    'the properties it lists and no others (the schemas are strict — extra properties are rejected).',
    'Where a schema wants a container "id", pass the container name exactly as it appears in the',
    'evidence (the agent resolves a name or an id).',
    toolList,
    '',
    'Ground your rootCause and recommendedActions strictly in the evidence provided. Never invent',
    'evidence. If you are not confident an action will help, leave recommendedActions empty and',
    'explain why in rootCause instead.',
    '',
    'When the evidence shows a service is inactive/failed or a container has exited or is unhealthy,',
    'and nothing in the evidence points to a crash loop, a bad config, or a failing dependency, the',
    'remediation is to restart it: recommend restart_service (for a service) or restart_container',
    '(for a container) as the first action. Only fall back to a read-only investigation tool when the',
    'evidence genuinely does not say why it stopped.'
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

  const toolCatalog = await getAgentClient().listTools();

  const system = buildSystemPrompt(toolCatalog);
  let userContent = buildUserMessage(incident, evidence);
  let lastRawText = null;

  // Which credential actually answered — recorded on each ai_runs row so
  // the audit trail shows the provider that produced this diagnosis, not
  // whichever one happens to be primary at read time.
  let served = { provider: config.provider, model: config.model, credentialId: null };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const startedAt = Date.now();
    let result;
    try {
      result = await chatWithFailover({
        system,
        messages: [{ role: 'user', content: userContent }],
        responseSchema: require('./schema').DIAGNOSIS_SCHEMA
      }, {
        purpose: 'diagnosis',
        // Each failed credential gets its own ai_runs row, so an
        // exhausted key is visible as a real attempt rather than
        // disappearing behind whichever provider eventually answered.
        onAttemptError: ({ credential, error, latencyMs }) => recordAiRun({
          incidentId: incident.id, purpose: 'diagnosis',
          provider: credential.provider, model: credential.model, credentialId: credential.id,
          attempt, requestSummary: userContent, rawResponse: null, parsedJson: null,
          error: error.message, usage: null, latencyMs
        })
      });
      served = {
        provider: result.credential.provider,
        model: result.credential.model,
        credentialId: result.credential.id
      };
    } catch (err) {
      // Every individual credential failure was already recorded above;
      // this is the exhausted-chain outcome the operator needs to see.
      return { ok: false, rawText: null, error: err.message };
    }

    lastRawText = result.text;
    let parsed;
    try {
      parsed = JSON.parse(result.text);
    } catch {
      recordAiRun({
        incidentId: incident.id, purpose: 'diagnosis', provider: served.provider, model: served.model, credentialId: served.credentialId,
        attempt, requestSummary: userContent, rawResponse: result.text, parsedJson: null,
        error: 'Response was not valid JSON', usage: result.usage, latencyMs: Date.now() - startedAt
      });
      userContent = `${userContent}\n\nYour previous response was not valid JSON. Respond with ONLY the JSON object, no other text.`;
      continue;
    }

    const { valid, errors } = validate(parsed);
    if (!valid) {
      recordAiRun({
        incidentId: incident.id, purpose: 'diagnosis', provider: served.provider, model: served.model, credentialId: served.credentialId,
        attempt, requestSummary: userContent, rawResponse: result.text, parsedJson: parsed,
        error: `Schema validation failed: ${errors.join('; ')}`, usage: result.usage, latencyMs: Date.now() - startedAt
      });
      userContent = `${userContent}\n\nYour previous response failed schema validation: ${errors.join('; ')}. Respond again with a corrected JSON object.`;
      continue;
    }

    recordAiRun({
      incidentId: incident.id, purpose: 'diagnosis', provider: served.provider, model: served.model, credentialId: served.credentialId,
      attempt, requestSummary: userContent, rawResponse: result.text, parsedJson: parsed,
      error: null, usage: result.usage, latencyMs: Date.now() - startedAt
    });

    return {
      ok: true,
      diagnosis: {
        rootCause: parsed.rootCause,
        // The four below are UI-display fields — not required by the
        // schema (see ai/schema.js). Fall back safely so a terse
        // free-model response still renders and still gates on approval.
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : null,
        evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
        affectedComponents: Array.isArray(parsed.affectedComponents) ? parsed.affectedComponents : [],
        requiresApproval: parsed.requiresApproval !== false,
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

module.exports = {
  runDiagnosis, reconcileActions, buildSystemPrompt, buildUserMessage,
  countDiagnosisAttempts, renderToolCatalog
};
