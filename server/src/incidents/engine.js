'use strict';

const store = require('./store');
const { gatherEvidence } = require('../context/engine');
const { runDiagnosis } = require('../ai/orchestrator');
const { callToolAudited } = require('./toolCallAudit');
const { suppressForToolCall } = require('./suppression');
const { verifyAction } = require('../verify/engine');
const { logEvent } = require('../activity/logger');
const { getResource } = require('../graph/resources');
const { redact } = require('../ai/redact');
const { summarizeToolResult } = require('../ai/summarize');
const { generateReport } = require('../ai/report');
const { getAIConfig } = require('../settings/aiConfig');
const { notifyIncident } = require('../notify');
const { evaluateAutoRemediation, canonicalRemediation } = require('../settings/autoRemediate');
const { getAgentClient } = require('../agent/client');

/**
 * Ask the AI for a diagnosis against `evidenceRows` and apply the
 * result. Shared by the first investigation and any later re-diagnosis
 * so both paths handle a malformed response identically: the incident
 * stays at INVESTIGATING with the raw text preserved for a human — it
 * never silently invents a diagnosis. A successful diagnosis with at
 * least one recommended action moves to AWAITING_APPROVAL; one with none
 * stays at DIAGNOSED (nothing to approve, but not auto-dismissed either).
 */
async function diagnoseWithEvidence(incidentId, evidenceRows) {
  const incident = store.getIncident(incidentId);
  const resource = getResource(incident.resource_id);

  const diagnosisResult = await runDiagnosis({ ...incident, resourceName: resource?.name }, evidenceRows);

  if (!diagnosisResult.ok) {
    store.recordInvestigationFailure(incidentId, diagnosisResult.rawText);
    logEvent('AI_CALL_FAILED', `Diagnosis failed for incident #${incidentId}: ${diagnosisResult.error || 'invalid AI response'}`);
    return store.getIncident(incidentId);
  }

  return applyDiagnosis(incidentId, diagnosisResult.diagnosis);
}

/**
 * Store a diagnosis (real, from the AI, or synthetic, from a matched
 * runbook — see `applyRunbook` below) and propose its actions. Shared by
 * both so a runbook match auto-executes through the exact same
 * `maybeAutoRemediate` gates an AI-proposed action does, with zero
 * separate auto-execute path to keep in sync.
 *
 * Requires the incident to already be at INVESTIGATING — `recordDiagnosis`
 * transitions INVESTIGATING -> DIAGNOSED, and both callers (the real AI
 * path via `startInvestigation`, and `applyRunbook` below) put it there
 * first.
 */
function applyDiagnosis(incidentId, diagnosis) {
  store.recordDiagnosis(incidentId, diagnosis);
  logEvent('INCIDENT_DIAGNOSED', `Incident #${incidentId} diagnosed: ${diagnosis.rootCause}`);

  const added = diagnosis.actions.map(action => store.addAction(incidentId, action));

  if (added.length > 0) {
    store.updateIncidentStatus(incidentId, 'AWAITING_APPROVAL');
    // The one notification that carries a one-click approve button: the
    // first proposed action is what a human is being asked to decide on.
    notifyIncident('INCIDENT_AWAITING_APPROVAL', incidentId, { action: added[0] });
  }
  // Even with zero proposed actions, an opted-in resource with a
  // deterministic trigger still gets its canonical remediation.
  return maybeAutoRemediate(incidentId, added);
}

/**
 * Apply a matched runbook (settings-free, AI-free) as if it were a
 * diagnosis: DETECTED -> INVESTIGATING -> DIAGNOSED -> (AWAITING_APPROVAL
 * if the action was proposed), via the same `applyDiagnosis` tail an AI
 * diagnosis uses — so a runbook match for an opted-in resource
 * auto-executes through the exact existing `evaluateAutoRemediation`
 * gates, and for a non-opted-in resource still requires the normal human
 * approve click. Runbooks change WHAT gets proposed and HOW CHEAPLY,
 * never WHETHER a human approves it.
 *
 * Resolves the tool's real registered risk from the agent's live catalog
 * rather than trusting anything about the runbook match itself — the
 * same "never trust a derived recommendation, cross-check the catalog"
 * posture Architecture decision #12 already applies to AI output.
 */
