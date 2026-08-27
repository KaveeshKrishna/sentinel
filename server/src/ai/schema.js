'use strict';

const Ajv = require('ajv');

const ajv = new Ajv({ allErrors: true, strict: false });

/**
 * The only shape a diagnosis is ever allowed to take. No free-form AI
 * text drives a tool call — everything downstream of a successful
 * validate() reads from this structure, never from raw model output.
 *
 * `additionalProperties: true` throughout and `rationale` optional are
 * deliberate slack, not a weakening of the actual safety boundary: the
 * real gate on a recommended action is `tool` (still required, still a
 * non-empty string) being cross-checked against the agent's live tool
 * catalog in orchestrator.js's reconcileActions — an unrecognized name
 * is dropped there regardless of what else the model included, and
 * `realRisk` always comes from that catalog, never from the model's own
 * `risk` claim. `rationale` is purely a UI explanation string (rendered
 * only if present — see IncidentDetail.jsx); a model that includes
 * everything else correctly but omits it, or adds an extra field we
 * didn't ask for, shouldn't have an otherwise-good diagnosis thrown
 * away over that. Less capable/free models are meaningfully more prone
 * to exactly these near-misses than to actually-wrong tool names or
 * malformed core fields.
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
        required: ['tool'],
        additionalProperties: true
      }
    },
    requiresApproval: { type: 'boolean' }
  },
  required: ['rootCause', 'confidence', 'evidence', 'affectedComponents', 'recommendedActions', 'requiresApproval'],
  additionalProperties: true
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
