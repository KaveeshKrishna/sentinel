'use strict';

const RISK_LEVELS = ['READ_ONLY', 'LOW_RISK', 'MEDIUM_RISK', 'HIGH_RISK', 'DESTRUCTIVE'];

/**
 * Default policy: which risk levels may execute without an explicit,
 * human-sourced approval. Intentionally conservative — only READ_ONLY
 * tools run unattended. Everything else requires the caller (the server,
 * after its own approval workflow) to mark the request approved.
 * DESTRUCTIVE can never be configured to auto-approve — see isAuthorized.
 */
const DEFAULT_AUTO_APPROVE = {
  READ_ONLY: true,
  LOW_RISK: false,
  MEDIUM_RISK: false,
  HIGH_RISK: false,
  DESTRUCTIVE: false
};

function isValidRisk(risk) {
  return RISK_LEVELS.includes(risk);
}

/**
 * Decide whether a tool call may proceed.
 *
 * This is the agent's independent re-check — it does not trust that the
 * caller (the server) already enforced policy correctly. DESTRUCTIVE tools
 * always require an explicit approval flag, regardless of policy config.
 *
 * @param {string} risk - one of RISK_LEVELS
 * @param {boolean} approved - whether the caller asserts this call was approved
 * @param {object} [policy] - risk -> autoApprove overrides
 */
function isAuthorized(risk, approved, policy = DEFAULT_AUTO_APPROVE) {
  if (!isValidRisk(risk)) return false;
  if (risk === 'DESTRUCTIVE') return approved === true;
  if (policy[risk]) return true;
  return approved === true;
}

module.exports = { RISK_LEVELS, DEFAULT_AUTO_APPROVE, isValidRisk, isAuthorized };