async function applyRunbook(incident, resource, match) {
  const incidentId = incident.id;
  store.updateIncidentStatus(incidentId, 'INVESTIGATING');

  let realRisk;
  try {
    const catalog = await getAgentClient().listTools();
    realRisk = catalog.find(t => t.name === match.tool)?.risk;
  } catch (err) {
    console.error(`[engine] could not resolve risk for runbook tool ${match.tool}:`, err.message);
  }
  if (!realRisk) {
    // The tool the runbook remembers is no longer in the agent's live
    // catalog (renamed, removed) — fall back to a normal AI diagnosis
    // rather than proposing something the agent would reject outright.
    return startInvestigationFromInvestigating(incidentId);
  }

  const recoveryNote = match.avgRecoveryMs
    ? `, usually resolving in ~${Math.round(match.avgRecoveryMs / 1000)}s`
    : '';
  const diagnosis = {
    rootCause: `Known fix for a ${incident.trigger_rule} incident: ${match.tool} has resolved this ${match.successes}/${match.total} times before${recoveryNote}. No AI request was used.`,
    confidence: null,
    evidence: [],
    affectedComponents: [],
    requiresApproval: true,
    source: 'runbook',
    successes: match.successes,
    failures: match.failures,
    avgRecoveryMs: match.avgRecoveryMs,
    actions: [{
      tool: match.tool,
      params: { [match.paramKey]: resource.external_id },
      claimedRisk: null,
      realRisk,
      rationale: `Known fix — resolved a ${incident.trigger_rule} incident on this resource type ${match.successes}/${match.total} times before, most recently a success. No AI request was used.`
    }]
  };

  return applyDiagnosis(incidentId, diagnosis);
}

/**
 * Full gather-evidence-then-diagnose pass starting from INVESTIGATING
 * (not DETECTED) — the shared tail `applyRunbook`'s catalog-miss fallback
 * needs, since `startInvestigation` itself always begins at DETECTED.
 */
async function startInvestigationFromInvestigating(incidentId) {
  const incident = store.getIncident(incidentId);
  const evidenceRows = await gatherEvidence(incident);
  store.addEvidence(incidentId, evidenceRows);
  return diagnoseWithEvidence(incidentId, evidenceRows);
}

/**
 * Opt-in auto-remediation (settings/autoRemediate.js). The default is
 * still "a human clicks approve" for everything — this only fires for a
 * resource explicitly opted in, and only for a restorative tool inside
 * the code-level allowlist and under its rate limit.
 *
 * Only the *first* eligible action is auto-run, never a whole plan: one
 * remediation then verification is the loop this engine is built around,
 * and running several unattended actions before checking whether the
 * first one worked is how automation turns a small outage into a large
 * one. If it doesn't converge, the incident ends FAILED and a human
 * picks it up — exactly as with a manually approved action.
 */
async function maybeAutoRemediate(incidentId, actions) {
  const incident = store.getIncident(incidentId);
  const resource = getResource(incident.resource_id);
  if (!resource) return incident;

  // Called from the detector with no `actions` when re-checking an
  // incident that was already sitting at AWAITING_APPROVAL when the
  // operator ticked its resource in Settings — the diagnosis (and its
  // proposed actions) already exist, only the opt-in is new.
  const candidates = actions ?? store.getActions(incidentId).filter(a => a.status === 'proposed');

  // 1. Prefer an AI-proposed action that clears every gate.
  for (const action of candidates) {
    const { allowed, reason } = evaluateAutoRemediation({
      resource, toolName: action.tool_name, realRisk: action.real_risk
    });
    if (!allowed) continue;
    return runAutoAction(incidentId, action, reason);
  }

  // 2. Fallback: the trigger is deterministic ground truth. A
  //    `service_inactive` incident means the service is not running —
  //    "restart it" doesn't need the model to have said so, and a
  //    weaker model routinely proposes only "look at the logs". Still
  //    every gate in evaluateAutoRemediation applies (opt-in, the tool
  //    allowlist, the risk ceiling, the rate limit).
  const canonical = canonicalRemediation(incident.trigger_rule, resource);
  if (!canonical) return incident;
  if (candidates.some(a => a.tool_name === canonical.tool)) return incident; // already tried above and refused (e.g. rate limit)

  let realRisk;
  try {
    const catalog = await getAgentClient().listTools();
    realRisk = catalog.find(t => t.name === canonical.tool)?.risk;
  } catch (err) {
    console.error(`[engine] could not resolve risk for canonical ${canonical.tool}:`, err.message);
    return incident;
  }
  if (!realRisk) return incident;

  const { allowed, reason } = evaluateAutoRemediation({ resource, toolName: canonical.tool, realRisk });
  if (!allowed) return incident;

  if (incident.status === 'DIAGNOSED') store.updateIncidentStatus(incidentId, 'AWAITING_APPROVAL');
  const action = store.addAction(incidentId, {
    tool: canonical.tool, params: canonical.params, claimedRisk: null, realRisk,
    rationale: `Canonical remediation for a ${incident.trigger_rule} incident — the AI diagnosis proposed no restorative action, so Sentinel derived one from the trigger.`
  });
  return runAutoAction(incidentId, action, `canonical: ${reason}`);
}

