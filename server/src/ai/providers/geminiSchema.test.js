'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toGeminiSchema } = require('./geminiSchema');
const { DIAGNOSIS_SCHEMA } = require('../schema');

test('a simple object converts to the uppercase OpenAPI-3 dialect', () => {
  const out = toGeminiSchema({
    type: 'object',
    properties: { name: { type: 'string' }, count: { type: 'integer' } },
    required: ['name'],
    additionalProperties: false
  });
  assert.deepEqual(out, {
    type: 'OBJECT',
    properties: { name: { type: 'STRING' }, count: { type: 'INTEGER' } },
    required: ['name']
  });
});

test('unsupported keywords are dropped rather than passed through', () => {
  const out = toGeminiSchema({
    type: 'object',
    properties: { pct: { type: 'number', minimum: 0, maximum: 1 } },
    additionalProperties: true
  });
  assert.deepEqual(out.properties.pct, { type: 'NUMBER' });
  assert.equal('additionalProperties' in out, false);
});

test('arrays convert their item schema', () => {
  const out = toGeminiSchema({ type: 'array', items: { type: 'string' } });
  assert.deepEqual(out, { type: 'ARRAY', items: { type: 'STRING' } });
});

test('a free-form object is NOT convertible — returning null is the point', () => {
  // Converting this anyway would constrain Gemini to emit `{}` for it.
  assert.equal(toGeminiSchema({ type: 'object' }), null);
  assert.equal(toGeminiSchema({ type: 'object', properties: {} }), null);
});

test('one unconvertible leaf makes the whole schema unconvertible', () => {
  const out = toGeminiSchema({
    type: 'object',
    properties: { fine: { type: 'string' }, freeform: { type: 'object' } }
  });
  assert.equal(out, null, 'must not silently drop the unconvertible property');
});

test('$ref / oneOf / anyOf are not expressible', () => {
  assert.equal(toGeminiSchema({ $ref: '#/defs/x' }), null);
  assert.equal(toGeminiSchema({ oneOf: [{ type: 'string' }] }), null);
});

test('DIAGNOSIS_SCHEMA is correctly reported as unconvertible (free-form action params)', () => {
  // This is the real case: the fallback to responseMimeType-only for
  // Gemini is deliberate, not an oversight.
  assert.equal(toGeminiSchema(DIAGNOSIS_SCHEMA), null);
});

test('enum values are carried through as strings', () => {
  const out = toGeminiSchema({ type: 'string', enum: ['a', 'b'] });
  assert.deepEqual(out, { type: 'STRING', enum: ['a', 'b'] });
});
