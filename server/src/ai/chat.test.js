'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = path.join(os.tmpdir(), `sentinel-test-chat-${crypto.randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;
process.env.SENTINEL_SECRET_KEY = crypto.randomBytes(32).toString('hex');

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { migrate } = require('../db/migrate');
const { getDb } = require('../db/connection');
const { setAIConfig, clearAIConfig } = require('../settings/aiConfig');
const { _setProviderForTesting, _resetProviderForTesting } = require('./provider');
const { _setClientForTesting, _resetClientForTesting, AgentError } = require('../agent/client');
const {
  runChat, normalizeSuggestion, buildChatSystemPrompt, MAX_TOOL_CALLS, MAX_STEPS,
  retryableProviderStatus, PROVIDER_RETRY_ATTEMPTS, timeoutAnswer
} = require('./chat');

before(() => {
  migrate();
  setAIConfig({ provider: 'anthropic', model: 'test-model', apiKey: 'sk-test-key' });
});
after(() => {
  _resetProviderForTesting();
  _resetClientForTesting();
  clearAIConfig();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(DB_PATH + suffix); } catch { /* already gone */ }
  }
});

const CATALOG = [
  { name: 'get_service_status', risk: 'READ_ONLY', description: 'status', parameters: { type: 'object', properties: { service: { type: 'string' } } } },
  { name: 'get_system_metrics', risk: 'READ_ONLY', description: 'metrics', parameters: { type: 'object', properties: {} } },
  { name: 'restart_service',    risk: 'MEDIUM_RISK', description: 'restart', parameters: { type: 'object', properties: { service: { type: 'string' } } } },
  { name: 'stop_container',     risk: 'HIGH_RISK',   description: 'stop',    parameters: { type: 'object', properties: { id: { type: 'string' } } } }
];

/** A provider that replays a fixed list of responses, one per step. */
function scriptedProvider(steps) {
  const queue = [...steps];
  const seen = [];
  return {
    adapter: {
      chat: async ({ messages, system }) => {
        seen.push({ messages: JSON.parse(JSON.stringify(messages)), system });
        const next = queue.shift() ?? { action: 'answer', answer: 'ran out of script' };
        return { text: typeof next === 'string' ? next : JSON.stringify(next), toolCalls: [], usage: {} };
      }
    },
    seen
  };
}

/**
 * A provider that throws `failures.length` times (each with the given
 * message) before finally returning `finalResponse` — models the real
 * OpenRouter behavior found live: the identical request sometimes 404s
 * and sometimes succeeds, with no config difference between calls.
 */
function flakyProvider(failures, finalResponse) {
  const queue = [...failures];
  const calls = [];
  return {
    calls,
    chat: async (args) => {
      calls.push(args);
      if (queue.length > 0) throw new Error(queue.shift());
      return { text: JSON.stringify(finalResponse), toolCalls: [], usage: {} };
    }
  };
}

function fakeAgent({ onCall } = {}) {
  const calls = [];
  return {
    calls,
    client: {
      listTools: async () => CATALOG,
      callTool: async (name, params, opts) => {
        calls.push({ name, params, opts });
        if (onCall) return onCall(name, params, opts);
        return { ok: true, name };
      },
      verifyTool: async () => ({ ok: true })
    }
  };
}

beforeEach(() => {
  getDb().prepare('DELETE FROM ai_runs').run();
  getDb().prepare('DELETE FROM tool_executions').run();
});

test('a simple question answers without running any tool', async () => {
  const { adapter } = scriptedProvider([{ action: 'answer', answer: 'Everything looks healthy.' }]);
  _setProviderForTesting(adapter);
  const agent = fakeAgent();
  _setClientForTesting(agent.client);

  const result = await runChat({ question: 'is everything ok?' });
  assert.equal(result.answer, 'Everything looks healthy.');
  assert.equal(result.toolCalls.length, 0);
  assert.equal(agent.calls.length, 0);
});

