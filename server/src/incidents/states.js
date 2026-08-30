'use strict';

const STATES = [
  'DETECTED', 'INVESTIGATING', 'DIAGNOSED', 'AWAITING_APPROVAL',
  'REMEDIATING', 'VERIFYING', 'RESOLVED', 'FAILED', 'DISMISSED'
];

const TERMINAL_STATES = ['RESOLVED', 'FAILED', 'DISMISSED'];

/**
 * DETECTED -> INVESTIGATING -> DIAGNOSED -> AWAITING_APPROVAL ->
 * REMEDIATING -> VERIFYING -> RESOLVED | FAILED.
 *
 * INVESTIGATING self-loops (the AI-retry-fallback path: a malformed
 * diagnosis leaves the incident at INVESTIGATING so a human can look, or
 * so the detector's next tick can eventually re-drive it).
 * REMEDIATING -> AWAITING_APPROVAL is the pre-execution-rejection
 * rollback: the agent rejected the approved action's params before
 * running anything (a deterministic 400, not an execution failure), so
 * the incident goes back to awaiting a (different, or corrected) action
 * rather than burning to terminal FAILED — see engine.js's approve().
 * DIAGNOSED/AWAITING_APPROVAL -> INVESTIGATING is the re-diagnosis
 * path: an approved READ_ONLY *investigation* action appended new
 * evidence, so the incident can be re-diagnosed against it rather than
 * being stuck with a diagnosis the model itself said was inconclusive
 * (engine.js's rediagnose()).
 * DISMISSED is reachable from any non-terminal state — a human can walk
 * away from an incident at any point before it's resolved.
 */
const TRANSITIONS = {
  DETECTED: ['INVESTIGATING', 'DISMISSED'],
  INVESTIGATING: ['DIAGNOSED', 'INVESTIGATING', 'FAILED', 'DISMISSED'],
  DIAGNOSED: ['AWAITING_APPROVAL', 'INVESTIGATING', 'DISMISSED'],
  AWAITING_APPROVAL: ['REMEDIATING', 'INVESTIGATING', 'DISMISSED'],
  REMEDIATING: ['VERIFYING', 'FAILED', 'AWAITING_APPROVAL', 'DISMISSED'],
  VERIFYING: ['RESOLVED', 'FAILED', 'DISMISSED'],
  RESOLVED: [],
  FAILED: [],
  DISMISSED: []
};

function isValidState(state) {
  return STATES.includes(state);
}

function isTerminal(state) {
  return TERMINAL_STATES.includes(state);
}

function canTransition(from, to) {
  if (!isValidState(from) || !isValidState(to)) return false;
  return (TRANSITIONS[from] || []).includes(to);
}

module.exports = { STATES, TERMINAL_STATES, isValidState, isTerminal, canTransition };
