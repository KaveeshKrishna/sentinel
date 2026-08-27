'use strict';

const store = require('./store');
const { gatherEvidence } = require('../context/engine');
const { runDiagnosis } = require('../ai/orchestrator');
const { callToolAudited } = require('./toolCallAudit');
const { verifyAction } = require('../verify/engine');
const { logEvent } = require('../activity/logger');
const { getResource } = require('../graph/resources');

/**
 * DETECTED -> INVESTIGATING: gather evidence, ask the AI for a diagnosis.
 * A malformed/invalid AI response leaves the incident at INVESTIGATING
 * (self-loop) with the raw text preserved for a human to read — it never
 * silently invents a diagnosis. A successful diagnosis with at least one
 * recommended action moves to AWAITING_APPROVAL; one with none stays at
 * DIAGNOSED (nothing to approve, but not auto-dismissed either).
 */
async function startInvestigation(incidentId) {
  const incident = store.getIncident(incidentId);
  if (!incident) throw new Error(`Incident ${incidentId} not found`);

  store.updateIncidentStatus(incidentId, 'INVESTIGATING');

  const resource = getResource(incident.resource_id);
  const evidenceRows = await gatherEvidence(incident);
  store.addEvidence(incidentId, evidenceRows);

  const diagnosisResult = await runDiagnosis({ ...incident, resourceName: resource?.name }, evidenceRows);

  if (!diagnosisResult.ok) {
    store.recordInvestigationFailure(incidentId, diagnosisResult.rawText);
    logEvent('AI_CALL_FAILED', `Diagnosis failed for incident #${incidentId}: ${diagnosisResult.error || 'invalid AI response'}`);
    return store.getIncident(incidentId);
  }

  store.recordDiagnosis(incidentId, diagnosisResult.diagnosis);
  logEvent('INCIDENT_DIAGNOSED', `Incident #${incidentId} diagnosed: ${diagnosisResult.diagnosis.rootCause}`);

  for (const action of diagnosisResult.diagnosis.actions) {
    store.addAction(incidentId, action);
  }

  if (diagnosisResult.diagnosis.actions.length > 0) {
    store.updateIncidentStatus(incidentId, 'AWAITING_APPROVAL');
  }

  return store.getIncident(incidentId);
}

/**
 * A human approves one proposed action. Every AI-recommended action
 * requires this regardless of its real risk (decision #1) — there is no
 * auto-remediate path in this phase. Execution failure (the tool call
 * itself throwing) short-circuits straight to FAILED and never reaches
 * the verify step; only a tool call that actually ran gets verified —
 * "executed" and "resolved" are never conflated.
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

  store.updateIncidentStatus(incidentId, 'REMEDIATING');
  store.updateActionStatus(actionId, 'approved', { approved_by: userId, approved_at: Date.now() });
  logEvent('INCIDENT_APPROVED', `Incident #${incidentId}: approved ${action.tool_name}`);

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

module.exports = { startInvestigation, approve, dismiss };