test('a READ_ONLY tool is run and its output fed back before the answer', async () => {
  const { adapter } = scriptedProvider([
    { action: 'tool', thought: 'check caddy', tool: 'get_service_status', params: { service: 'caddy' } },
    { action: 'answer', answer: 'caddy is active.' }
  ]);
  _setProviderForTesting(adapter);
  const agent = fakeAgent({ onCall: () => ({ status: 'active' }) });
  _setClientForTesting(agent.client);

  const events = [];
  const result = await runChat({ question: 'is caddy up?', onEvent: (t, d) => events.push([t, d]) });

  assert.equal(agent.calls.length, 1);
  assert.equal(agent.calls[0].name, 'get_service_status');
  // Gate 2: the agent is always called unapproved, so its own
  // isAuthorized() is what ultimately permits the call.
  assert.equal(agent.calls[0].opts.approved, false);

  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].ok, true);
  assert.equal(result.answer, 'caddy is active.');
  assert.deepEqual(events.map(e => e[0]), ['thought', 'tool_call', 'tool_result', 'answer']);
});

test('a mutating tool is refused before the agent is ever contacted', async () => {
  // Gate 1. This is the security-critical case: the model asking for a
  // tool that exists and works, but changes host state.
  const { adapter } = scriptedProvider([
    { action: 'tool', tool: 'restart_service', params: { service: 'caddy' } },
    { action: 'answer', answer: 'I cannot restart it myself.' }
  ]);
  _setProviderForTesting(adapter);
  const agent = fakeAgent();
  _setClientForTesting(agent.client);

  const events = [];
  const result = await runChat({ question: 'restart caddy', onEvent: (t, d) => events.push([t, d]) });

  assert.equal(agent.calls.length, 0, 'the agent must never see a non-READ_ONLY chat tool call');
  assert.equal(result.toolCalls.length, 0);

  const refusal = events.find(e => e[0] === 'tool_refused');
  assert.ok(refusal, 'a refusal event is emitted');
  assert.match(refusal[1].reason, /MEDIUM_RISK/);
  assert.equal(result.answer, 'I cannot restart it myself.');
});

test('a HIGH_RISK tool is refused the same way', async () => {
  const { adapter } = scriptedProvider([
    { action: 'tool', tool: 'stop_container', params: { id: 'demo-db' } },
    { action: 'answer', answer: 'no' }
  ]);
  _setProviderForTesting(adapter);
  const agent = fakeAgent();
  _setClientForTesting(agent.client);

  await runChat({ question: 'stop the db' });
  assert.equal(agent.calls.length, 0);
});

test('an unknown tool name is refused without contacting the agent', async () => {
  const { adapter } = scriptedProvider([
    { action: 'tool', tool: 'rm_minus_rf', params: {} },
    { action: 'answer', answer: 'done' }
  ]);
  _setProviderForTesting(adapter);
  const agent = fakeAgent();
  _setClientForTesting(agent.client);

  const events = [];
  await runChat({ question: 'delete everything', onEvent: (t, d) => events.push([t, d]) });

  assert.equal(agent.calls.length, 0);
  assert.match(events.find(e => e[0] === 'tool_refused')[1].reason, /no tool named/i);
});

test('the tool-call budget is enforced even if the model keeps asking', async () => {
  const script = Array.from({ length: MAX_STEPS }, () => ({
    action: 'tool', tool: 'get_system_metrics', params: {}
  }));
  const { adapter } = scriptedProvider(script);
  _setProviderForTesting(adapter);
  const agent = fakeAgent({ onCall: () => ({ cpu: 12 }) });
  _setClientForTesting(agent.client);

  const result = await runChat({ question: 'keep looking' });
  assert.equal(agent.calls.length, MAX_TOOL_CALLS, 'never exceeds MAX_TOOL_CALLS');
  assert.match(result.answer, /step budget/i);
});

test('the loop terminates on a model that only ever returns invalid JSON', async () => {
  const { adapter, seen } = scriptedProvider(Array.from({ length: MAX_STEPS + 2 }, () => 'not json at all'));
  _setProviderForTesting(adapter);
  _setClientForTesting(fakeAgent().client);

  const result = await runChat({ question: 'hello' });
  assert.equal(seen.length, MAX_STEPS, 'stops at MAX_STEPS rather than looping forever');
  assert.ok(result.answer.length > 0);
});

