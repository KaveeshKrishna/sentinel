'use strict';

/**
 * In-flight Ask Sentinel turns, keyed by session.
 *
 * A chat turn used to be bound to its HTTP request: navigating away or
 * closing the tab aborted it mid-thought, and whatever it had gathered
 * was thrown away. That was built to stop a *dead* connection burning
 * provider quota, but it made the common case — ask a question, go look
 * at something else while it thinks — lose the answer.
 *
 * So a turn now outlives its stream. The SSE response is just a viewer
 * attached to a run that is happening anyway; when it finishes, the
 * answer is persisted and announced (`chat` event) whether or not anyone
 * is still watching. Cancelling is now an explicit act — the Stop button
 * — rather than an accident of navigation.
 *
 * Deliberately in-memory: a run cannot survive a process restart in any
 * case (its provider call and loop state live in this process), so
 * persisting the registry would only create rows describing turns that
 * can never resume.
 */

const runs = new Map(); // sessionId -> { startedAt, cancelled, question }

/** Register a starting turn. Returns a handle the runner polls/clears. */
function start(sessionId, question) {
  const run = { sessionId, question, startedAt: Date.now(), cancelled: false };
  runs.set(sessionId, run);
  return run;
}

function finish(sessionId) {
  runs.delete(sessionId);
}

function isRunning(sessionId) {
  return runs.has(sessionId);
}

/**
 * Ask a turn to stop at its next step boundary.
 * @returns {boolean} whether there was a run to cancel
 */
function cancel(sessionId) {
  const run = runs.get(sessionId);
  if (!run) return false;
  run.cancelled = true;
  return true;
}

function isCancelled(sessionId) {
  return !!runs.get(sessionId)?.cancelled;
}

/** Sessions currently thinking, so a reopened UI can show that state. */
function listRunning() {
  return [...runs.values()].map(r => ({
    sessionId: r.sessionId, question: r.question, startedAt: r.startedAt, cancelled: r.cancelled
  }));
}

function _resetForTesting() {
  runs.clear();
}

module.exports = { start, finish, cancel, isRunning, isCancelled, listRunning, _resetForTesting };
