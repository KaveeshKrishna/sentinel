'use strict';

/**
 * Convert an ajv/JSON-Schema object into Gemini's `responseSchema`
 * dialect — an OpenAPI-3 subset that accepts only:
 *   type, format, description, nullable, enum, items, properties, required
 * and rejects (or silently ignores) everything else, including
 * `additionalProperties`, `minLength`, `minimum`/`maximum`.
 *
 * Returns `null` when the schema contains something the dialect cannot
 * express, in which case the caller must fall back to
 * `responseMimeType: 'application/json'` alone.
 *
 * The `null` case is not hypothetical and is the reason this is a
 * converter rather than a stripper: `DIAGNOSIS_SCHEMA`'s per-action
 * `params` is a deliberately free-form object (its real shape differs
 * per tool and is validated agent-side against that tool's own schema).
 * Gemini's structured output is *strict* — a property typed OBJECT with
 * no declared properties either errors or constrains the model to emit
 * an empty object, so "convert it anyway, minus the bits that don't fit"
 * would silently destroy every recommended action's parameters. Refusing
 * to convert, and losing only provider-side enforcement, is strictly
 * better than emitting a schema that changes the answer.
 *
 * The orchestrator's own ajv validation runs on every provider's output
 * regardless, so this only ever affects reliability, never whether a
 * diagnosis is trusted.
 */

const TYPE_MAP = {
  string: 'STRING',
  number: 'NUMBER',
  integer: 'INTEGER',
  boolean: 'BOOLEAN',
  array: 'ARRAY',
  object: 'OBJECT'
};

function convert(node) {
  if (!node || typeof node !== 'object') return null;

  // Gemini has no $ref/oneOf/anyOf/allOf support in this dialect.
  if (node.$ref || node.oneOf || node.anyOf || node.allOf) return null;

  const type = TYPE_MAP[node.type];
  if (!type) return null; // untyped or a type the dialect has no equivalent for

  const out = { type };
  if (node.description) out.description = node.description;
  if (Array.isArray(node.enum)) out.enum = node.enum.map(String);

  if (type === 'ARRAY') {
    const items = convert(node.items);
    if (!items) return null;
    out.items = items;
    return out;
  }

  if (type === 'OBJECT') {
    const props = node.properties || {};
    const names = Object.keys(props);
    // A free-form object — see the module comment. Not convertible.
    if (names.length === 0) return null;

    out.properties = {};
    for (const name of names) {
      const child = convert(props[name]);
      if (!child) return null; // one unconvertible leaf makes the whole schema unconvertible
      out.properties[name] = child;
    }
    if (Array.isArray(node.required) && node.required.length) out.required = [...node.required];
  }

  return out;
}

/** @returns {object|null} Gemini-dialect schema, or null if not expressible. */
function toGeminiSchema(jsonSchema) {
  return convert(jsonSchema);
}

module.exports = { toGeminiSchema };
