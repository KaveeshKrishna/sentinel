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

// ── CHAT_STEP_SCHEMA ──────────────────────────────────────────────────

const { validateChatStep, validateReport } = require('./schema');

test('a chat tool step validates', () => {
  const { valid } = validateChatStep({
    thought: 'checking caddy', action: 'tool', tool: 'get_service_status', params: { service: 'caddy' }
  });
  assert.equal(valid, true);
});

test('a chat answer step validates with nothing but action + answer', () => {
  assert.equal(validateChatStep({ action: 'answer', answer: 'all good' }).valid, true);
});

test('a chat step with no action is rejected — the loop cannot dispatch on it', () => {
  assert.equal(validateChatStep({ thought: 'hmm', tool: 'get_system_metrics' }).valid, false);
});

test('a chat step with an unknown action verb is rejected', () => {
  assert.equal(validateChatStep({ action: 'shell', tool: 'sh' }).valid, false);
});

test('a chat step tolerates extra fields, like the diagnosis schema', () => {
  assert.equal(validateChatStep({ action: 'answer', answer: 'x', confidence: 0.4, extra: 1 }).valid, true);
});

test('a chat answer carries a well-formed suggestedIncident', () => {
  const { valid } = validateChatStep({
    action: 'answer', answer: 'caddy is down',
    suggestedIncident: { resourceType: 'service', externalId: 'caddy', summary: 'inactive' }
  });
  assert.equal(valid, true);
});

// ── REPORT_SCHEMA ─────────────────────────────────────────────────────

test('a full report validates', () => {
  const { valid } = validateReport({
    title: 'demo-db outage', summary: 's', impact: 'i', rootCause: 'r',
    resolution: 'restarted', timeline: ['a', 'b'], prevention: ['healthcheck']
  });
  assert.equal(valid, true);
});

test('a terse report with only summary + rootCause still validates', () => {
  // Same deliberate slack as DIAGNOSIS_SCHEMA: a free-tier model that
  // gets the substance right must not lose the whole report over an
  // omitted prevention list.
  assert.equal(validateReport({ summary: 's', rootCause: 'r' }).valid, true);
});

test('a report missing rootCause is rejected', () => {
  assert.equal(validateReport({ summary: 's' }).valid, false);
});

test('a report with an empty rootCause is rejected', () => {
  assert.equal(validateReport({ summary: 's', rootCause: '' }).valid, false);
});