function runAutoAction(incidentId, action, reason) {
  logEvent('INCIDENT_AUTO_REMEDIATE',
    `Incident #${incidentId}: auto-approving ${action.tool_name} — ${reason}`);
  notifyIncident('INCIDENT_AUTO_REMEDIATE', incidentId, { action });
  // userId stays null AND approved_via is 'auto'. The latter is what the
  // rate-limit query actually counts now — a one-click approval from a
  // notification also has no user id, and must not consume the
  // auto-remediation budget (see settings/autoRemediate.js).
  return runRemediationAction(incidentId, action, null, {}, 'auto');
}

/** DETECTED -> INVESTIGATING: gather evidence, then diagnose against it. */
async function startInvestigation(incidentId) {
  const incident = store.getIncident(incidentId);
  if (!incident) throw new Error(`Incident ${incidentId} not found`);

  store.updateIncidentStatus(incidentId, 'INVESTIGATING');

  const evidenceRows = await gatherEvidence(incident);
  store.addEvidence(incidentId, evidenceRows);

  return diagnoseWithEvidence(incidentId, evidenceRows);
}

/**
 * Re-run diagnosis against everything currently known, including
 * evidence appended by approved READ_ONLY investigation actions.
 *
 * This is what closes the loop when a model says, in effect, "I can't
 * tell from this — go look at the logs": you approve the investigation
 * action it asked for, its output lands as evidence, and this re-asks
 * with that in hand. Previously-proposed actions are marked `superseded`
 * so the UI doesn't accumulate stale recommendations from a diagnosis
 * that has since been replaced.
 */
async function rediagnose(incidentId) {
  const incident = store.getIncident(incidentId);
  if (!incident) throw new Error(`Incident ${incidentId} not found`);

  for (const action of store.getActions(incidentId)) {
    if (action.status === 'proposed') store.updateActionStatus(action.id, 'superseded');
  }

  store.updateIncidentStatus(incidentId, 'INVESTIGATING');
  logEvent('INCIDENT_REDIAGNOSE', `Incident #${incidentId}: re-diagnosing with ${store.getEvidence(incidentId).length} evidence rows`);

  // Everything gathered so far — the original context sweep plus any
  // investigation-action output — replayed in the shape runDiagnosis wants.
  const evidenceRows = store.getEvidence(incidentId).map(e => ({
    resourceId: e.resource_id, sourceTool: e.source_tool, summary: e.summary, data: e.data
  }));

  return diagnoseWithEvidence(incidentId, evidenceRows);
}

/**
 * "Ask AI instead" — for when a runbook-only diagnosis isn't trusted
 * this time. NOT the same as `rediagnose`: that one reuses whatever
 * evidence already exists, which is correct for its own use case
 * (re-asking after an approved READ_ONLY investigation action added
 * evidence), but a runbook-only incident has ZERO evidence rows —
 * evidence-gathering was exactly what a runbook match skips. This does
 * the full gather-then-diagnose pass `startInvestigation` would have
 * done, just from a non-DETECTED starting state.
 */
