'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = path.join(os.tmpdir(), `sentinel-test-health-${crypto.randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;
process.env.JWT_SECRET = 'test-jwt-secret-not-used-in-production';
process.env.NODE_ENV = 'test';
process.env.SENTINEL_SECRET_KEY = crypto.randomBytes(32).toString('hex');

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { migrate } = require('../db/migrate');
migrate();

const { createApp } = require('../app');
const { getDb } = require('../db/connection');
const { setSetting, getSetting } = require('../db/settings');
const { SETUP_TOKEN_KEY } = require('../setup/bootstrap');
const { _setClientForTesting, _resetClientForTesting } = require('../agent/client');
const { addCredential } = require('../settings/aiCredentials');

const SETUP_TOKEN = crypto.randomBytes(24).toString('base64url');
setSetting(SETUP_TOKEN_KEY, SETUP_TOKEN);

after(() => {
  _resetClientForTesting();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(DB_PATH + suffix); } catch { /* already gone */ }
  }
});

beforeEach(() => {
  const db = getDb();
  db.prepare('DELETE FROM tool_executions').run();
  db.prepare('DELETE FROM ai_runs').run();
});

async function withServer(fn) {
  const app = createApp();
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const port = server.address().port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function extractCookie(res) {
  const raw = res.headers.get('set-cookie') || '';
  const match = raw.match(/sentinel_token=([^;]+)/);
  return match ? match[1] : null;
}

let cachedAuthHeader = null;
async function loginAndGetAuthHeader(base) {
  if (cachedAuthHeader) return cachedAuthHeader;
  if (!getSetting('__health_test_admin_created')) {
    await fetch(`${base}/api/setup/complete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: SETUP_TOKEN, username: 'admin', password: 'longenough123' })
    });
    setSetting('__health_test_admin_created', 'true');
  }
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'longenough123' })
  });
  cachedAuthHeader = { Cookie: `sentinel_token=${extractCookie(res)}` };
  return cachedAuthHeader;
}

test('GET /api/health/overview requires auth', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/health/overview`);
    assert.equal(res.status, 401);
  });
});

test('reports a reachable agent with a real latency and tool count', async () => {
  await withServer(async (base) => {
    const auth = await loginAndGetAuthHeader(base);
    _setClientForTesting({ listTools: async () => [{ name: 'a' }, { name: 'b' }] });

    const body = await (await fetch(`${base}/api/health/overview`, { headers: auth })).json();
    assert.equal(body.agent.reachable, true);
    assert.equal(body.agent.toolCount, 2);
    assert.equal(typeof body.agent.latencyMs, 'number');
    assert.ok(body.agent.latencyMs >= 0);

    _resetClientForTesting();
  });
});

test('an unreachable agent reports reachable:false with the real error, not a 500', async () => {
  await withServer(async (base) => {
    const auth = await loginAndGetAuthHeader(base);
    _setClientForTesting({ listTools: async () => { throw new Error('connect ECONNREFUSED'); } });

    const res = await fetch(`${base}/api/health/overview`, { headers: auth });
    assert.equal(res.status, 200, 'a down agent must not fail the whole panel');
    const body = await res.json();
    assert.equal(body.agent.reachable, false);
    assert.match(body.agent.error, /ECONNREFUSED/);

    _resetClientForTesting();
  });
});

test('db.sizeKb is a real positive number derived from SQLite pragmas', async () => {
  await withServer(async (base) => {
    const auth = await loginAndGetAuthHeader(base);
    _setClientForTesting({ listTools: async () => [] });
    const body = await (await fetch(`${base}/api/health/overview`, { headers: auth })).json();
    assert.ok(body.db.sizeKb > 0);
    _resetClientForTesting();
  });
});

test('tool_executions are aggregated by tool over the last 24h, with error rate and p95', async () => {
  await withServer(async (base) => {
    const auth = await loginAndGetAuthHeader(base);
    _setClientForTesting({ listTools: async () => [] });

    const db = getDb();
    const insert = db.prepare(`
      INSERT INTO tool_executions (tool_name, params_json, requested_by, status, started_at, finished_at, duration_ms)
      VALUES (?, '{}', 'user', ?, ?, ?, ?)
    `);
    const now = Date.now();
    insert.run('get_system_metrics', 'ok', now, now + 10, 10);
    insert.run('get_system_metrics', 'ok', now, now + 20, 20);
    insert.run('get_system_metrics', 'error', now, now + 999, 999);
    // Older than 24h — must not be counted.
    insert.run('get_system_metrics', 'ok', now - 25 * 60 * 60 * 1000, now - 25 * 60 * 60 * 1000 + 5, 5);

    const body = await (await fetch(`${base}/api/health/overview`, { headers: auth })).json();
    const row = body.toolExecutions.byTool.find(t => t.toolName === 'get_system_metrics');
    assert.equal(row.count, 3, 'only the last-24h rows are counted');
    assert.equal(body.toolExecutions.totalCalls, 3);
    assert.equal(body.toolExecutions.totalErrors, 1);
    assert.ok(row.errorRate > 0 && row.errorRate < 1);
    assert.equal(row.p95DurationMs, 999, 'the slowest call dominates p95 at this sample size');

    _resetClientForTesting();
  });
});

test('ai_runs are aggregated by credential and by purpose over the last 7 days, naming the real credential label', async () => {
  await withServer(async (base) => {
    const auth = await loginAndGetAuthHeader(base);
    _setClientForTesting({ listTools: async () => [] });

    const credential = addCredential({ label: 'Primary Key', provider: 'anthropic', apiKey: 'sk-test-1234' });
    const db = getDb();
    const insert = db.prepare(`
      INSERT INTO ai_runs (incident_id, purpose, provider, model, credential_id, attempt, prompt_tokens, completion_tokens, latency_ms, created_at)
      VALUES (NULL, ?, 'anthropic', 'm', ?, 1, ?, ?, ?, ?)
    `);
    const now = Date.now();
    insert.run('diagnosis', credential.id, 100, 200, 500, now);
    insert.run('diagnosis', credential.id, 50, 100, 300, now);
    insert.run('chat', credential.id, 10, 20, 200, now);
    // Older than 7 days — must not be counted.
    insert.run('diagnosis', credential.id, 999, 999, 999, now - 8 * 24 * 60 * 60 * 1000);

    const body = await (await fetch(`${base}/api/health/overview`, { headers: auth })).json();

    const byCred = body.aiRuns.byCredential.find(c => c.credentialId === credential.id);
    assert.equal(byCred.label, 'Primary Key');
    assert.equal(byCred.requests, 3, 'only the last-7-days rows');
    assert.equal(byCred.promptTokens, 160);
    assert.equal(byCred.completionTokens, 320);

    const byPurpose = body.aiRuns.byPurpose.find(p => p.purpose === 'diagnosis');
    assert.equal(byPurpose.requests, 2);
    const chatPurpose = body.aiRuns.byPurpose.find(p => p.purpose === 'chat');
    assert.equal(chatPurpose.requests, 1);

    _resetClientForTesting();
  });
});
