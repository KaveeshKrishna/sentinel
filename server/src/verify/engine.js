'use strict';

const { getAgentClient } = require('../agent/client');

const MAX_ATTEMPTS = 5;
const RETRY_DELAY_MS = 3000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Polls the agent's tool-specific `verify` check (agent/src/tools/*.js)
 * with bounded retries — the agent's verify is a single point-in-time
 * check ("is the container Running right now?"); the retry/timeout
 * policy for "give the action a moment to take effect" belongs here.
 *
 * Deliberately does NOT catch an execution error from the action itself —
 * by the time this runs, the tool call already succeeded (see
 * incidents/engine.js: a thrown execution error short-circuits straight
 * to FAILED and never reaches this function at all). This function only
 * ever answers "did it converge", never "did it run".
 *
 * @param {object} [opts]
 * @param {number} [opts.maxAttempts] - override for tests (default MAX_ATTEMPTS)
 * @param {number} [opts.retryDelayMs] - override for tests (default RETRY_DELAY_MS)
 * @returns {Promise<{ok: boolean, checks: Array<{attempt, ok, detail}>}>}
 */
async function verifyAction(tool, params, { maxAttempts = MAX_ATTEMPTS, retryDelayMs = RETRY_DELAY_MS } = {}) {
  const checks = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await getAgentClient().verifyTool(tool, params);
      checks.push({ attempt, ok: !!result.ok, detail: result.detail ?? null });
      if (result.ok) return { ok: true, checks };
    } catch (err) {
      // A 404 from the agent means the tool doesn't exist or has no
      // verify function at all — deterministic, so retrying it just
      // burns the full retry budget in wall-clock time to reach the
      // same answer. Report it as its own outcome (`unverifiable`)
      // rather than as a converge-failure: "this tool has nothing to
      // check" and "the check ran and said no" are different facts.
      if (err.name === 'AgentError' && err.status === 404) {
        checks.push({ attempt, ok: false, detail: `no verify check available: ${err.message}` });
        return { ok: false, unverifiable: true, checks };
      }
      checks.push({ attempt, ok: false, detail: `verify call failed: ${err.message}` });
    }
    if (attempt < maxAttempts) await sleep(retryDelayMs);
  }
  return { ok: false, checks };
}

module.exports = { verifyAction, MAX_ATTEMPTS, RETRY_DELAY_MS };
