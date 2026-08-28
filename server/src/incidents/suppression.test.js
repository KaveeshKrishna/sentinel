'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const s = require('./suppression');

beforeEach(() => s._clearAll());

test('a resource is suppressed only within its window', () => {
  assert.equal(s.isSuppressed('container', 'demo-db'), false);
  s.suppressResource('container', 'demo-db', 50);
  assert.equal(s.isSuppressed('container', 'demo-db'), true);
  assert.equal(s.isSuppressed('container', 'other'), false, 'suppression must not leak to siblings');
});

test('an expired window stops suppressing', async () => {
  s.suppressResource('service', 'caddy', 10);
  await new Promise(r => setTimeout(r, 25));
  assert.equal(s.isSuppressed('service', 'caddy'), false);
});

test('a longer window is never shortened by a later, shorter one', () => {
  s.suppressResource('container', 'x', 60000);
  s.suppressResource('container', 'x', 5);
  assert.equal(s.isSuppressed('container', 'x'), true);
});

test('suppressForToolCall maps container tools to that container', () => {
  s.suppressForToolCall('restart_container', { id: 'app-scanner' });
  assert.equal(s.isSuppressed('container', 'app-scanner'), true);
  assert.equal(s.isSuppressed('container', 'other-admin'), false);
});

test('stopping the docker service suppresses EVERY container, not just service:docker', () => {
  // The real bug this exists for: `stop_service docker` kills every
  // container on the host, each emitting a non-zero-exit die event.
  s.suppressForToolCall('stop_service', { service: 'docker' });
  assert.equal(s.isSuppressed('service', 'docker'), true);
  assert.equal(s.isSuppressed('container', 'app-scanner'), true);
  assert.equal(s.isSuppressed('container', 'anything-at-all'), true);
});

test('stopping a non-docker service does not suppress containers', () => {
  s.suppressForToolCall('stop_service', { service: 'caddy' });
  assert.equal(s.isSuppressed('service', 'caddy'), true);
  assert.equal(s.isSuppressed('container', 'app-scanner'), false);
});

test('a tool call with no mappable target is a no-op, not a throw', () => {
  s.suppressForToolCall('get_system_metrics', {});
  s.suppressForToolCall('restart_container', {});
  assert.equal(s.isSuppressed('container', 'undefined'), false);
});
