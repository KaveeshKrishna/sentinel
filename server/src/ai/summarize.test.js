'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarizeToolResult } = require('./summarize');

test('null/undefined result renders as no-output rather than "null"', () => {
  assert.equal(summarizeToolResult('get_service_status', null), 'get_service_status: (no output)');
  assert.equal(summarizeToolResult('get_service_status', undefined), 'get_service_status: (no output)');
});

test('a plain object result is JSON-stringified', () => {
  const result = { ok: true, status: 'active' };
  assert.equal(summarizeToolResult('get_service_status', result), JSON.stringify(result));
});

test('a {stream,text} log-line array (get_container_logs) renders as bracketed lines', () => {
  const result = [{ stream: 'stdout', text: 'starting up' }, { stream: 'stderr', text: 'a warning' }];
  assert.equal(summarizeToolResult('get_container_logs', result), '[stdout] starting up\n[stderr] a warning');
});

test('a plain-string array (get_service_logs, journalctl lines) renders line by line', () => {
  const result = ['Aug 29 log line one', 'Aug 29 log line two'];
  assert.equal(summarizeToolResult('get_service_logs', result), result.join('\n'));
});

test('an array of arbitrary objects (list_containers) is JSON-stringified, not forced through the log template', () => {
  // The exact bug found live via Ask Sentinel: list_containers returns
  // container objects (name/status/health/...), which have neither
  // `.stream` nor `.text` — the old code produced "[undefined]
  // undefined" per container instead of the real data.
  const result = [
    { id: 'abc123', name: 'demo-api', status: 'running', health: 'healthy' },
    { id: 'def456', name: 'demo-db', status: 'exited', health: 'unhealthy' }
  ];
  const summary = summarizeToolResult('list_containers', result);
  assert.equal(summary, JSON.stringify(result));
  assert.ok(!summary.includes('undefined'));
  assert.match(summary, /demo-api/);
  assert.match(summary, /unhealthy/);
});

test('an array of service objects (list_services) is JSON-stringified', () => {
  const result = [{ name: 'caddy', status: 'active' }, { name: 'docker', status: 'inactive' }];
  const summary = summarizeToolResult('list_services', result);
  assert.equal(summary, JSON.stringify(result));
  assert.ok(!summary.includes('undefined'));
});

test('an array of docker event records (get_docker_events) is JSON-stringified', () => {
  const result = [{ type: 'die', container: 'demo-db', exitCode: '1', ts: 1000 }];
  const summary = summarizeToolResult('get_docker_events', result);
  assert.equal(summary, JSON.stringify(result));
  assert.ok(!summary.includes('undefined'));
});

test('an empty array renders as "(empty)", not a blank string or "[]"', () => {
  assert.equal(summarizeToolResult('get_docker_events', []), '(empty)');
});

test('a mixed/malformed array (neither uniformly strings nor log lines) falls back to JSON.stringify', () => {
  const result = ['a raw string', { name: 'not a log line' }];
  const summary = summarizeToolResult('some_tool', result);
  assert.equal(summary, JSON.stringify(result));
});

test('a long result is truncated at the limit with a marker, never silently cut mid-render', () => {
  const result = { data: 'x'.repeat(100) };
  const summary = summarizeToolResult('t', result, 20);
  assert.equal(summary.length, 20 + '\n… (truncated)'.length);
  assert.ok(summary.endsWith('… (truncated)'));
});

test('a result exactly at the limit is not marked truncated', () => {
  const result = { a: 'y'.repeat(5) };
  const full = JSON.stringify(result);
  const summary = summarizeToolResult('t', result, full.length);
  assert.equal(summary, full);
  assert.ok(!summary.includes('truncated'));
});
