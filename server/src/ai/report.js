'use strict';

const { getDb } = require('../db/connection');
const { getAIConfig } = require('../settings/aiConfig');
const { chatWithFailover } = require('./failover');
const { REPORT_SCHEMA, validateReport } = require('./schema');
const { recordAiRun } = require('./runs');
const { redact } = require('./redact');
const { getTimeline } = require('../incidents/timeline');
const { getResource } = require('../graph/resources');
const store = require('../incidents/store');

const SYSTEM_PROMPT = [
  'You are Sentinel, an AI infrastructure engineer writing a post-incident report for the operator',
  'of a self-hosted server, after the incident has already closed.',
  '',
  'Respond with ONLY a JSON object — no prose, no markdown fences — with these fields:',
  '  title      — a short headline, e.g. "demo-db exited, taking demo-api with it"',
  '  summary    — 2-3 sentences: what happened, in plain language',
  '  impact     — what was actually affected, and for how long',
  '  rootCause  — why it happened, grounded in the evidence below',
  '  resolution — what was done, and whether it was verified to have worked',
  '  timeline   — an array of short strings, one per significant moment, each starting with a time',
  '  prevention — an array of concrete, specific suggestions to stop this recurring',
  '',
  'Write for someone who was asleep when it happened. Be concrete and use the real names, numbers',
  'and timestamps from the data. Never invent detail that is not in the evidence — if the cause is',
  'genuinely unclear from what was collected, say so in rootCause rather than guessing plausibly.',
  'If the incident ended in FAILED, say plainly that it was not resolved and what remains to be done.',
  'For prevention, prefer specific measures (a healthcheck, a memory limit, an alert threshold) over',
  'generic advice like "improve monitoring". Return an empty array if you genuinely have none.'
].join('\n');

function buildReportMessage(incident, resource, evidence, actions, timeline) {
  const lines = [
    `Incident #${incident.id} — final status: ${incident.status}`,
    `Resource: ${resource ? `${resource.name} (${resource.type})` : incident.resource_id}`,
    `Trigger: ${incident.trigger_rule} — ${incident.trigger_summary}`,
    `Detected: ${new Date(incident.detected_at).toISOString()}`,
    incident.resolved_at ? `Closed: ${new Date(incident.resolved_at).toISOString()}` : 'Closed: (still open)',
    ''
  ];

  if (incident.root_cause) {
    lines.push(`Diagnosis at the time: ${incident.root_cause}`, '');
  }

  lines.push('Evidence collected:');
  for (const e of evidence) lines.push(`- [${e.source_tool}] ${redact(e.summary)}`);
  lines.push('');

  lines.push('Actions:');
  if (actions.length === 0) lines.push('- (none proposed)');
  for (const a of actions) {
    const via = a.approved_via ? ` approved via ${a.approved_via}` : '';
    lines.push(`- ${a.tool_name} (${a.real_risk}) — ${a.status}${via}${a.error ? ` — error: ${a.error}` : ''}`);
  }
  lines.push('');

  lines.push('Recorded timeline:');
  for (const t of timeline) {
    const ts = new Date(t.at).toISOString();
    if (t.kind === 'transition') lines.push(`- ${ts} state ${t.from || '(new)'} -> ${t.to}`);
    else if (t.kind === 'tool') lines.push(`- ${ts} ran ${t.tool} (${t.status}, ${t.durationMs}ms)`);
    else if (t.kind === 'ai') lines.push(`- ${ts} AI ${t.purpose} attempt ${t.attempt} ${t.ok ? 'ok' : 'failed'}`);
    else if (t.kind === 'action') lines.push(`- ${ts} proposed ${t.tool}`);
  }

  return lines.join('\n');
}

/**
 * Render a stored report as markdown, for the UI's copy button and for
 * pasting into a wiki or ticket. Derived from the validated structure
 * rather than asked of the model, so the output shape is deterministic.
 */