test('a failing tool call is reported back to the model, not thrown', async () => {
  const { adapter, seen } = scriptedProvider([
    { action: 'tool', tool: 'get_service_status', params: { service: 'nope' } },
    { action: 'answer', answer: 'that service does not exist.' }
  ]);
  _setProviderForTesting(adapter);
  const agent = fakeAgent({
    onCall: () => { throw new AgentError('Invalid parameters', 400, {}); }
  });
  _setClientForTesting(agent.client);

  const result = await runChat({ question: 'status of nope' });
  assert.equal(result.toolCalls[0].ok, false);
  assert.equal(result.answer, 'that service does not exist.');
  // the failure text is fed back so the model can adjust
  const lastTurn = seen[seen.length - 1].messages.map(m => m.content).join('\n');
  assert.match(lastTurn, /Invalid parameters/);
});

test('tool output is redacted before it re-enters the conversation', async () => {
  const { adapter, seen } = scriptedProvider([
    { action: 'tool', tool: 'get_service_status', params: { service: 'app' } },
    { action: 'answer', answer: 'ok' }
  ]);
  _setProviderForTesting(adapter);
  _setClientForTesting(fakeAgent({
    onCall: () => ({ env: 'AI_API_KEY=sk-ant-abcdefghijklmnop' })
  }).client);

  const result = await runChat({ question: 'check app' });
  assert.ok(!result.toolCalls[0].summary.includes('sk-ant-abcdefghijklmnop'));
  assert.match(result.toolCalls[0].summary, /REDACTED/);

  const sentToProvider = JSON.stringify(seen[seen.length - 1].messages);
  assert.ok(!sentToProvider.includes('sk-ant-abcdefghijklmnop'));
});

test('prior conversation turns are sent to the provider ahead of the new question', async () => {
  const { adapter, seen } = scriptedProvider([{ action: 'answer', answer: 'yes, as I said, caddy is fine' }]);
  _setProviderForTesting(adapter);
  _setClientForTesting(fakeAgent().client);

  const history = [
    { role: 'user', content: 'is caddy up?' },
    { role: 'assistant', content: 'yes, caddy is active' }
  ];
  await runChat({ question: 'are you sure?', history });

  const sent = seen[0].messages;
  assert.deepEqual(sent.map(m => m.content), ['is caddy up?', 'yes, caddy is active', 'are you sure?']);
  assert.deepEqual(sent.map(m => m.role), ['user', 'assistant', 'user']);
});

test('an empty history sends only the new question — no phantom prior turns', async () => {
  const { adapter, seen } = scriptedProvider([{ action: 'answer', answer: 'ok' }]);
  _setProviderForTesting(adapter);
  _setClientForTesting(fakeAgent().client);

  await runChat({ question: 'hello' });
  assert.deepEqual(seen[0].messages, [{ role: 'user', content: 'hello' }]);
});

test('the system prompt lists only READ_ONLY tools, with their params schemas', async () => {
  const prompt = buildChatSystemPrompt(CATALOG.filter(t => t.risk === 'READ_ONLY'));
  assert.match(prompt, /get_service_status/);
  assert.match(prompt, /params schema/);
  assert.ok(!prompt.includes('restart_service'), 'a mutating tool must not be advertised to chat');
  assert.ok(!prompt.includes('stop_container'));
});

test('every provider round trip is recorded in ai_runs with purpose=chat', async () => {
  const { adapter } = scriptedProvider([
    { action: 'tool', tool: 'get_system_metrics', params: {} },
    { action: 'answer', answer: 'fine' }
  ]);
  _setProviderForTesting(adapter);
  _setClientForTesting(fakeAgent({ onCall: () => ({ cpu: 4 }) }).client);

  await runChat({ question: 'how is cpu' });
  const rows = getDb().prepare("SELECT * FROM ai_runs WHERE purpose = 'chat' ORDER BY id").all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].incident_id, null);
  assert.deepEqual(rows.map(r => r.attempt), [1, 2]);
});

