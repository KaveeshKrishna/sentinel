'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = path.join(os.tmpdir(), `sentinel-test-failover-${crypto.randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;
process.env.SENTINEL_SECRET_KEY = crypto.randomBytes(32).toString('hex');

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { migrate } = require('../db/migrate');
const { getDb } = require('../db/connection');
const { addCredential, getCredential, listCredentials, reorderCredentials } = require('../settings/aiCredentials');
const { chatWithFailover, hasUsableProvider, isRetryable, AllProvidersFailedError } = require('./failover');
const { _setProviderForTesting, _resetProviderForTesting } = require('./provider');

before(() => migrate());
beforeEach(() => {
  getDb().prepare('DELETE FROM ai_credentials').run();
  getDb().prepare('DELETE FROM activity_events').run();
  _resetProviderForTesting();
  require('./failover')._resetNotificationStateForTesting();
  for (const key of ['AI_PROVIDER', 'AI_MODEL', 'AI_API_KEY', 'AI_BASE_URL']) delete process.env[key];
});
after(() => {
  _resetProviderForTesting();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(DB_PATH + suffix); } catch { /* already gone */ }
  }
});

/**
 * A fake adapter that answers or throws based on the API key it is
 * handed — which is exactly how the real thing distinguishes credentials,
 * and lets one adapter stand in for the whole chain.
 */
function keyedProvider(behaviour) {
  const calls = [];
  return {
    calls,
    chat: async ({ apiKey, model }) => {
      calls.push({ apiKey, model });
      const outcome = behaviour[apiKey];
      if (typeof outcome === 'string') throw new Error(outcome);
      if (typeof outcome === 'function') return outcome(calls.length);
      return { text: outcome ?? `answered by ${apiKey}`, toolCalls: [], usage: null };
    }
  };
}

function seedChain() {
  const a = addCredential({ label: 'primary', provider: 'anthropic', model: 'm1', apiKey: 'key-a' });
  const b = addCredential({ label: 'backup', provider: 'gemini', model: 'm2', apiKey: 'key-b' });
  const c = addCredential({ label: 'last resort', provider: 'openai-compatible', model: 'm3', apiKey: 'key-c' });
  return { a, b, c };
}

test('the highest-priority credential serves the call and the rest are never touched', async () => {
  seedChain();
  const provider = keyedProvider({});
  _setProviderForTesting(provider);

  const result = await chatWithFailover({ system: 's', messages: [] });
  assert.equal(result.text, 'answered by key-a');
  assert.equal(result.credential.label, 'primary');
  assert.equal(provider.calls.length, 1, 'a working primary costs exactly one call');
});

test('a failing credential falls over to the next one and the turn still succeeds', async () => {
  seedChain();
  _setProviderForTesting(keyedProvider({
    'key-a': 'Anthropic API error (429): rate limit exceeded'
  }));

  const result = await chatWithFailover({ system: 's', messages: [] }, { purpose: 'diagnosis' });
  assert.equal(result.text, 'answered by key-b');
  assert.equal(result.credential.label, 'backup', 'the caller gets a real answer, not an error');
});

test('failover walks the whole chain in priority order until one answers', async () => {
  seedChain();
  const provider = keyedProvider({
    'key-a': 'Anthropic API error (401): Invalid API key',
    'key-b': 'Gemini API error (429): quota exhausted'
  });
  _setProviderForTesting(provider);

  const result = await chatWithFailover({ system: 's', messages: [] });
  assert.equal(result.credential.label, 'last resort');
  assert.deepEqual(provider.calls.map(c => c.apiKey), ['key-a', 'key-b', 'key-c']);
});

test('reordering the chain changes which credential is tried first', async () => {
  const { a, c } = seedChain();
  reorderCredentials([c.id, a.id]);
  _setProviderForTesting(keyedProvider({}));

  const result = await chatWithFailover({ system: 's', messages: [] });
  assert.equal(result.credential.label, 'last resort', 'priority, not insertion order, decides');
});

test('each credential is called with its OWN key, model and base URL', async () => {
  addCredential({ label: 'one', provider: 'anthropic', model: 'model-one', apiKey: 'key-a' });
  addCredential({ label: 'two', provider: 'openai-compatible', model: 'model-two', baseUrl: 'https://example.test/v1', apiKey: 'key-b' });
  const provider = keyedProvider({ 'key-a': 'API error (500): down' });
  _setProviderForTesting(provider);

  await chatWithFailover({ system: 's', messages: [] });
  assert.deepEqual(provider.calls, [
    { apiKey: 'key-a', model: 'model-one' },
    { apiKey: 'key-b', model: 'model-two' }
  ]);
});

