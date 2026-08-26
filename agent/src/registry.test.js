'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ToolRegistry } = require('./registry');

test('register + list exposes only name/description/parameters/risk/hasVerify', () => {
  const registry = new ToolRegistry();
  registry.register({
    name: 'noop',
    description: 'does nothing',
    risk: 'READ_ONLY',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => ({ ok: true })
  });
  const list = registry.list();
  assert.equal(list.length, 1);
  assert.deepEqual(Object.keys(list[0]).sort(), ['description', 'hasVerify', 'name', 'parameters', 'risk']);
  assert.equal(list[0].name, 'noop');
  assert.equal(list[0].hasVerify, false);
});

test('list reports hasVerify: true for a tool with a verify function', () => {
  const registry = new ToolRegistry();
  registry.register({
    name: 'with_verify',
    description: 'has a check',
    risk: 'MEDIUM_RISK',
    handler: async () => ({ ok: true }),
    verify: async () => ({ ok: true })
  });
  assert.equal(registry.list()[0].hasVerify, true);
});

test('register rejects an invalid risk level', () => {
  const registry = new ToolRegistry();
  assert.throws(() => registry.register({
    name: 'bad',
    description: 'x',
    risk: 'SUPER_DANGEROUS',
    handler: async () => {}
  }), /invalid risk/);
});

test('register rejects a duplicate tool name', () => {
  const registry = new ToolRegistry();
  const def = { name: 'dup', description: 'x', risk: 'READ_ONLY', handler: async () => {} };
  registry.register(def);
  assert.throws(() => registry.register(def), /already registered/);
});

test('register rejects a definition with no handler function', () => {
  const registry = new ToolRegistry();
  assert.throws(() => registry.register({ name: 'no_handler', description: 'x', risk: 'READ_ONLY' }), /handler function/);
});

test('validateParams rejects params that fail the declared schema', () => {
  const registry = new ToolRegistry();
  registry.register({
    name: 'needs_id',
    description: 'x',
    risk: 'READ_ONLY',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false
    },
    handler: async () => {}
  });

  assert.equal(registry.validateParams('needs_id', {}).valid, false);
  assert.equal(registry.validateParams('needs_id', { id: 'x', evil: 'rm -rf /' }).valid, false);
  assert.equal(registry.validateParams('needs_id', { id: 'x' }).valid, true);
});

test('validateParams on an unknown tool name fails closed', () => {
  const registry = new ToolRegistry();
  const result = registry.validateParams('does_not_exist', {});
  assert.equal(result.valid, false);
  assert.match(result.errors[0], /Unknown tool/);
});