test('chat tool calls land in the tool_executions audit trail', async () => {
  const { adapter } = scriptedProvider([
    { action: 'tool', tool: 'get_system_metrics', params: {} },
    { action: 'answer', answer: 'fine' }
  ]);
  _setProviderForTesting(adapter);
  _setClientForTesting(fakeAgent({ onCall: () => ({ cpu: 4 }) }).client);

  await runChat({ question: 'how is cpu' });
  const rows = getDb().prepare('SELECT * FROM tool_executions').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].requested_by, 'chat');
  assert.equal(rows[0].approved, 0);
  assert.equal(rows[0].incident_id, null);
});

test('runChat refuses to run at all with no AI provider configured', async () => {
  clearAIConfig();
  const prev = process.env.AI_API_KEY;
  delete process.env.AI_API_KEY;
  try {
    await assert.rejects(() => runChat({ question: 'hi' }), /No AI provider configured/);
  } finally {
    if (prev) process.env.AI_API_KEY = prev;
    setAIConfig({ provider: 'anthropic', model: 'test-model', apiKey: 'sk-test-key' });
  }
});

// ── Transient-provider retry ────────────────────────────────────────
// Reproduces a real bug: an OpenRouter free-tier model returned a real
// completion on some calls and "OpenAI-compatible API error (404):
// Provider returned error" on others, for the byte-identical request.

test('retryableProviderStatus recognises the transient classes and excludes auth/bad-request', () => {
  for (const status of [404, 408, 429, 500, 502, 503, 504]) {
    assert.equal(retryableProviderStatus(`OpenAI-compatible API error (${status}): x`), true, `status ${status}`);
  }
  for (const status of [400, 401, 403]) {
    assert.equal(retryableProviderStatus(`OpenAI-compatible API error (${status}): x`), false, `status ${status}`);
  }
  // A status-less failure is classified on its text: a transport-level
  // error (DNS, refused connection, socket hang-up) is exactly the
  // transient case and IS retried; anything else unrecognised is not.
  assert.equal(retryableProviderStatus('fetch failed'), true);
  assert.equal(retryableProviderStatus('ECONNRESET'), true);
  assert.equal(retryableProviderStatus('the model refused to answer'), false);
  assert.equal(retryableProviderStatus(undefined), false);
});

test('a transient 404 is retried and the turn succeeds without surfacing an error', async () => {
  const provider = flakyProvider(
    ['OpenAI-compatible API error (404): Provider returned error'],
    { action: 'answer', answer: 'all good' }
  );
  _setProviderForTesting(provider);
  _setClientForTesting(fakeAgent().client);

  const result = await runChat({ question: 'status?' });
  assert.equal(result.answer, 'all good');
  assert.equal(provider.calls.length, 2, 'one failed attempt, one retry that succeeded');

  const rows = getDb().prepare("SELECT * FROM ai_runs WHERE purpose = 'chat' ORDER BY id").all();
  assert.equal(rows.length, 2, 'both the failed and the succeeding attempt are recorded');
  assert.match(rows[0].error, /404/);
  assert.equal(rows[1].error, null);
});

test('a persistently failing transient status exhausts retries and surfaces the error', async () => {
  const messages = Array.from({ length: PROVIDER_RETRY_ATTEMPTS + 1 }, () =>
    'OpenAI-compatible API error (500): upstream unavailable');
  const provider = flakyProvider(messages, { action: 'answer', answer: 'unreachable' });
  _setProviderForTesting(provider);
  _setClientForTesting(fakeAgent().client);

  await assert.rejects(() => runChat({ question: 'status?' }), /upstream unavailable/);
  assert.equal(provider.calls.length, PROVIDER_RETRY_ATTEMPTS + 1, 'tried the initial call plus every retry, then gave up');

  const rows = getDb().prepare("SELECT * FROM ai_runs WHERE purpose = 'chat'").all();
  assert.equal(rows.length, PROVIDER_RETRY_ATTEMPTS + 1, 'every failed attempt is individually recorded');
});

test('a non-retryable status (bad API key) fails on the first attempt, no retry wasted', async () => {
  const provider = flakyProvider(
    ['OpenAI-compatible API error (401): Invalid API key'],
    { action: 'answer', answer: 'unreachable' }
  );
  _setProviderForTesting(provider);
  _setClientForTesting(fakeAgent().client);

  await assert.rejects(() => runChat({ question: 'status?' }), /Invalid API key/);
  assert.equal(provider.calls.length, 1, 'a 401 is never worth retrying — it will fail identically every time');
});