test('the exact failure reason is recorded per credential for the Settings page', async () => {
  const { a, b } = seedChain();
  _setProviderForTesting(keyedProvider({
    'key-a': 'Anthropic API error (401): Invalid API key',
    'key-b': 'Gemini API error (429): quota exhausted'
  }));

  await chatWithFailover({ system: 's', messages: [] });

  assert.match(getCredential(a.id).lastError, /Invalid API key/);
  assert.match(getCredential(b.id).lastError, /quota exhausted/);
  assert.ok(getCredential(a.id).lastErrorAt > 0);
});

test('a credential that works again has its stale error cleared', async () => {
  const { a } = seedChain();
  _setProviderForTesting(keyedProvider({ 'key-a': 'API error (503): temporarily down' }));
  await chatWithFailover({ system: 's', messages: [] });
  assert.ok(getCredential(a.id).lastError);

  _setProviderForTesting(keyedProvider({}));
  await chatWithFailover({ system: 's', messages: [] });
  assert.equal(getCredential(a.id).lastError, null);
  assert.ok(getCredential(a.id).lastOkAt > 0);
});

test('when every credential fails, the error names each provider and its real reason', async () => {
  seedChain();
  _setProviderForTesting(keyedProvider({
    'key-a': 'Anthropic API error (401): Invalid API key',
    'key-b': 'Gemini API error (429): quota exhausted',
    'key-c': 'OpenAI-compatible API error (502): upstream unavailable'
  }));

  await assert.rejects(
    () => chatWithFailover({ system: 's', messages: [] }),
    err => {
      assert.ok(err instanceof AllProvidersFailedError);
      assert.equal(err.failures.length, 3);
      assert.match(err.message, /Invalid API key/);
      assert.match(err.message, /quota exhausted/);
      assert.match(err.message, /upstream unavailable/);
      return true;
    }
  );
});

test('a single configured credential failing surfaces its own message, unwrapped', async () => {
  addCredential({ label: 'only', provider: 'anthropic', apiKey: 'key-a' });
  _setProviderForTesting(keyedProvider({ 'key-a': 'Anthropic API error (401): Invalid API key' }));

  await assert.rejects(
    () => chatWithFailover({ system: 's', messages: [] }),
    err => {
      // Unwrapped: with one credential there is no chain to summarise,
      // so the operator sees the provider's own words, not a wrapper.
      assert.equal(err.message, 'Anthropic API error (401): Invalid API key');
      return true;
    }
  );
});

test('no configured credential at all fails immediately without calling anything', async () => {
  const provider = keyedProvider({});
  _setProviderForTesting(provider);
  assert.equal(hasUsableProvider(), false);

  await assert.rejects(() => chatWithFailover({ system: 's', messages: [] }), /no AI provider configured/);
  assert.equal(provider.calls.length, 0);
});

test('falls back to the env-var bootstrap when no credential has been saved', async () => {
  process.env.AI_PROVIDER = 'anthropic';
  process.env.AI_MODEL = 'env-model';
  process.env.AI_API_KEY = 'env-key';
  _setProviderForTesting(keyedProvider({}));

  assert.equal(hasUsableProvider(), true);
  const result = await chatWithFailover({ system: 's', messages: [] });
  assert.equal(result.text, 'answered by env-key');
  assert.equal(result.credential.id, null, 'the env fallback is not a stored row and records no health');
});

test('a saved credential takes precedence over the env-var bootstrap', async () => {
  process.env.AI_PROVIDER = 'anthropic';
  process.env.AI_API_KEY = 'env-key';
  addCredential({ label: 'saved', provider: 'anthropic', apiKey: 'key-a' });
  _setProviderForTesting(keyedProvider({}));

  const result = await chatWithFailover({ system: 's', messages: [] });
  assert.equal(result.credential.label, 'saved');
});

test('a disabled credential is skipped entirely, not merely deprioritised', async () => {
  const { a } = seedChain();
  require('../settings/aiCredentials').updateCredential(a.id, { enabled: false });
  const provider = keyedProvider({});
  _setProviderForTesting(provider);

  const result = await chatWithFailover({ system: 's', messages: [] });
  assert.equal(result.credential.label, 'backup');
  assert.ok(!provider.calls.some(c => c.apiKey === 'key-a'), 'a disabled key is never sent anywhere');
});

// ── Transient retry, before failing over ────────────────────────────────
// Retrying the operator's first-choice key is cheaper than falling back
// to a different model whose answers may be worse — so a flaky status is
// retried in place first (found live: OpenRouter's intermittent 404s).

