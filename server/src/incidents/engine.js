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
const { evaluateAutoRemediation } = require('../settings/autoRemediate');

/** Evidence summary for an approved investigation action's output. */
const INVESTIGATION_SUMMARY_LIMIT = 4000;

function summarizeToolResult(toolName, result) {
  if (result == null) return `${toolName}: (no output)`;
  // Log tools return arrays of {stream, text} or plain strings.
  const text = Array.isArray(result)
    ? result.map(l => (typeof l === 'string' ? l : `[${l.stream}] ${l.text}`)).join('\n')
    : JSON.stringify(result);
  return text.length > INVESTIGATION_SUMMARY_LIMIT
    ? `${text.slice(0, INVESTIGATION_SUMMARY_LIMIT)}\n… (truncated)`
    : text;
}

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

  store.recordDiagnosis(incidentId, diagnosisResult.diagnosis);
  logEvent('INCIDENT_DIAGNOSED', `Incident #${incidentId} diagnosed: ${diagnosisResult.diagnosis.rootCause}`);

  const added = diagnosisResult.diagnosis.actions.map(action => store.addAction(incidentId, action));

  if (added.length === 0) return store.getIncident(incidentId); // stays DIAGNOSED

  store.updateIncidentStatus(incidentId, 'AWAITING_APPROVAL');

  return maybeAutoRemediate(incidentId, added);
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

  // Called from the detector with no `actions` when re-checking an
  // incident that was already sitting at AWAITING_APPROVAL when the
  // operator ticked its resource in Settings — the diagnosis (and its
  // proposed actions) already exist, only the opt-in is new.
  const candidates = actions ?? store.getActions(incidentId).filter(a => a.status === 'proposed');

  for (const action of candidates) {
    const { allowed, reason } = evaluateAutoRemediation({
      resource, toolName: action.tool_name, realRisk: action.real_risk
    });
    if (!allowed) continue;

    logEvent('INCIDENT_AUTO_REMEDIATE',
      `Incident #${incidentId}: auto-approving ${action.tool_name} — ${reason}`);
    // userId stays null: that's what marks the row as machine-approved,
    // both in the audit trail and for the rate-limit query.
    return runRemediationAction(incidentId, action, null, {});
  }

  return incident;
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
async function approve(incidentId, { actionId, userId = null } = {}, verifyOpts = {}) {
  const incident = store.getIncident(incidentId);
  if (!incident) throw new Error(`Incident ${incidentId} not found`);

  const action = store.getAction(actionId);
  if (!action || action.incident_id !== incidentId) throw new Error('Action not found for this incident');

  return action.real_risk === 'READ_ONLY'
    ? runInvestigationAction(incident, action, userId)
    : runRemediationAction(incidentId, action, userId, verifyOpts);
}

/** READ_ONLY: execute, append the output as evidence, leave the state alone. */
async function runInvestigationAction(incident, action, userId) {
  const incidentId = incident.id;
  store.updateActionStatus(action.id, 'approved', { approved_by: userId, approved_at: Date.now() });
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

/** Above READ_ONLY: the real remediation path, with verification. */
async function runRemediationAction(incidentId, action, userId, verifyOpts) {
  const actionId = action.id;

  store.updateIncidentStatus(incidentId, 'REMEDIATING');
  store.updateActionStatus(actionId, 'approved', { approved_by: userId, approved_at: Date.now() });
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
    return store.getIncident(incidentId);
  }

  store.updateActionStatus(actionId, 'executed', { executed_at: Date.now(), result_json: JSON.stringify(execResult) });
  logEvent('INCIDENT_ACTION_EXECUTED', `Incident #${incidentId}: executed ${action.tool_name}`);

  store.updateIncidentStatus(incidentId, 'VERIFYING');
  const verifyResult = await verifyAction(action.tool_name, action.params, verifyOpts);

  if (verifyResult.ok) {
    store.recordResolution(incidentId, 'RESOLVED');
    logEvent('INCIDENT_RESOLVED', `Incident #${incidentId} resolved`);
  } else {
    store.recordResolution(incidentId, 'FAILED');
    logEvent('INCIDENT_FAILED', `Incident #${incidentId}: action executed but verification never converged`);
  }

  return store.getIncident(incidentId);
}

function dismiss(incidentId) {
  const incident = store.updateIncidentStatus(incidentId, 'DISMISSED', { resolved_at: Date.now() });
  logEvent('INCIDENT_DISMISSED', `Incident #${incidentId} dismissed`);
  return incident;
}

module.exports = { startInvestigation, rediagnose, approve, dismiss, maybeAutoRemediate };
