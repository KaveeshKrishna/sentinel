'use strict';

const { getDb } = require('../db/connection');
const { getAgentClient } = require('../agent/client');

/**
 * Every Phase-3 module goes through this instead of calling
 * getAgentClient() directly, so `tool_executions` is a complete audit
 * trail of every tool call made on an incident's behalf by construction,
 * not by convention.
 *
 * @param {number|null} incidentId
 * @param {string} name - registered agent tool name
 * @param {object} [params]
 * @param {object} [opts]
 * @param {boolean} [opts.approved]
 * @param {string} opts.requestedBy - 'detector' | 'context' | 'diagnosis' | 'remediation' | 'verification' | 'user'
 * @param {number|null} [opts.incidentActionId]
 * @param {string|null} [opts.realRisk] - the tool's real risk, if already known (avoids a second catalog lookup)
 */
async function callToolAudited(incidentId, name, params = {}, { approved = false, requestedBy, incidentActionId = null, realRisk = null } = {}) {
  const startedAt = Date.now();
  try {
    const result = await getAgentClient().callTool(name, params, { approved });
    recordExecution({
      incidentId, incidentActionId, toolName: name, params, realRisk, approved,
      requestedBy, status: 'ok', result, error: null, startedAt
    });
    return result;
  } catch (err) {
    recordExecution({
      incidentId, incidentActionId, toolName: name, params, realRisk, approved,
      requestedBy, status: 'error', result: null, error: err.message, startedAt
    });
    throw err;
  }
}

function recordExecution({ incidentId, incidentActionId, toolName, params, realRisk, approved, requestedBy, status, result, error, startedAt }) {
  const finishedAt = Date.now();
  getDb().prepare(`
    INSERT INTO tool_executions (incident_id, incident_action_id, tool_name, params_json, real_risk, approved,
                                  requested_by, status, result_json, error, started_at, finished_at, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    incidentId ?? null, incidentActionId ?? null, toolName, JSON.stringify(params || {}), realRisk,
    approved ? 1 : 0, requestedBy, status, result ? JSON.stringify(result) : null, error,
    startedAt, finishedAt, finishedAt - startedAt
  );
}

module.exports = { callToolAudited };