test('retryTransient retries the SAME credential before moving to the next', async () => {
  seedChain();
  let attempts = 0;
  const provider = keyedProvider({
    'key-a': () => {
      attempts++;
      if (attempts === 1) throw new Error('OpenAI-compatible API error (404): Provider returned error');
      return { text: 'recovered on key-a', toolCalls: [], usage: null };
    }
  });
  _setProviderForTesting(provider);

  const result = await chatWithFailover({ system: 's', messages: [] }, { retryTransient: true });
  assert.equal(result.text, 'recovered on key-a');
  assert.equal(result.credential.label, 'primary', 'the preferred credential was not demoted over a blip');
  assert.deepEqual(provider.calls.map(c => c.apiKey), ['key-a', 'key-a']);
});

test('a non-retryable status fails over immediately without burning retries', async () => {
  seedChain();
  const provider = keyedProvider({ 'key-a': 'Anthropic API error (401): Invalid API key' });
  _setProviderForTesting(provider);

  const result = await chatWithFailover({ system: 's', messages: [] }, { retryTransient: true });
  assert.equal(result.credential.label, 'backup');
  assert.deepEqual(
    provider.calls.map(c => c.apiKey), ['key-a', 'key-b'],
    'a bad key fails identically every time — retrying it only delays the fix'
  );
});

test('isRetryable separates a flaky provider from a misconfigured one', () => {
  for (const status of [404, 408, 429, 500, 502, 503, 504]) {
    assert.equal(isRetryable(`API error (${status}): x`), true, `status ${status}`);
  }
  for (const status of [400, 401, 403]) {
    assert.equal(isRetryable(`API error (${status}): x`), false, `status ${status}`);
  }
  assert.equal(isRetryable('fetch failed'), true);
  assert.equal(isRetryable('the model declined'), false);
});

// ── Operator visibility ────────────────────────────────────────────────

test('a failing credential is announced by name, with the provider\'s real reason', async () => {
  seedChain();
  _setProviderForTesting(keyedProvider({ 'key-a': 'Anthropic API error (401): Invalid API key' }));

  await chatWithFailover({ system: 's', messages: [] }, { purpose: 'diagnosis' });

  const rows = getDb().prepare('SELECT * FROM activity_events ORDER BY id DESC').all();
  const event = rows.find(r => r.type === 'AI_PROVIDER_FAILOVER');
  assert.ok(event, 'the operator is told a key stopped working even though the call succeeded');
  assert.match(event.message, /primary/, 'names the credential that FAILED, not the one that covered');
  assert.match(event.message, /Invalid API key/);
  assert.match(JSON.parse(event.details).failures[0].error, /Invalid API key/);
});

// ── Notification dedup ──────────────────────────────────────────────────
// Found in real use: with the primary key out of daily quota, every
// background diagnosis, chat turn and detector re-drive produced another
// identical toast, burying the one genuinely new fact (the second key had
// now failed too) under repeats of the first.

test('the same failure on the same credential is announced ONCE, not once per request', async () => {
  seedChain();
  _setProviderForTesting(keyedProvider({
    'key-a': 'OpenAI-compatible API error (429): Rate limit exceeded: free-models-per-day'
  }));

  for (let i = 0; i < 4; i++) await chatWithFailover({ system: 's', messages: [] });

  const events = getDb()
    .prepare("SELECT * FROM activity_events WHERE type = 'AI_PROVIDER_FAILOVER'").all();
  assert.equal(events.length, 1, 'four requests, one notification — the operator learns this once');
});

test('a DIFFERENT failure on the same credential is new information and IS announced', async () => {
  const { a } = seedChain();
  _setProviderForTesting(keyedProvider({ 'key-a': 'API error (401): Invalid API key' }));
  await chatWithFailover({ system: 's', messages: [] });

  // The operator swaps the key; now it fails a different way.
  require('../settings/aiCredentials').clearHealth(a.id);
  _setProviderForTesting(keyedProvider({ 'key-a': 'API error (500): upstream exploded' }));
  await chatWithFailover({ system: 's', messages: [] });

  const events = getDb()
    .prepare("SELECT message FROM activity_events WHERE type = 'AI_PROVIDER_FAILOVER' ORDER BY id").all();
  assert.equal(events.length, 2);
  assert.match(events[1].message, /upstream exploded/);
});