function renderReportMarkdown(report, incident) {
  if (!report) return '';
  const out = [`# ${report.title || `Incident #${incident?.id ?? ''} post-incident report`}`, ''];

  if (incident) {
    out.push(`**Status:** ${incident.status}  `);
    out.push(`**Detected:** ${new Date(incident.detected_at).toISOString()}  `);
    if (incident.resolved_at) out.push(`**Closed:** ${new Date(incident.resolved_at).toISOString()}  `);
    out.push('');
  }

  out.push('## Summary', '', report.summary, '');
  if (report.impact) out.push('## Impact', '', report.impact, '');
  out.push('## Root cause', '', report.rootCause, '');
  if (report.resolution) out.push('## Resolution', '', report.resolution, '');

  if (report.timeline?.length) {
    out.push('## Timeline', '');
    for (const t of report.timeline) out.push(`- ${t}`);
    out.push('');
  }
  if (report.prevention?.length) {
    out.push('## Prevention', '');
    for (const p of report.prevention) out.push(`- ${p}`);
    out.push('');
  }

  out.push('---', '', '_Written by Sentinel._');
  return out.join('\n');
}

/**
 * Ask the AI for a post-incident report and store it on the incident.
 *
 * Called fire-and-forget when an incident closes, and on demand from the
 * UI. A single attempt: unlike a diagnosis, nothing downstream acts on
 * this — it is a document for a human — so a failure is worth surfacing
 * and retrying by hand rather than automatically burning provider quota.
 *
 * @returns {Promise<{ok: true, report} | {ok: false, error}>}
 */
async function generateReport(incidentId) {
  const incident = store.getIncident(incidentId);
  if (!incident) return { ok: false, error: `Incident ${incidentId} not found` };

  const config = getAIConfig();
  if (!config.configured) return { ok: false, error: 'No AI provider configured' };

  const resource = getResource(incident.resource_id);
  const evidence = store.getEvidence(incidentId);
  const actions = store.getActions(incidentId);
  const { entries } = getTimeline(incidentId, incident);

  const userContent = buildReportMessage(incident, resource, evidence, actions, entries);
  const startedAt = Date.now();

  // Which credential served this — every ai_runs row below names it, so
  // a report generated by the second key in the chain says so.
  let served = { provider: config.provider, model: config.model, credentialId: null };

  let result;
  try {
    result = await chatWithFailover({
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
      responseSchema: REPORT_SCHEMA
    }, {
      purpose: 'report',
      // Still single-attempt per credential by design (nothing acts on a
      // report, so a failure is worth surfacing rather than retrying) —
      // but a dead credential should not stop the next one being tried.
      onAttemptError: ({ credential, error, latencyMs }) => recordAiRun({
        incidentId, purpose: 'report',
        provider: credential.provider, model: credential.model, credentialId: credential.id, attempt: 1,
        requestSummary: userContent, rawResponse: null, parsedJson: null,
        error: error.message, usage: null, latencyMs
      })
    });
    served = {
      provider: result.credential.provider,
      model: result.credential.model,
      credentialId: result.credential.id
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }

  let parsed;
  try {
    parsed = JSON.parse(result.text);
  } catch {
    recordAiRun({
      incidentId, purpose: 'report', provider: served.provider, model: served.model, credentialId: served.credentialId, attempt: 1,
      requestSummary: userContent, rawResponse: result.text, parsedJson: null,
      error: 'Response was not valid JSON', usage: result.usage, latencyMs: Date.now() - startedAt
    });
    return { ok: false, error: 'The model did not return valid JSON' };
  }

  const { valid, errors } = validateReport(parsed);
  if (!valid) {
    recordAiRun({
      incidentId, purpose: 'report', provider: served.provider, model: served.model, credentialId: served.credentialId, attempt: 1,
      requestSummary: userContent, rawResponse: result.text, parsedJson: parsed,
      error: `Schema validation failed: ${errors.join('; ')}`, usage: result.usage, latencyMs: Date.now() - startedAt
    });
    return { ok: false, error: `Report failed validation: ${errors.join('; ')}` };
  }

  recordAiRun({
    incidentId, purpose: 'report', provider: served.provider, model: served.model, credentialId: served.credentialId, attempt: 1,
    requestSummary: userContent, rawResponse: result.text, parsedJson: parsed,
    error: null, usage: result.usage, latencyMs: Date.now() - startedAt
  });

  saveReport(incidentId, parsed);
  return { ok: true, report: parsed };
}

function saveReport(incidentId, report) {
  getDb()
    .prepare('UPDATE incidents SET report_json = ?, report_generated_at = ? WHERE id = ?')
    .run(JSON.stringify(report), Date.now(), incidentId);
}

function getReport(incidentId) {
  const row = getDb()
    .prepare('SELECT report_json, report_generated_at FROM incidents WHERE id = ?')
    .get(incidentId);
  if (!row || !row.report_json) return null;
  return { report: JSON.parse(row.report_json), generatedAt: row.report_generated_at };
}

module.exports = { generateReport, getReport, saveReport, renderReportMarkdown, buildReportMessage };
