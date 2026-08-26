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
 * DISMISSED is reachable from any non-terminal state — a human can walk
 * away from an incident at any point before it's resolved.
 */
const TRANSITIONS = {
  DETECTED: ['INVESTIGATING', 'DISMISSED'],
  INVESTIGATING: ['DIAGNOSED', 'INVESTIGATING', 'FAILED', 'DISMISSED'],
  DIAGNOSED: ['AWAITING_APPROVAL', 'DISMISSED'],
  AWAITING_APPROVAL: ['REMEDIATING', 'DISMISSED'],
  REMEDIATING: ['VERIFYING', 'FAILED', 'DISMISSED'],
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