test('each credential in a failing chain gets its own notification, in order', async () => {
  seedChain();
  _setProviderForTesting(keyedProvider({
    'key-a': 'API error (401): first is down',
    'key-b': 'API error (401): second is down'
  }));

  await chatWithFailover({ system: 's', messages: [] });

  const messages = getDb()
    .prepare("SELECT message FROM activity_events WHERE type = 'AI_PROVIDER_FAILOVER' ORDER BY id").all()
    .map(r => r.message);
  assert.equal(messages.length, 2, 'one per failing key — the third worked, so it says nothing');
  assert.match(messages[0], /primary.*first is down/);
  assert.match(messages[1], /backup.*second is down/);
});

test('a credential that recovers can be announced again if it later fails', async () => {
  const { a } = seedChain();
  _setProviderForTesting(keyedProvider({ 'key-a': 'API error (500): down' }));
  await chatWithFailover({ system: 's', messages: [] });

  _setProviderForTesting(keyedProvider({}));            // key-a works again
  await chatWithFailover({ system: 's', messages: [] });
  assert.equal(getCredential(a.id).lastError, null);

  _setProviderForTesting(keyedProvider({ 'key-a': 'API error (500): down' }));
  await chatWithFailover({ system: 's', messages: [] });

  const events = getDb()
    .prepare("SELECT * FROM activity_events WHERE type = 'AI_PROVIDER_FAILOVER'").all();
  assert.equal(events.length, 2, 'a fresh outage after a recovery is not the same outage');
});

test('a fully successful call announces nothing — silence is the normal case', async () => {
  seedChain();
  _setProviderForTesting(keyedProvider({}));
  await chatWithFailover({ system: 's', messages: [] });

  const rows = getDb().prepare("SELECT * FROM activity_events WHERE type LIKE 'AI_PROVIDER%'").all();
  assert.equal(rows.length, 0);
});

test('an exhausted chain is announced once, not once per request', async () => {
  seedChain();
  _setProviderForTesting(keyedProvider({
    'key-a': 'API error (401): a', 'key-b': 'API error (401): b', 'key-c': 'API error (401): c'
  }));

  await assert.rejects(() => chatWithFailover({ system: 's', messages: [] }, { purpose: 'chat' }));
  await assert.rejects(() => chatWithFailover({ system: 's', messages: [] }, { purpose: 'chat' }));

  const types = getDb().prepare("SELECT type FROM activity_events WHERE type LIKE 'AI_PROVIDER%'").all()
    .map(r => r.type);
  // Under a 5s detector poll, announcing every stalled attempt would be
  // a notification every 5 seconds. Both layers dedupe.
  assert.equal(types.filter(t => t === 'AI_PROVIDER_EXHAUSTED').length, 1, 'not 2');
  assert.equal(types.filter(t => t === 'AI_PROVIDER_FAILOVER').length, 3, 'not 6');
});

test('onAttemptError fires once per failed attempt so every try lands in ai_runs', async () => {
  seedChain();
  _setProviderForTesting(keyedProvider({
    'key-a': 'API error (401): a', 'key-b': 'API error (401): b'
  }));

  const seen = [];
  await chatWithFailover({ system: 's', messages: [] }, {
    onAttemptError: ({ credential, error }) => seen.push(`${credential.label}:${error.message}`)
  });
  assert.deepEqual(seen, ['primary:API error (401): a', 'backup:API error (401): b']);
});

test('a throwing onAttemptError hook cannot break the failover chain', async () => {
  seedChain();
  _setProviderForTesting(keyedProvider({ 'key-a': 'API error (401): a' }));

  const result = await chatWithFailover({ system: 's', messages: [] }, {
    onAttemptError: () => { throw new Error('bookkeeping blew up'); }
  });
  assert.equal(result.credential.label, 'backup', 'audit bookkeeping is never allowed to stop the recovery');
});


// ── Quota budgets ───────────────────────────────────────────────────────
// The Gemini free tier this install uses allows 5 requests/minute and
// 20/day. Spending a request only to be told 429 costs the quota AND
// fails the call, so a credential known to be over budget is skipped
// before a request is made, not after it is refused.

test('a credential over its per-minute limit is skipped without spending a request', async () => {
  const a = addCredential({ label: 'capped', provider: 'gemini', apiKey: 'key-a', rpmLimit: 2 });
  addCredential({ label: 'uncapped', provider: 'anthropic', apiKey: 'key-b' });
  const provider = keyedProvider({});
  _setProviderForTesting(provider);

  // Two real calls consume the whole per-minute allowance.
  await chatWithFailover({ system: 's', messages: [] });
  await chatWithFailover({ system: 's', messages: [] });
  assert.equal(getCredential(a.id).usage.lastMinute, 2);

  const result = await chatWithFailover({ system: 's', messages: [] });
  assert.equal(result.credential.label, 'uncapped', 'fell through to the key with allowance left');
  assert.ok(
    !provider.calls.slice(2).some(c => c.apiKey === 'key-a'),
    'the over-budget key was never sent a request at all'
  );
});

