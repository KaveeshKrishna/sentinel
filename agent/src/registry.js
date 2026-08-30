'use strict';

const Ajv = require('ajv');
const { isValidRisk } = require('./policy');

const ajv = new Ajv({ allErrors: true, strict: false });

/**
 * The tool registry is the entire executable surface of the agent. There
 * is deliberately no generic "run a command" entry point — every
 * capability the AI (or the UI) can reach must be registered here with a
 * name, a JSON Schema for its parameters, and a fixed risk classification.
 */
class ToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  /**
   * Register a tool. Throws on a malformed definition — this runs at
   * boot, so a bad tool definition should fail loudly, not silently.
   */
  register(def) {
    const { name, description, parameters, risk, handler, verify } = def;
    if (!name || typeof name !== 'string') throw new Error('Tool must have a string name');
    if (this.tools.has(name)) throw new Error(`Tool "${name}" already registered`);
    if (!description || typeof description !== 'string') throw new Error(`Tool "${name}" must have a description`);
    if (!isValidRisk(risk)) throw new Error(`Tool "${name}" has invalid risk "${risk}"`);
    if (typeof handler !== 'function') throw new Error(`Tool "${name}" must have a handler function`);
    if (verify !== undefined && typeof verify !== 'function') throw new Error(`Tool "${name}" verify must be a function`);

    const schema = parameters || { type: 'object', properties: {}, additionalProperties: false };
    const validate = ajv.compile(schema);

    this.tools.set(name, { name, description, risk, parameters: schema, handler, verify, validate });
  }

  get(name) {
    return this.tools.get(name);
  }

  has(name) {
    return this.tools.has(name);
  }

  /** Public tool catalog — no handler/validate functions leak out. */
  list() {
    return [...this.tools.values()].map(({ name, description, parameters, risk, verify }) => ({
      name, description, parameters, risk, hasVerify: !!verify
    }));
  }

  /**
   * Validate params against the tool's declared JSON Schema.
   * Returns { valid, errors }.
   */
  validateParams(name, params) {
    const tool = this.tools.get(name);
    if (!tool) return { valid: false, errors: [`Unknown tool "${name}"`] };
    const valid = tool.validate(params || {});
    return {
      valid,
      errors: valid ? [] : (tool.validate.errors || []).map(e => `${e.instancePath || '(root)'} ${e.message}`)
    };
  }
}

module.exports = { ToolRegistry };
