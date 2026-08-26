'use strict';

const Ajv = require('ajv');

const ajv = new Ajv({ allErrors: true, strict: false });

/**
 * The only shape a diagnosis is ever allowed to take. No free-form AI
 * text drives a tool call — everything downstream of a successful
 * validate() reads from this structure, never from raw model output.
 */
const DIAGNOSIS_SCHEMA = {
  type: 'object',
  properties: {
    rootCause: { type: 'string', minLength: 1 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    evidence: { type: 'array', items: { type: 'string' } },
    affectedComponents: { type: 'array', items: { type: 'string' } },
    recommendedActions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          tool: { type: 'string', minLength: 1 },
          params: { type: 'object' },
          risk: { type: 'string' },
          rationale: { type: 'string' }
        },
        required: ['tool', 'rationale'],
        additionalProperties: false
      }
    },
    requiresApproval: { type: 'boolean' }
  },
  required: ['rootCause', 'confidence', 'evidence', 'affectedComponents', 'recommendedActions', 'requiresApproval'],
  additionalProperties: false
};

const validateFn = ajv.compile(DIAGNOSIS_SCHEMA);

function validate(json) {
  const valid = validateFn(json);
  return {
    valid,
    errors: valid ? [] : (validateFn.errors || []).map(e => `${e.instancePath || '(root)'} ${e.message}`)
  };
}

module.exports = { DIAGNOSIS_SCHEMA, validate };
