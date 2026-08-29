'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { publish, setSink } = require('./publish');

afterEach(() => setSink(null));

test('publish is a no-op when no sink is registered', () => {
  // The whole point of the inverted dependency: unit tests and the
  // pre-listen window must never touch the WebSocket/auth module graph.
  assert.doesNotThrow(() => publish('incident', { id: 1 }));
});

test('publish forwards type and data to the registered sink', () => {
  const seen = [];
  setSink((type, data) => seen.push([type, data]));

  publish('incident', { id: 7, status: 'DETECTED' });
  publish('activity', { id: 9, type: 'LOGIN' });

  assert.deepEqual(seen, [
    ['incident', { id: 7, status: 'DETECTED' }],
    ['activity', { id: 9, type: 'LOGIN' }]
  ]);
});

test('a throwing sink never propagates to the caller', () => {
  // A push failing must not be able to turn a successful DB write into
  // a thrown error for the store or the activity logger.
  setSink(() => { throw new Error('socket exploded'); });
  assert.doesNotThrow(() => publish('incident', { id: 1 }));
});

test('setSink(null) detaches a previously registered sink', () => {
  let calls = 0;
  setSink(() => { calls++; });
  publish('incident', {});
  setSink(null);
  publish('incident', {});
  assert.equal(calls, 1);
});