// ── Abandoned/slow turns ─────────────────────────────────────────────
// Reproduces a second real bug found the same session: reopening a chat
// after the browser reported "network error" showed an extra tool call
// and a final answer that had run *after* the connection was already
// gone — the server kept working on a turn nobody was listening to.

test('a cancelled turn stops before the next provider call and makes no more tool calls', async () => {
  const provider = scriptedProvider([
    { action: 'tool', tool: 'get_system_metrics', params: {} },
    { action: 'tool', tool: 'get_system_metrics', params: {} }, // must never be reached
    { action: 'answer', answer: 'unreachable' }
  ]);
  _setProviderForTesting(provider.adapter);
  const agent = fakeAgent({ onCall: () => ({ cpu: 4 }) });
  _setClientForTesting(agent.client);

  let cancelAfterFirstTool = false;
  const result = await runChat({
    question: 'keep checking',
    isCancelled: () => cancelAfterFirstTool,
    onEvent: (type) => { if (type === 'tool_result') cancelAfterFirstTool = true; }
  });

  assert.equal(result.cancelled, true);
  assert.equal(result.answer, null);
  assert.equal(agent.calls.length, 1, 'only the tool call already in flight when cancellation happened runs');
  assert.equal(provider.seen.length, 1, 'the step after cancellation was detected never asks the model again');
});

test('a turn that exceeds its wall-clock budget stops and reports what it found, not a hang', async () => {
  // An artificial delay per provider call guarantees real elapsed time
  // passes between loop iterations regardless of test-machine speed —
  // asserting the exact iteration a timing-based cutoff fires on would
  // otherwise be flaky.
  const provider = scriptedProvider([
    { action: 'tool', tool: 'get_system_metrics', params: {} },
    { action: 'tool', tool: 'get_system_metrics', params: {} },
    { action: 'answer', answer: 'unreachable' }
  ]);
  const slowAdapter = { chat: async (args) => { await new Promise(r => setTimeout(r, 30)); return provider.adapter.chat(args); } };
  _setProviderForTesting(slowAdapter);
  _setClientForTesting(fakeAgent({ onCall: () => ({ cpu: 4 }) }).client);

  const result = await runChat({ question: 'slow', maxTurnMs: 25 });
  assert.match(result.answer, /taking longer than expected/);
  assert.equal(result.cancelled, undefined);
  assert.ok(provider.seen.length < 3, 'stops well before exhausting MAX_STEPS');
});

