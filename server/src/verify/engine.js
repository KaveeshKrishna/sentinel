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
      checks.push({ attempt, ok: false, detail: `verify call failed: ${err.message}` });
    }
    if (attempt < maxAttempts) await sleep(retryDelayMs);
  }
  return { ok: false, checks };
}

module.exports = { verifyAction, MAX_ATTEMPTS, RETRY_DELAY_MS };