async function forceAiDiagnosis(incidentId) {
  const incident = store.getIncident(incidentId);
  if (!incident) throw new Error(`Incident ${incidentId} not found`);

  for (const action of store.getActions(incidentId)) {
    if (action.status === 'proposed') store.updateActionStatus(action.id, 'superseded');
  }

  store.updateIncidentStatus(incidentId, 'INVESTIGATING');
  logEvent('INCIDENT_REDIAGNOSE', `Incident #${incidentId}: asking the AI instead of the matched runbook`);

  const evidenceRows = await gatherEvidence(incident);
  store.addEvidence(incidentId, evidenceRows);

  return diagnoseWithEvidence(incidentId, evidenceRows);
}

/**
 * A human approves one proposed action. Every AI-recommended action
 * requires this regardless of its real risk (decision #13) — there is no
 * auto-remediate path.
 *
 * Two genuinely different kinds of action come through here:
 *
 * 1. READ_ONLY — an *investigation* step ("show me the logs"), not a
 *    remediation. It mutates nothing and has no `verify` check, so it
 *    must never drive the remediation state machine: it runs, its output
 *    is appended as evidence, and the incident stays exactly where it
 *    was, ready for another action or a re-diagnosis. Running it through
 *    the REMEDIATING -> VERIFYING path instead (as this originally did)
 *    guaranteed a terminal FAILED, since verifying a tool with no verify
 *    function can only ever fail — approving *any* investigation action
 *    killed the incident.
 *
 * 2. Everything above READ_ONLY — a real remediation. AWAITING_APPROVAL
 *    -> REMEDIATING -> VERIFYING -> RESOLVED | FAILED. Execution failure
 *    short-circuits to FAILED and never reaches the verify step; only a
 *    tool call that actually ran gets verified — "executed" and
 *    "resolved" are never conflated (decision #6).
 *
 * One exception to "throw -> FAILED": a *pre-execution* rejection by the
 * agent (a 400 "Invalid parameters" or 404 "unknown tool" — the agent
 * validated the request and never ran the handler) is deterministic and
 * mutated nothing, so it rolls the incident back to AWAITING_APPROVAL
 * (marking that action 'rejected') instead of burning it to terminal
 * FAILED. A human can then approve a different recommended action, or
 * dismiss.
 */
async function approve(incidentId, { actionId, userId = null, via = 'ui' } = {}, verifyOpts = {}) {
  const incident = store.getIncident(incidentId);
  if (!incident) throw new Error(`Incident ${incidentId} not found`);

  const action = store.getAction(actionId);
  if (!action || action.incident_id !== incidentId) throw new Error('Action not found for this incident');

  return action.real_risk === 'READ_ONLY'
    ? runInvestigationAction(incident, action, userId, via)
    : runRemediationAction(incidentId, action, userId, verifyOpts, via);
}

/** READ_ONLY: execute, append the output as evidence, leave the state alone. */
async function runInvestigationAction(incident, action, userId, via = 'ui') {
  const incidentId = incident.id;
  store.updateActionStatus(action.id, 'approved', { approved_by: userId, approved_at: Date.now(), approved_via: via });
  logEvent('INCIDENT_APPROVED', `Incident #${incidentId}: approved investigation ${action.tool_name}`);

  let result;
  try {
    result = await callToolAudited(incidentId, action.tool_name, action.params, {
      approved: true, requestedBy: 'investigation', incidentActionId: action.id, realRisk: action.real_risk
    });
  } catch (err) {
    // An investigation step failing tells us nothing about the incident
    // itself — it stays open and approvable, only the action is marked.
    store.updateActionStatus(action.id, 'failed', { executed_at: Date.now(), error: err.message });
    logEvent('INCIDENT_ACTION_FAILED',
      `Incident #${incidentId}: investigation ${action.tool_name} failed: ${err.message}`);
    return store.getIncident(incidentId);
  }

  store.updateActionStatus(action.id, 'executed', { executed_at: Date.now(), result_json: JSON.stringify(result) });
  store.addEvidence(incidentId, [{
    resourceId: incident.resource_id,
    sourceTool: action.tool_name,
    summary: redact(summarizeToolResult(action.tool_name, result)),
    data: result
  }]);
  logEvent('INCIDENT_ACTION_EXECUTED',
    `Incident #${incidentId}: investigation ${action.tool_name} executed, output added as evidence`);

  return store.getIncident(incidentId);
}