test('timeoutAnswer picks the "found something" vs "found nothing" message correctly', () => {
  assert.match(timeoutAnswer(0), /wasn't able to find anything yet/);
  assert.match(timeoutAnswer(1), /here's what I found/i);
  assert.match(timeoutAnswer(3), /here's what I found/i);
});

test('normalizeSuggestion drops a partial suggestion rather than escalating on it', () => {
  assert.equal(normalizeSuggestion(null), null);
  assert.equal(normalizeSuggestion({ resourceType: 'service' }), null);
  assert.equal(normalizeSuggestion({ externalId: 'caddy' }), null);
  assert.deepEqual(
    normalizeSuggestion({ resourceType: 'service', externalId: 'caddy', summary: 'down' }),
    { resourceType: 'service', externalId: 'caddy', summary: 'down' }
  );
});


// ── Access scope: file tools and local tools ────────────────────────────
// The two safety gates (chat refuses non-READ_ONLY by registered risk;
// the agent independently re-checks with approved:false) must still hold
// now that the catalog has two sources and one of them takes a path.

test('the allowed roots come from Settings, never from the model', async () => {
  const { setAccessScope } = require('../settings/accessScope');
  setAccessScope({ paths: ['/var/log'] });

  let received = null;
  _setClientForTesting({
    listTools: async () => ([{
      name: 'read_file', risk: 'READ_ONLY', description: 'read',
      parameters: { type: 'object', properties: { path: { type: 'string' }, roots: { type: 'array' } } }
    }]),
    callTool: async (name, params) => { received = params; return { content: 'hello' }; },
    verifyTool: async () => ({ ok: true })
  });
  // The model tries to widen its own access by naming its own roots.
  _setProviderForTesting(scriptedProvider([
    { action: 'tool', tool: 'read_file', params: { path: '/etc/shadow', roots: ['/'] } },
    { action: 'answer', answer: 'done' }
  ]).adapter);

  await runChat({ question: 'read something' });

  assert.deepEqual(received.roots, ['/var/log'], "the model's own roots are overwritten by settings");
  setAccessScope({ paths: [] });
});

test('with no directories allowed, file tools are still offered but get an empty allowlist', async () => {
  const { setAccessScope } = require('../settings/accessScope');
  setAccessScope({ paths: [] });

  let received = null;
  _setClientForTesting({
    listTools: async () => ([{
      name: 'list_directory', risk: 'READ_ONLY', description: 'list',
      parameters: { type: 'object', properties: { path: { type: 'string' }, roots: { type: 'array' } } }
    }]),
    callTool: async (name, params) => { received = params; throw new Error('No filesystem access is configured.'); },
    verifyTool: async () => ({ ok: true })
  });
  _setProviderForTesting(scriptedProvider([
    { action: 'tool', tool: 'list_directory', params: { path: '/srv' } },
    { action: 'answer', answer: 'I could not look' }
  ]).adapter);

  const result = await runChat({ question: 'what is in /srv' });
  assert.deepEqual(received.roots, [], 'closed by default means the agent refuses, not that we guess');
  assert.equal(result.toolCalls[0].ok, false);
});

test('roots are NOT injected into non-file tools, whose schemas forbid extra properties', async () => {
  const { setAccessScope } = require('../settings/accessScope');
  setAccessScope({ paths: ['/var/log'] });

  let received = null;
  _setClientForTesting({
    listTools: async () => ([{
      name: 'get_system_metrics', risk: 'READ_ONLY', description: 'metrics',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    }]),
    callTool: async (name, params) => { received = params; return { cpu: 3 }; },
    verifyTool: async () => ({ ok: true })
  });
  _setProviderForTesting(scriptedProvider([
    { action: 'tool', tool: 'get_system_metrics', params: {} },
    { action: 'answer', answer: 'cpu is 3%' }
  ]).adapter);

  await runChat({ question: 'cpu?' });
  assert.deepEqual(received, {}, 'an unexpected "roots" would fail the agent\'s strict validation');
  setAccessScope({ paths: [] });
});

test("Sentinel's own-data tools are answered locally and never reach the agent", async () => {
  const { setAccessScope } = require('../settings/accessScope');
  const recordingDb = require('../recording/db');
  setAccessScope({ ownData: true });
  recordingDb.createSession('chat-local-session');

  let agentCalls = 0;
  _setClientForTesting({
    listTools: async () => ([]),
    callTool: async () => { agentCalls++; return {}; },
    verifyTool: async () => ({ ok: true })
  });
  _setProviderForTesting(scriptedProvider([
    { action: 'tool', tool: 'list_recording_sessions', params: {} },
    { action: 'answer', answer: 'there is one session' }
  ]).adapter);

  const result = await runChat({ question: 'what recordings are there?' });
  assert.equal(agentCalls, 0, 'a question about our own rows must not touch the privileged process');
  assert.equal(result.toolCalls[0].ok, true);
  assert.match(result.toolCalls[0].summary, /chat-local-session/);
});

test('a mutating file-ish tool name is still refused by risk, not by name', async () => {
  // The gate is the *registered* risk, so a hypothetical future
  // write_file would be refused without this list needing updating.
  let agentCalls = 0;
  _setClientForTesting({
    listTools: async () => ([{
      name: 'write_file', risk: 'HIGH_RISK', description: 'writes',
      parameters: { type: 'object', properties: { path: { type: 'string' } } }
    }]),
    callTool: async () => { agentCalls++; return {}; },
    verifyTool: async () => ({ ok: true })
  });
  _setProviderForTesting(scriptedProvider([
    { action: 'tool', tool: 'write_file', params: { path: '/etc/passwd' } },
    { action: 'answer', answer: 'refused' }
  ]).adapter);

  await runChat({ question: 'change something' });
  assert.equal(agentCalls, 0, 'chat must never send a non-READ_ONLY tool to the agent');
});