test('a credential over its per-day limit is skipped', async () => {
  addCredential({ label: 'daily', provider: 'gemini', apiKey: 'key-a', rpdLimit: 1 });
  addCredential({ label: 'backup', provider: 'anthropic', apiKey: 'key-b' });
  _setProviderForTesting(keyedProvider({}));

  const first = await chatWithFailover({ system: 's', messages: [] });
  assert.equal(first.credential.label, 'daily');

  const second = await chatWithFailover({ system: 's', messages: [] });
  assert.equal(second.credential.label, 'backup', 'the day\'s single request is already spent');
});

test('a 429 puts the credential in cooldown so it is not re-asked on every later call', async () => {
  const a = addCredential({ label: 'limited', provider: 'gemini', apiKey: 'key-a' });
  addCredential({ label: 'backup', provider: 'anthropic', apiKey: 'key-b' });
  const provider = keyedProvider({
    'key-a': 'Gemini API error (429): Rate limit exceeded: free-models-per-day'
  });
  _setProviderForTesting(provider);

  await chatWithFailover({ system: 's', messages: [] });
  assert.ok(getCredential(a.id).cooldownUntil > Date.now(), 'the provider said stop, so we stop');

  const callsAfterFirst = provider.calls.length;
  await chatWithFailover({ system: 's', messages: [] });
  await chatWithFailover({ system: 's', messages: [] });

  assert.ok(
    !provider.calls.slice(callsAfterFirst).some(c => c.apiKey === 'key-a'),
    'a rate-limited key is not re-asked while it is still in cooldown'
  );
});

test('a non-rate-limit failure does NOT trigger a cooldown', async () => {
  const a = addCredential({ label: 'bad key', provider: 'anthropic', apiKey: 'key-a' });
  addCredential({ label: 'backup', provider: 'anthropic', apiKey: 'key-b' });
  _setProviderForTesting(keyedProvider({ 'key-a': 'Anthropic API error (401): Invalid API key' }));

  await chatWithFailover({ system: 's', messages: [] });
  assert.equal(getCredential(a.id).cooldownUntil, null, 'a bad key is broken, not throttled');
});

test('every credential being over budget reports why, rather than a misleading provider error', async () => {
  addCredential({ label: 'capped', provider: 'gemini', apiKey: 'key-a', rpdLimit: 1 });
  _setProviderForTesting(keyedProvider({}));
  await chatWithFailover({ system: 's', messages: [] });

  await assert.rejects(
    () => chatWithFailover({ system: 's', messages: [] }),
    err => {
      assert.match(err.message, /local limit reached \(1\/day\)/);
      assert.equal(err.failures[0].skipped, true);
      return true;
    }
  );
});

test('clearing a credential\'s health lifts its cooldown, so a fixed key works immediately', async () => {
  const a = addCredential({ label: 'limited', provider: 'gemini', apiKey: 'key-a' });
  _setProviderForTesting(keyedProvider({ 'key-a': 'API error (429): slow down' }));
  await assert.rejects(() => chatWithFailover({ system: 's', messages: [] }));
  assert.ok(getCredential(a.id).cooldownUntil > Date.now());

  // Editing the credential in Settings is the operator saying "I fixed it".
  require('../settings/aiCredentials').updateCredential(a.id, { apiKey: 'key-a' });
  _setProviderForTesting(keyedProvider({}));
  const result = await chatWithFailover({ system: 's', messages: [] });
  assert.equal(result.credential.label, 'limited', 'no waiting out a cooldown that no longer applies');
});


test('a recovery re-arms the exhausted notification, so a later outage is reported again', async () => {
  seedChain();
  const allDown = {
    'key-a': 'API error (401): a', 'key-b': 'API error (401): b', 'key-c': 'API error (401): c'
  };
  _setProviderForTesting(keyedProvider(allDown));
  await assert.rejects(() => chatWithFailover({ system: 's', messages: [] }));

  _setProviderForTesting(keyedProvider({}));           // everything works again
  await chatWithFailover({ system: 's', messages: [] });

  _setProviderForTesting(keyedProvider(allDown));      // ...and breaks again
  await assert.rejects(() => chatWithFailover({ system: 's', messages: [] }));

  const count = getDb()
    .prepare("SELECT COUNT(*) c FROM activity_events WHERE type = 'AI_PROVIDER_EXHAUSTED'").get().c;
  assert.equal(count, 2, 'a fresh outage after a recovery is not the same outage');
});