/**
 * Kick off the AI post-incident report once an incident has closed.
 *
 * Fire-and-forget and fully isolated: the incident's outcome is already
 * recorded by the time this runs, and a report that fails to generate —
 * bad key, exhausted quota, a model that won't return valid JSON — must
 * never change that outcome or throw into the remediation path. The
 * operator can regenerate it by hand from the incident page.
 */
function writePostIncidentReport(incidentId) {
  if (!getAIConfig().configured) return;
  generateReport(incidentId)
    .then(result => {
      if (!result.ok) console.error(`[engine] report for #${incidentId} failed:`, result.error);
    })
    .catch(err => console.error(`[engine] report for #${incidentId} threw:`, err.message));
}

/** Above READ_ONLY: the real remediation path, with verification. */
async function runRemediationAction(incidentId, action, userId, verifyOpts, via = 'ui') {
  const actionId = action.id;

  store.updateIncidentStatus(incidentId, 'REMEDIATING');
  store.updateActionStatus(actionId, 'approved', { approved_by: userId, approved_at: Date.now(), approved_via: via });
  logEvent('INCIDENT_APPROVED', `Incident #${incidentId}: approved ${action.tool_name}`);

  // A remediation restarts/stops the very resource being watched — the
  // detector must not treat that as a fresh incident (suppression.js).
  suppressForToolCall(action.tool_name, action.params);

  let execResult;
  try {
    execResult = await callToolAudited(incidentId, action.tool_name, action.params, {
      approved: true, requestedBy: 'remediation', incidentActionId: actionId, realRisk: action.real_risk
    });
  } catch (err) {
    const rejectedBeforeExecution =
      err.name === 'AgentError' && (err.status === 400 || err.status === 404);

    if (rejectedBeforeExecution) {
      store.updateActionStatus(actionId, 'rejected', { executed_at: Date.now(), error: err.message });
      const reverted = store.updateIncidentStatus(incidentId, 'AWAITING_APPROVAL');
      logEvent('INCIDENT_ACTION_REJECTED',
        `Incident #${incidentId}: ${action.tool_name} rejected before execution (${err.message}) — back to AWAITING_APPROVAL`);
      return reverted;
    }

    store.updateActionStatus(actionId, 'failed', { executed_at: Date.now(), error: err.message });
    store.recordResolution(incidentId, 'FAILED');
    logEvent('INCIDENT_FAILED', `Incident #${incidentId}: execution of ${action.tool_name} failed: ${err.message}`);
    notifyIncident('INCIDENT_FAILED', incidentId, { action });
    writePostIncidentReport(incidentId);
    return store.getIncident(incidentId);
  }

  store.updateActionStatus(actionId, 'executed', { executed_at: Date.now(), result_json: JSON.stringify(execResult) });
  logEvent('INCIDENT_ACTION_EXECUTED', `Incident #${incidentId}: executed ${action.tool_name}`);

  store.updateIncidentStatus(incidentId, 'VERIFYING');
  const verifyResult = await verifyAction(action.tool_name, action.params, verifyOpts);

  if (verifyResult.ok) {
    store.recordResolution(incidentId, 'RESOLVED');
    logEvent('INCIDENT_RESOLVED', `Incident #${incidentId} resolved`);
    notifyIncident('INCIDENT_RESOLVED', incidentId, { action });
  } else {
    store.recordResolution(incidentId, 'FAILED');
    logEvent('INCIDENT_FAILED', `Incident #${incidentId}: action executed but verification never converged`);
    notifyIncident('INCIDENT_FAILED', incidentId, { action });
  }

  writePostIncidentReport(incidentId);
  return store.getIncident(incidentId);
}

function dismiss(incidentId) {
  const incident = store.updateIncidentStatus(incidentId, 'DISMISSED', { resolved_at: Date.now() });
  logEvent('INCIDENT_DISMISSED', `Incident #${incidentId} dismissed`);
  return incident;
}

module.exports = { startInvestigation, rediagnose, forceAiDiagnosis, applyRunbook, approve, dismiss, maybeAutoRemediate };
