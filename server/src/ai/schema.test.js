'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validate } = require('./schema');

function baseDiagnosis(overrides = {}) {
  return {
    rootCause: 'demo-db exited',
    confidence: 0.9,
    evidence: ['exit code 0'],
    affectedComponents: ['demo-db'],
    recommendedActions: [{ tool: 'restart_container', params: { id: 'demo-db' }, risk: 'LOW', rationale: 'restart it' }],
    requiresApproval: true,
    ...overrides
  };
}

test('a fully-formed diagnosis passes', () => {
  assert.equal(validate(baseDiagnosis()).valid, true);
});

test('a recommended action missing rationale still passes — it is a UI-only field, not a safety gate', () => {
  const diagnosis = baseDiagnosis({
    recommendedActions: [{ tool: 'restart_container', params: { id: 'demo-db' }, risk: 'LOW' }]
  });
  assert.equal(validate(diagnosis).valid, true);
});

test('extra top-level properties the model adds do not fail validation', () => {
  const diagnosis = baseDiagnosis();
  diagnosis.summary = 'a less capable model padding the response with an extra field';
  assert.equal(validate(diagnosis).valid, true);
});

test('extra properties on a recommended action do not fail validation', () => {
  const diagnosis = baseDiagnosis({
    recommendedActions: [{ tool: 'restart_container', params: {}, extraField: 'unexpected' }]
  });
  assert.equal(validate(diagnosis).valid, true);
});

test('a recommended action missing tool still fails — this is the real safety-relevant field', () => {
  const diagnosis = baseDiagnosis({ recommendedActions: [{ params: {}, rationale: 'no tool name' }] });
  const { valid, errors } = validate(diagnosis);
  assert.equal(valid, false);
  assert.ok(errors.some(e => e.includes('tool')));
});

test('a missing rootCause still fails — the core structural fields are still required', () => {
  const diagnosis = baseDiagnosis();
  delete diagnosis.rootCause;
  assert.equal(validate(diagnosis).valid, false);
});

test('a terse response with only rootCause + a valid tool call passes — confidence/evidence/affectedComponents/requiresApproval are UI-only', () => {
  // Seen live against an OpenRouter free model (incident #8, Phase 5):
  // correct rootCause + a schema-valid start_container call, nothing else.
  const diagnosis = {
    rootCause: 'demo-db exited, api unhealthy',
    recommendedActions: [{ tool: 'start_container', params: { id: 'demo-db' } }]
  };
  assert.equal(validate(diagnosis).valid, true);
});

test('a missing recommendedActions still fails', () => {
  assert.equal(validate({ rootCause: 'x' }).valid, false);
});
