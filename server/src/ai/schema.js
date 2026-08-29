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
 *
 * Only `rootCause` and `recommendedActions` are required. `confidence`,
 * `evidence`, `affectedComponents` and `requiresApproval` are all
 * UI-display fields with safe fallbacks in orchestrator.js /
 * IncidentDetail.jsx — a free-tier model that returns a correct
 * rootCause + a valid tool call but omits `confidence` (seen live
 * against an OpenRouter free model, incident #8 during Phase 5) had a
 * fully actionable diagnosis rejected twice over nothing safety-
 * relevant. `requiresApproval` in particular was never a gate: every
 * recommended action needs an explicit human approval regardless of it
 * (Architecture decision #13).
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
  required: ['rootCause', 'recommendedActions'],
  additionalProperties: true
};

/**
 * One step of the "Ask Sentinel" conversational loop. The model either
 * asks to run a tool or gives its final answer; the loop in ai/chat.js
 * re-prompts with the tool result until it answers or hits its ceiling.
 *
 * Same slack as DIAGNOSIS_SCHEMA and for the same reason: only `action`
 * is required, because the real gates on a tool step are not in this
 * schema at all. chat.js refuses any `tool` that isn't READ_ONLY in the
 * agent's live catalog, and calls the agent *unapproved* so its own
 * isAuthorized() independently rejects anything above READ_ONLY. A step
 * naming a tool the loop can't run is dropped there, not here.
 *
 * `suggestedIncident` is how chat escalates: it never creates or
 * approves anything itself, it only proposes that the user open a real
 * incident, which then goes through the ordinary state machine.
 */
const CHAT_STEP_SCHEMA = {
  type: 'object',
  properties: {
    thought: { type: 'string' },
    action: { type: 'string', enum: ['tool', 'answer'] },
    tool: { type: 'string' },
    params: { type: 'object' },
    answer: { type: 'string' },
    suggestedIncident: {
      type: 'object',
      properties: {
        resourceType: { type: 'string' },
        externalId: { type: 'string' },
        summary: { type: 'string' }
      },
      additionalProperties: true
    }
  },
  required: ['action'],
  additionalProperties: true
};

/**
 * The AI-written post-incident report. Structured rather than free-form
 * markdown on purpose: it stays ajv-validated like every other AI call,
 * the UI renders React components instead of parsing untrusted markdown
 * (no HTML-injection surface), and the markdown for the copy button is
 * derived server-side from these fields.
 *
 * Only `summary` and `rootCause` are required — a terse free-tier model
 * that gets the substance right shouldn't have the whole report thrown
 * away for omitting `prevention`, the same near-miss that cost two
 * diagnoses during Phase 5.
 */
const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string', minLength: 1 },
    impact: { type: 'string' },
    rootCause: { type: 'string', minLength: 1 },
    resolution: { type: 'string' },
    timeline: { type: 'array', items: { type: 'string' } },
    prevention: { type: 'array', items: { type: 'string' } }
  },
  required: ['summary', 'rootCause'],
  additionalProperties: true
};

function compileValidator(schema) {
  const validateFn = ajv.compile(schema);
  return (json) => {
    const valid = validateFn(json);
    return {
      valid,
      errors: valid ? [] : (validateFn.errors || []).map(e => `${e.instancePath || '(root)'} ${e.message}`)
    };
  };
}

const validate = compileValidator(DIAGNOSIS_SCHEMA);
const validateChatStep = compileValidator(CHAT_STEP_SCHEMA);
const validateReport = compileValidator(REPORT_SCHEMA);

module.exports = {
  DIAGNOSIS_SCHEMA, CHAT_STEP_SCHEMA, REPORT_SCHEMA,
  validate, validateChatStep, validateReport
};
