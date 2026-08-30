'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = path.join(os.tmpdir(), `sentinel-test-app-${crypto.randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;
process.env.JWT_SECRET = 'test-jwt-secret-not-used-in-production';
process.env.NODE_ENV = 'test';
process.env.SENTINEL_SECRET_KEY = crypto.randomBytes(32).toString('hex');

const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');

const { migrate } = require('./db/migrate');
migrate();

const { createApp } = require('./app');
const { getSetting, setSetting } = require('./db/settings');
const { SETUP_TOKEN_KEY } = require('./setup/bootstrap');
const { countUsers } = require('./auth/users');
const { _setClientForTesting, _resetClientForTesting } = require('./agent/client');
const { _setProviderForTesting, _resetProviderForTesting } = require('./ai/provider');
const { setAIConfig, clearAIConfig } = require('./settings/aiConfig');
const store = require('./incidents/store');
const { upsertResource } = require('./graph/resources');

// createApp() doesn't run server.js's bootstrap (ensureSetupToken), so
// seed a setup token the same way it would, up front — tests below
// exercise the /api/setup routes against this known token.
const SETUP_TOKEN = crypto.randomBytes(24).toString('base64url');
setSetting(SETUP_TOKEN_KEY, SETUP_TOKEN);

after(() => {
  _resetClientForTesting();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(DB_PATH + suffix); } catch { /* already gone */ }
  }
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

/** Parses a `Set-Cookie` header for the sentinel_token value, for tests that need to reuse it. */
function extractCookie(res) {
  const raw = res.headers.get('set-cookie') || '';
  const match = raw.match(/sentinel_token=([^;]+)/);
  return match ? match[1] : null;
}

// The login route is rate-limited to 5 attempts/15min/IP (see
// bcryptLimiter.js) — every test in this file shares 127.0.0.1, so the
// Phase-3 route tests below log in exactly ONCE and reuse the resulting
// JWT cookie across every withServer() call. The JWT + its auth_sessions
// row are validated from the shared DB, not tied to any one server
// instance/port, so the same cookie value works against a fresh
// withServer() each time.
let cachedAuthHeader = null;
async function loginAndGetAuthHeader(base) {
  if (cachedAuthHeader) return cachedAuthHeader;
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'longenough123' })
  });
  cachedAuthHeader = { Cookie: `sentinel_token=${extractCookie(res)}` };
  return cachedAuthHeader;
}

test('GET /health requires no auth', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
  });
});

test('protected routes reject requests with no session cookie', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/activity`);
    assert.equal(res.status, 401);
  });
});

// ── Setup flow ────────────────────────────────────────────────────────────────

test('GET /api/setup/status reports needsSetup true before any user exists', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/setup/status`);
    const body = await res.json();
    assert.equal(body.needsSetup, true);
  });
});

test('POST /api/setup/complete rejects a wrong setup token', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/setup/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'wrong-token', username: 'admin', password: 'longenough123' })
    });
    assert.equal(res.status, 401);
    assert.equal(countUsers(), 0);
  });
});

test('POST /api/setup/complete rejects a short password', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/setup/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: SETUP_TOKEN, username: 'admin', password: 'short' })
    });
    assert.equal(res.status, 400);
    assert.equal(countUsers(), 0);
  });
});

test('POST /api/setup/complete with the correct token creates the admin and logs them in', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/setup/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: SETUP_TOKEN, username: 'admin', password: 'longenough123' })
    });
    assert.equal(res.status, 200);
    assert.equal(countUsers(), 1);
    assert.ok(extractCookie(res), 'setup should auto-login by setting the session cookie');
    assert.equal(getSetting(SETUP_TOKEN_KEY), null, 'setup token should be consumed');
  });
});

test('a second setup attempt is rejected once an admin exists', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/setup/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'anything', username: 'someone-else', password: 'longenough123' })
    });
    assert.equal(res.status, 409);
    assert.equal(countUsers(), 1);
  });
});

// ── Login flow (uses the admin user created above) ──────────────────────────

test('login with the correct password succeeds and sets a session cookie', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'longenough123' })
    });
    assert.equal(res.status, 200);
    const cookie = extractCookie(res);
    assert.ok(cookie);

    const checkRes = await fetch(`${base}/api/auth/check`, { headers: { Cookie: `sentinel_token=${cookie}` } });
    const checkBody = await checkRes.json();
    assert.equal(checkBody.authenticated, true);
    assert.equal(checkBody.username, 'admin');
  });
});

test('login with a wrong password fails with 401', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'totally-wrong' })
    });
    assert.equal(res.status, 401);
  });
});

test('login with an unknown username fails with 401 (not a different error)', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'nobody', password: 'irrelevant123' })
    });
    assert.equal(res.status, 401);
  });
});

test('logout revokes the session — the same cookie stops working afterward', async () => {
  await withServer(async (base) => {
    const loginRes = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'longenough123' })
    });
    const cookie = extractCookie(loginRes);

    const protectedBefore = await fetch(`${base}/api/activity`, { headers: { Cookie: `sentinel_token=${cookie}` } });
    assert.equal(protectedBefore.status, 200);

    await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { Cookie: `sentinel_token=${cookie}` } });

    const protectedAfter = await fetch(`${base}/api/activity`, { headers: { Cookie: `sentinel_token=${cookie}` } });
    assert.equal(protectedAfter.status, 401, 'the same JWT should be rejected once its session is revoked');
  });
});

// ── Settings/AI (Phase 3) ────────────────────────────────────────────────────

test('GET /api/settings/ai reports unconfigured, and PUT/GET never leaks the raw key', async () => {
  await withServer(async (base) => {
    const auth = await loginAndGetAuthHeader(base);

    const before = await (await fetch(`${base}/api/settings/ai`, { headers: auth })).json();
    assert.equal(before.configured, false);

    const putRes = await fetch(`${base}/api/settings/ai`, {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'anthropic', model: 'claude-sonnet-5', apiKey: 'sk-ant-super-secret-value-123' })
    });
    assert.equal(putRes.status, 200);
    const putBody = await putRes.json();
    assert.equal(putBody.configured, true);
    assert.ok(!JSON.stringify(putBody).includes('sk-ant-super-secret-value-123'));

    const after2 = await (await fetch(`${base}/api/settings/ai`, { headers: auth })).json();
    assert.equal(after2.provider, 'anthropic');
    assert.ok(!JSON.stringify(after2).includes('sk-ant-super-secret-value-123'));

    // clean up so later tests in this file see an unconfigured provider again
    await fetch(`${base}/api/settings/ai`, { method: 'DELETE', headers: auth });
  });
});

// ── Settings/AI credential pool + failover ───────────────────────────────────

/** Thin wrappers so the credential tests read as intent, not as fetch noise. */
function credApi(base, auth) {
  const json = { ...auth, 'Content-Type': 'application/json' };
  return {
    list:   async () => (await fetch(`${base}/api/settings/ai/credentials`, { headers: auth })).json(),
    add:    (body) => fetch(`${base}/api/settings/ai/credentials`, { method: 'POST', headers: json, body: JSON.stringify(body) }),
    update: (id, body) => fetch(`${base}/api/settings/ai/credentials/${id}`, { method: 'PUT', headers: json, body: JSON.stringify(body) }),
    remove: (id) => fetch(`${base}/api/settings/ai/credentials/${id}`, { method: 'DELETE', headers: auth }),
    order:  (ids) => fetch(`${base}/api/settings/ai/credentials/order`, { method: 'PUT', headers: json, body: JSON.stringify({ ids }) })
  };
}

async function clearCredentials(base, auth) {
  const { credentials } = await credApi(base, auth).list();
  for (const c of credentials) await credApi(base, auth).remove(c.id);
}

test('AI credentials can be added, listed in failover order, and never leak a raw key', async () => {
  await withServer(async (base) => {
    const auth = await loginAndGetAuthHeader(base);
    const api = credApi(base, auth);
    await clearCredentials(base, auth);

    const created = await api.add({ label: 'Primary', provider: 'anthropic', model: 'claude-sonnet-5', apiKey: 'sk-ant-secret-value-1111' });
    assert.equal(created.status, 201);
    const body = await created.json();
    assert.equal(body.keySuffix, '1111');
    assert.ok(!JSON.stringify(body).includes('sk-ant-secret-value-1111'));

    await api.add({ label: 'Backup', provider: 'gemini', apiKey: 'gem-secret-2222' });

    const { credentials } = await api.list();
    assert.deepEqual(credentials.map(c => c.label), ['Primary', 'Backup']);
    assert.ok(!JSON.stringify(credentials).includes('sk-ant-secret-value-1111'));
    assert.ok(!JSON.stringify(credentials).includes('gem-secret-2222'));

    await clearCredentials(base, auth);
  });
});

test('PUT /api/settings/ai/credentials/order reorders the chain and is not swallowed by /:id', async () => {
  await withServer(async (base) => {
    const auth = await loginAndGetAuthHeader(base);
    const api = credApi(base, auth);
    await clearCredentials(base, auth);

    const a = await (await api.add({ label: 'A', provider: 'anthropic', apiKey: 'k1' })).json();
    const b = await (await api.add({ label: 'B', provider: 'gemini', apiKey: 'k2' })).json();

    const res = await api.order([b.id, a.id]);
    assert.equal(res.status, 200, "'order' must route to the reorder handler, not to :id");
    assert.deepEqual((await res.json()).credentials.map(c => c.label), ['B', 'A']);

    await clearCredentials(base, auth);
  });
});

test('a credential can be disabled and re-enabled without losing its stored key', async () => {
  await withServer(async (base) => {
    const auth = await loginAndGetAuthHeader(base);
    const api = credApi(base, auth);
    await clearCredentials(base, auth);

    const a = await (await api.add({ label: 'A', provider: 'anthropic', apiKey: 'sk-keep-me-4444' })).json();
    const disabled = await (await api.update(a.id, { enabled: false })).json();
    assert.equal(disabled.enabled, false);
    // No apiKey sent — the stored one must survive, or disabling would
    // silently destroy the credential.
    const reenabled = await (await api.update(a.id, { enabled: true })).json();
    assert.equal(reenabled.enabled, true);
    assert.equal(reenabled.keySuffix, '4444');

    await clearCredentials(base, auth);
  });
});

test('credential routes reject a bad provider and 404 an unknown id', async () => {
  await withServer(async (base) => {
    const auth = await loginAndGetAuthHeader(base);
    const api = credApi(base, auth);

    assert.equal((await api.add({ provider: 'not-a-provider', apiKey: 'x' })).status, 400);
    assert.equal((await api.add({ provider: 'anthropic' })).status, 400, 'a credential with no key is not a credential');
    assert.equal((await api.update(999999, { label: 'x' })).status, 404);
    assert.equal((await api.remove(999999)).status, 404);
  });
});

test('the legacy single-provider PUT /api/settings/ai and the credential pool stay one source of truth', async () => {
  await withServer(async (base) => {
    const auth = await loginAndGetAuthHeader(base);
    const api = credApi(base, auth);
    await clearCredentials(base, auth);

    await fetch(`${base}/api/settings/ai`, {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'anthropic', model: 'claude-sonnet-5', apiKey: 'sk-legacy-9999' })
    });

    const { credentials } = await api.list();
    assert.equal(credentials.length, 1, 'the legacy form writes into the pool, not a second store');
    assert.equal(credentials[0].keySuffix, '9999');

    // ...and the pool is what the legacy read reports back.
    const cfg = await (await fetch(`${base}/api/settings/ai`, { headers: auth })).json();
    assert.equal(cfg.configured, true);
    assert.equal(cfg.provider, 'anthropic');
    assert.equal(cfg.credentialCount, 1);

    await fetch(`${base}/api/settings/ai`, { method: 'DELETE', headers: auth });
    assert.equal((await api.list()).credentials.length, 0, 'DELETE clears the whole pool');
  });
});

test('PUT /api/settings/ai rejects an unknown provider', async () => {
  await withServer(async (base) => {
    const auth = await loginAndGetAuthHeader(base);
    const res = await fetch(`${base}/api/settings/ai`, {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'not-a-real-provider', apiKey: 'x' })
    });
    assert.equal(res.status, 400);
  });
});

// ── Tools & resources (Phase 3) ──────────────────────────────────────────────

test('GET /api/tools proxies the agent catalog and requires auth', async () => {
  await withServer(async (base) => {
    _setClientForTesting({ listTools: async () => [{ name: 'get_system_metrics', risk: 'READ_ONLY' }] });

    const unauthed = await fetch(`${base}/api/tools`);
    assert.equal(unauthed.status, 401);

    const auth = await loginAndGetAuthHeader(base);
    const res = await fetch(`${base}/api/tools`, { headers: auth });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.some(t => t.name === 'get_system_metrics'));
    _resetClientForTesting();
  });
});

test('POST /api/resources/relationships registers an edge visible via GET /api/resources', async () => {
  await withServer(async (base) => {
    const auth = await loginAndGetAuthHeader(base);
    const apiName = 'demo-api-' + crypto.randomUUID();
    const dbName = 'demo-db-' + crypto.randomUUID();

    const res = await fetch(`${base}/api/resources/relationships`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromType: 'container', fromExternalId: apiName, toType: 'container', toExternalId: dbName, relationship: 'depends_on' })
    });
    assert.equal(res.status, 200);

    const list = await (await fetch(`${base}/api/resources`, { headers: auth })).json();
    assert.ok(list.some(r => r.external_id === apiName));
    assert.ok(list.some(r => r.external_id === dbName));
  });
});

// ── Incidents (Phase 3) ──────────────────────────────────────────────────────

test('incident approval requires an actionId, executes via the agent only once approved, and never lets an illegal transition through', async () => {
  await withServer(async (base) => {
    const auth = await loginAndGetAuthHeader(base);

    let sawApproved = false;
    _setClientForTesting({
      listTools: async () => [{ name: 'restart_container', risk: 'MEDIUM_RISK' }],
      callTool: async (name, params, opts) => { sawApproved = opts?.approved === true; return { restarted: true }; },
      verifyTool: async () => ({ ok: true })
    });

    const resource = upsertResource({ type: 'container', externalId: 'http-test-' + crypto.randomUUID(), name: 'x' });
    const incident = store.createIncident({ resourceId: resource.id, triggerRule: 'container_exit', triggerSummary: 'exited' });
    store.updateIncidentStatus(incident.id, 'INVESTIGATING');
    store.recordDiagnosis(incident.id, { rootCause: 'x', confidence: 0.9 });
    const action = store.addAction(incident.id, { tool: 'restart_container', params: { id: 'x' }, claimedRisk: 'LOW', realRisk: 'MEDIUM_RISK', rationale: 'x' });
    store.updateIncidentStatus(incident.id, 'AWAITING_APPROVAL');

    // Dismiss requires no body; approve requires an actionId.
    const missingActionId = await fetch(`${base}/api/incidents/${incident.id}/approve`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(missingActionId.status, 400);
    assert.equal(sawApproved, false, 'the agent must never see approved:true until a real approval happens');

    const approveRes = await fetch(`${base}/api/incidents/${incident.id}/approve`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ actionId: action.id })
    });
    assert.equal(approveRes.status, 200);
    assert.equal(sawApproved, true);
    const resolved = await approveRes.json();
    assert.equal(resolved.status, 'RESOLVED');

    // The incident is now terminal — approving again is an illegal transition.
    const secondApprove = await fetch(`${base}/api/incidents/${incident.id}/approve`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ actionId: action.id })
    });
    assert.equal(secondApprove.status, 409);

    _resetClientForTesting();
  });
});

test('GET /api/incidents and GET /api/incidents/:id return the incident with its evidence and actions', async () => {
  await withServer(async (base) => {
    const auth = await loginAndGetAuthHeader(base);
    const resource = upsertResource({ type: 'service', externalId: 'svc-http-' + crypto.randomUUID(), name: 'svc' });
    const incident = store.createIncident({ resourceId: resource.id, triggerRule: 'service_inactive', triggerSummary: 'inactive' });
    store.addEvidence(incident.id, [{ resourceId: resource.id, sourceTool: 'get_service_status', summary: 'inactive', data: {} }]);

    const listRes = await fetch(`${base}/api/incidents`, { headers: auth });
    const list = await listRes.json();
    assert.ok(list.some(i => i.id === incident.id));

    const detailRes = await fetch(`${base}/api/incidents/${incident.id}`, { headers: auth });
    const detail = await detailRes.json();
    assert.equal(detail.id, incident.id);
    assert.equal(detail.evidence.length, 1);
  });
});

test('POST /api/incidents/:id/dismiss moves a non-terminal incident to DISMISSED', async () => {
  await withServer(async (base) => {
    const auth = await loginAndGetAuthHeader(base);
    const resource = upsertResource({ type: 'container', externalId: 'dismiss-http-' + crypto.randomUUID(), name: 'x' });
    const incident = store.createIncident({ resourceId: resource.id, triggerRule: 'container_exit', triggerSummary: 'exited' });

    const res = await fetch(`${base}/api/incidents/${incident.id}/dismiss`, { method: 'POST', headers: auth });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'DISMISSED');
  });
});

test('GET /api/incidents/:id/timeline returns ordered entries and a five-stage rollup', async () => {
  await withServer(async (base) => {
    const auth = await loginAndGetAuthHeader(base);
    const resource = upsertResource({ type: 'service', externalId: 'tl-http-' + crypto.randomUUID(), name: 'caddy' });
    const incident = store.createIncident({ resourceId: resource.id, triggerRule: 'service_inactive', triggerSummary: 'inactive' });
    store.updateIncidentStatus(incident.id, 'INVESTIGATING');
    store.updateIncidentStatus(incident.id, 'DIAGNOSED');

    const res = await fetch(`${base}/api/incidents/${incident.id}/timeline`, { headers: auth });
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.phases.length, 5);
    assert.deepEqual(body.phases.map(p => p.phase), ['OBSERVE', 'DIAGNOSE', 'PLAN', 'ACT', 'VERIFY']);
    assert.deepEqual(
      body.entries.filter(e => e.kind === 'transition').map(e => e.to),
      ['DETECTED', 'INVESTIGATING', 'DIAGNOSED']
    );
    assert.equal(body.phases[1].status, 'active'); // DIAGNOSE is the furthest reached, incident still open
    assert.equal(body.phases[4].status, 'pending');

    const missing = await fetch(`${base}/api/incidents/999999/timeline`, { headers: auth });
    assert.equal(missing.status, 404);
  });
});

test('GET /api/incidents/:id/report returns nulls before one exists, and 404s for an unknown id', async () => {
  await withServer(async (base) => {
    const auth = await loginAndGetAuthHeader(base);
    const resource = upsertResource({ type: 'container', externalId: 'rep-http-' + crypto.randomUUID(), name: 'demo-db' });
    const incident = store.createIncident({ resourceId: resource.id, triggerRule: 'container_exit', triggerSummary: 'exited' });

    const res = await fetch(`${base}/api/incidents/${incident.id}/report`, { headers: auth });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { report: null, markdown: null, generatedAt: null });

    const missing = await fetch(`${base}/api/incidents/999999/report`, { headers: auth });
    assert.equal(missing.status, 404);
  });
});

test('GET /api/incidents/:id/report renders stored structure as markdown', async () => {
  await withServer(async (base) => {
    const auth = await loginAndGetAuthHeader(base);
    const { saveReport } = require('./ai/report');
    const resource = upsertResource({ type: 'container', externalId: 'repmd-' + crypto.randomUUID(), name: 'demo-db' });
    const incident = store.createIncident({ resourceId: resource.id, triggerRule: 'container_oom', triggerSummary: 'oom' });
    saveReport(incident.id, {
      title: 'demo-db OOM', summary: 'it ran out of memory', rootCause: 'limit too low',
      prevention: ['raise the limit']
    });

    const body = await (await fetch(`${base}/api/incidents/${incident.id}/report`, { headers: auth })).json();
    assert.equal(body.report.title, 'demo-db OOM');
    assert.match(body.markdown, /# demo-db OOM/);
    assert.match(body.markdown, /- raise the limit/);
    assert.ok(body.generatedAt > 0);
  });
});

test('POST /api/incidents/:id/report surfaces a generation failure as 502', async () => {
  await withServer(async (base) => {
    const auth = await loginAndGetAuthHeader(base);
    const resource = upsertResource({ type: 'container', externalId: 'repfail-' + crypto.randomUUID(), name: 'x' });
    const incident = store.createIncident({ resourceId: resource.id, triggerRule: 'container_exit', triggerSummary: 'exited' });

    // No AI provider is configured in this suite.
    const res = await fetch(`${base}/api/incidents/${incident.id}/report`, { method: 'POST', headers: auth });
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /No AI provider configured/);
  });
});

// ── One-click approval links ─────────────────────────────────────────
// The only route that acts without a session cookie, so these cover the
// boundary rather than just the happy path.

function seedApprovable() {
  const { signApproveToken } = require('./notify/approveLink');
  const resource = upsertResource({ type: 'service', externalId: 'link-' + crypto.randomUUID(), name: 'caddy' });
  const incident = store.createIncident({ resourceId: resource.id, triggerRule: 'service_inactive', triggerSummary: 'inactive' });
  store.updateIncidentStatus(incident.id, 'INVESTIGATING');
  store.updateIncidentStatus(incident.id, 'DIAGNOSED');
  store.updateIncidentStatus(incident.id, 'AWAITING_APPROVAL');
  const action = store.addAction(incident.id, {
    tool: 'restart_service', params: { service: 'caddy' },
    claimedRisk: 'LOW_RISK', realRisk: 'MEDIUM_RISK', rationale: 'it is down'
  });
  return { incident, action, token: signApproveToken({ incidentId: incident.id, actionId: action.id }) };
}

test('GET /a/:token renders a confirm page and executes NOTHING', async () => {
  // Slack, Discord and mail clients all prefetch links for previews. If
  // GET approved, the notification itself would fire the remediation.
  await withServer(async (base) => {
    const { setNotifyConfig, clearNotifyConfig } = require('./settings/notifyConfig');
    setNotifyConfig({ baseUrl: 'https://sentinel.example.com' });
    setNotifyConfig({ approveLinks: true });
    try {
      const { incident, action, token } = seedApprovable();

      const res = await fetch(`${base}/a/${token}`);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /Approve this action\?/);
      assert.match(html, /restart_service/);
      assert.match(html, /MEDIUM_RISK/);

      // Nothing moved.
      assert.equal(store.getAction(action.id).status, 'proposed');
      assert.equal(store.getIncident(incident.id).status, 'AWAITING_APPROVAL');
    } finally {
      clearNotifyConfig();
    }
  });
});

test('a tampered or expired approve token is refused with 403', async () => {
  await withServer(async (base) => {
    const { setNotifyConfig, clearNotifyConfig } = require('./settings/notifyConfig');
    const { signApproveToken } = require('./notify/approveLink');
    setNotifyConfig({ baseUrl: 'https://sentinel.example.com' });
    setNotifyConfig({ approveLinks: true });
    try {
      const { action, token } = seedApprovable();

      for (const bad of [`${token}x`, 'garbage', 'a.b']) {
        assert.equal((await fetch(`${base}/a/${bad}`)).status, 403);
        assert.equal((await fetch(`${base}/a/${bad}`, { method: 'POST' })).status, 403);
      }

      const expired = signApproveToken({ incidentId: 1, actionId: action.id, expiresAt: Date.now() - 1000 });
      assert.equal((await fetch(`${base}/a/${expired}`, { method: 'POST' })).status, 403);
      assert.equal(store.getAction(action.id).status, 'proposed');
    } finally {
      clearNotifyConfig();
    }
  });
});

test('a valid approve link is refused while the feature is disabled', async () => {
  await withServer(async (base) => {
    const { clearNotifyConfig } = require('./settings/notifyConfig');
    clearNotifyConfig(); // approveLinks defaults to false
    const { action, token } = seedApprovable();

    assert.equal((await fetch(`${base}/a/${token}`)).status, 403);
    const post = await fetch(`${base}/a/${token}`, { method: 'POST' });
    assert.equal(post.status, 403);
    assert.equal(store.getAction(action.id).status, 'proposed');
  });
});

test('POST /a/:token executes once and is inert on replay', async () => {
  await withServer(async (base) => {
    const { setNotifyConfig, clearNotifyConfig } = require('./settings/notifyConfig');
    setNotifyConfig({ baseUrl: 'https://sentinel.example.com' });
    setNotifyConfig({ approveLinks: true });

    const calls = [];
    _setClientForTesting({
      listTools: async () => [{ name: 'restart_service', risk: 'MEDIUM_RISK', description: '', parameters: {}, hasVerify: true }],
      callTool: async (name, params, opts) => { calls.push({ name, params, opts }); return { ok: true }; },
      verifyTool: async () => ({ ok: true, active: true })
    });

    try {
      const { incident, action, token } = seedApprovable();

      const res = await fetch(`${base}/a/${token}`, { method: 'POST' });
      assert.equal(res.status, 200);
      assert.match(await res.text(), /Fixed and verified|Action approved/);

      assert.equal(calls.length, 1);
      assert.equal(calls[0].name, 'restart_service');
      assert.equal(calls[0].opts.approved, true);

      const executed = store.getAction(action.id);
      assert.equal(executed.status, 'executed');
      // A link approval is a human approval with no user id — it must
      // stay distinguishable from a machine one for the rate limit.
      assert.equal(executed.approved_via, 'link');
      assert.equal(executed.approved_by, null);
      assert.equal(store.getIncident(incident.id).status, 'RESOLVED');

      // Single-use by construction: the action is no longer 'proposed'.
      const replay = await fetch(`${base}/a/${token}`, { method: 'POST' });
      assert.equal(replay.status, 409);
      assert.match(await replay.text(), /Already handled/);
      assert.equal(calls.length, 1, 'a replayed link must not run the tool again');
    } finally {
      _resetClientForTesting();
      clearNotifyConfig();
    }
  });
});

test('GET/PUT/DELETE /api/settings/notify never echo a webhook URL back', async () => {
  await withServer(async (base) => {
    const auth = await loginAndGetAuthHeader(base);
    const headers = { ...auth, 'Content-Type': 'application/json' };
    const url = 'https://hooks.slack.com/services/T1/B1/secretpart';

    const put = await fetch(`${base}/api/settings/notify`, {
      method: 'PUT', headers, body: JSON.stringify({ slackUrl: url, baseUrl: 'https://sentinel.example.com' })
    });
    assert.equal(put.status, 200);
    const saved = await put.text();
    assert.ok(!saved.includes('secretpart'), 'the raw webhook URL must never reach the client');
    assert.match(saved, /hooks\.slack\.com/);

    const got = await (await fetch(`${base}/api/settings/notify`, { headers: auth })).json();
    assert.equal(got.channels.slack.configured, true);

    const bad = await fetch(`${base}/api/settings/notify`, {
      method: 'PUT', headers, body: JSON.stringify({ slackUrl: 'http://nope.example.com' })
    });
    assert.equal(bad.status, 400);

    assert.equal((await fetch(`${base}/api/settings/notify`, { method: 'DELETE', headers: auth })).status, 200);
  });
});

test('POST /api/settings/notify/test reports that nothing is configured', async () => {
  await withServer(async (base) => {
    const auth = await loginAndGetAuthHeader(base);
    const res = await fetch(`${base}/api/settings/notify/test`, { method: 'POST', headers: auth });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /No notification channel/);
  });
});

test('chat session routes list, read and delete conversations', async () => {
  await withServer(async (base) => {
    const auth = await loginAndGetAuthHeader(base);
    const chatStore = require('./ai/chatStore');
    const session = chatStore.createSession('why is cpu high?');
    chatStore.addMessage(session.id, { role: 'user', content: 'why is cpu high?' });
    chatStore.addMessage(session.id, {
      role: 'assistant', content: 'node is busy',
      toolCalls: { calls: [{ tool: 'get_system_metrics', ok: true, summary: '{}' }], suggestedIncident: null }
    });

    const list = await (await fetch(`${base}/api/chat/sessions`, { headers: auth })).json();
    assert.ok(list.some(s => s.id === session.id));

    const detail = await (await fetch(`${base}/api/chat/sessions/${session.id}`, { headers: auth })).json();
    assert.equal(detail.messages.length, 2);
    assert.equal(detail.messages[1].toolCalls.calls[0].tool, 'get_system_metrics');

    const del = await fetch(`${base}/api/chat/sessions/${session.id}`, { method: 'DELETE', headers: auth });
    assert.equal(del.status, 200);
    const gone = await fetch(`${base}/api/chat/sessions/${session.id}`, { headers: auth });
    assert.equal(gone.status, 404);
  });
});

test('POST /api/chat rejects an empty message before touching the AI', async () => {
  await withServer(async (base) => {
    const auth = await loginAndGetAuthHeader(base);
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '   ' })
    });
    assert.equal(res.status, 400);
  });
});

test('POST /api/chat streams an error event rather than failing the request when no provider is configured', async () => {
  await withServer(async (base) => {
    const auth = await loginAndGetAuthHeader(base);
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'is caddy up?' })
    });
    // The response is committed as a 200 SSE stream before the turn runs,
    // so a mid-turn failure has to arrive as an event, not a status code.
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /"type":"session"/);
    assert.match(body, /"type":"error"/);
    assert.match(body, /No AI provider configured/);
  });
});

test('abandoning a POST /api/chat request does NOT stop the turn — it finishes and is persisted', async () => {
  // Deliberately the reverse of the earlier behaviour. Aborting on client
  // disconnect was built to stop a dead connection burning quota, but it
  // meant the ordinary "ask something, go look at Incidents while it
  // thinks" lost the answer — and the provider request had already been
  // paid for either way. A turn now outlives its stream; only an explicit
  // Stop ends it early.
  await withServer(async (base) => {
    const auth = await loginAndGetAuthHeader(base);

    _setClientForTesting({
      listTools: async () => [{ name: 'get_system_metrics', risk: 'READ_ONLY', description: 'x', parameters: { type: 'object', properties: {} } }],
      callTool: async () => { await new Promise(r => setTimeout(r, 30)); return { cpu: 4 }; },
      verifyTool: async () => ({ ok: true })
    });

    let step = 0;
    _setProviderForTesting({
      chat: async () => {
        step++;
        await new Promise(r => setTimeout(r, 40));
        return step === 1
          ? { text: JSON.stringify({ action: 'tool', tool: 'get_system_metrics', params: {} }), toolCalls: [], usage: {} }
          : { text: JSON.stringify({ action: 'answer', answer: 'finished after you left' }), toolCalls: [], usage: {} };
      }
    });
    setAIConfig({ provider: 'anthropic', model: 'test-model', apiKey: 'sk-test-key' });

    try {
      const controller = new AbortController();
      const fetchPromise = fetch(`${base}/api/chat`, {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'answer me even if I leave' }),
        signal: controller.signal
      }).catch(() => {});

      await new Promise(r => setTimeout(r, 60)); // mid-turn
      controller.abort();
      await fetchPromise;

      // The turn should keep going and land its answer in the session.
      await new Promise(r => setTimeout(r, 500));

      const sessions = await (await fetch(`${base}/api/chat/sessions`, { headers: auth })).json();
      const session = sessions[0];
      const full = await (await fetch(`${base}/api/chat/sessions/${session.id}`, { headers: auth })).json();
      const assistant = full.messages.filter(m => m.role === 'assistant');

      assert.equal(assistant.length, 1, 'the abandoned turn still produced exactly one answer');
      assert.equal(assistant[0].content, 'finished after you left');
    } finally {
      _resetProviderForTesting();
      _resetClientForTesting();
      clearAIConfig();
    }
  });
});

test('POST /api/chat/sessions/:id/stop ends a running turn, and what it had gathered is kept', async () => {
  await withServer(async (base) => {
    const auth = await loginAndGetAuthHeader(base);

    let toolCallCount = 0;
    _setClientForTesting({
      listTools: async () => [{ name: 'get_system_metrics', risk: 'READ_ONLY', description: 'x', parameters: { type: 'object', properties: {} } }],
      callTool: async () => { toolCallCount++; await new Promise(r => setTimeout(r, 40)); return { cpu: 4 }; },
      verifyTool: async () => ({ ok: true })
    });
    // Never answers — only an explicit stop can end this turn.
    _setProviderForTesting({
      chat: async () => {
        await new Promise(r => setTimeout(r, 40));
        return { text: JSON.stringify({ action: 'tool', tool: 'get_system_metrics', params: {} }), toolCalls: [], usage: {} };
      }
    });
    setAIConfig({ provider: 'anthropic', model: 'test-model', apiKey: 'sk-test-key' });

    try {
      const chatPromise = fetch(`${base}/api/chat`, {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'loop forever' })
      }).then(r => r.text());

      await new Promise(r => setTimeout(r, 200));
      const running = await (await fetch(`${base}/api/chat/running`, { headers: auth })).json();
      assert.equal(running.running.length, 1, 'the turn is visible as in-flight');

      const sessionId = running.running[0].sessionId;
      const stopRes = await fetch(`${base}/api/chat/sessions/${sessionId}/stop`, { method: 'POST', headers: auth });
      assert.deepEqual(await stopRes.json(), { stopped: true });

      const body = await chatPromise;
      assert.match(body, /"type":"stopped"/);

      const countAtStop = toolCallCount;
      await new Promise(r => setTimeout(r, 300));
      assert.ok(toolCallCount <= countAtStop + 1, 'the loop actually stopped rather than running on');

      const full = await (await fetch(`${base}/api/chat/sessions/${sessionId}`, { headers: auth })).json();
      const assistant = full.messages.filter(m => m.role === 'assistant');
      assert.match(assistant[0].content, /stopped/, 'the partial turn is recorded honestly, not as an answer');
    } finally {
      _resetProviderForTesting();
      _resetClientForTesting();
      clearAIConfig();
    }
  });
});

test('a single-step turn is still stoppable — Stop lands while the one call is in flight', async () => {
  // Regression found live: cancellation was only polled at the top of
  // the loop, so a turn that answers in one provider call ignored Stop
  // entirely and the button looked broken.
  await withServer(async (base) => {
    const auth = await loginAndGetAuthHeader(base);

    _setClientForTesting({
      listTools: async () => [],
      callTool: async () => ({}),
      verifyTool: async () => ({ ok: true })
    });
    _setProviderForTesting({
      chat: async () => {
        await new Promise(r => setTimeout(r, 400)); // slow single call
        return { text: JSON.stringify({ action: 'answer', answer: 'should not be delivered' }), toolCalls: [], usage: {} };
      }
    });
    setAIConfig({ provider: 'anthropic', model: 'test-model', apiKey: 'sk-test-key' });

    try {
      const chatPromise = fetch(`${base}/api/chat`, {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'one shot' })
      }).then(r => r.text());

      await new Promise(r => setTimeout(r, 120)); // mid-call
      const running = await (await fetch(`${base}/api/chat/running`, { headers: auth })).json();
      const sessionId = running.running[0].sessionId;
      await fetch(`${base}/api/chat/sessions/${sessionId}/stop`, { method: 'POST', headers: auth });

      const body = await chatPromise;
      assert.match(body, /"type":"stopped"/);

      const full = await (await fetch(`${base}/api/chat/sessions/${sessionId}`, { headers: auth })).json();
      const assistant = full.messages.filter(m => m.role === 'assistant');
      assert.match(assistant[0].content, /stopped/);
      assert.ok(
        !assistant.some(m => m.content.includes('should not be delivered')),
        'an answer that arrived after Stop must not be presented as the result'
      );
    } finally {
      _resetProviderForTesting();
      _resetClientForTesting();
      clearAIConfig();
    }
  });
});

test('a second turn on a session that is already thinking is refused', async () => {
  await withServer(async (base) => {
    const auth = await loginAndGetAuthHeader(base);

    _setClientForTesting({
      listTools: async () => [{ name: 'get_system_metrics', risk: 'READ_ONLY', description: 'x', parameters: { type: 'object', properties: {} } }],
      callTool: async () => ({ cpu: 1 }),
      verifyTool: async () => ({ ok: true })
    });
    _setProviderForTesting({
      chat: async () => {
        await new Promise(r => setTimeout(r, 300));
        return { text: JSON.stringify({ action: 'answer', answer: 'done' }), toolCalls: [], usage: {} };
      }
    });
    setAIConfig({ provider: 'anthropic', model: 'test-model', apiKey: 'sk-test-key' });

    try {
      const first = fetch(`${base}/api/chat`, {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'first' })
      }).then(r => r.text());

      await new Promise(r => setTimeout(r, 100));
      const running = await (await fetch(`${base}/api/chat/running`, { headers: auth })).json();
      const sessionId = running.running[0].sessionId;

      const second = await fetch(`${base}/api/chat`, {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'second', sessionId })
      });
      assert.equal(second.status, 409, 'two tabs must not interleave answers into one conversation');

      await first;
    } finally {
      _resetProviderForTesting();
      _resetClientForTesting();
      clearAIConfig();
    }
  });
});

test('POST /api/chat/escalate opens a real incident and dedupes against an open one', async () => {
  await withServer(async (base) => {
    const auth = await loginAndGetAuthHeader(base);
    const externalId = 'chat-escalate-' + crypto.randomUUID();

    const res = await fetch(`${base}/api/chat/escalate`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ resourceType: 'service', externalId, summary: 'looks down' })
    });
    assert.equal(res.status, 200);
    const { incidentId, existing } = await res.json();
    assert.equal(existing, false);

    const incident = store.getIncident(incidentId);
    assert.equal(incident.trigger_rule, 'user_reported');
    assert.match(incident.trigger_summary, /looks down/);

    // Same resource again while the first is still open -> same incident,
    // matching the detector's own one-open-incident-per-resource rule.
    const again = await (await fetch(`${base}/api/chat/escalate`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ resourceType: 'service', externalId, summary: 'still down' })
    })).json();
    assert.equal(again.incidentId, incidentId);
    assert.equal(again.existing, true);
  });
});

test('POST /api/chat/escalate rejects a missing or unknown resourceType', async () => {
  await withServer(async (base) => {
    const auth = await loginAndGetAuthHeader(base);
    const headers = { ...auth, 'Content-Type': 'application/json' };

    const missing = await fetch(`${base}/api/chat/escalate`, {
      method: 'POST', headers, body: JSON.stringify({ externalId: 'x' })
    });
    assert.equal(missing.status, 400);

    const unknown = await fetch(`${base}/api/chat/escalate`, {
      method: 'POST', headers, body: JSON.stringify({ resourceType: 'kubernetes', externalId: 'x' })
    });
    assert.equal(unknown.status, 400);
  });
});

test('incident routes 404 for an unknown id', async () => {
  await withServer(async (base) => {
    const auth = await loginAndGetAuthHeader(base);
    const res = await fetch(`${base}/api/incidents/999999`, { headers: auth });
    assert.equal(res.status, 404);
  });
});

test('DELETE /api/incidents/:id removes one incident; DELETE /api/incidents?status=... clears only that state', async () => {
  await withServer(async (base) => {
    const auth = await loginAndGetAuthHeader(base);
    const mk = () => store.createIncident({
      resourceId: upsertResource({ type: 'container', externalId: 'del-http-' + crypto.randomUUID(), name: 'x' }).id,
      triggerRule: 'container_exit', triggerSummary: 'exited'
    });

    const one = mk();
    const delOne = await fetch(`${base}/api/incidents/${one.id}`, { method: 'DELETE', headers: auth });
    assert.equal(delOne.status, 200);
    assert.equal((await delOne.json()).deleted, 1);
    assert.equal(store.getIncident(one.id), null);

    const delMissing = await fetch(`${base}/api/incidents/999999`, { method: 'DELETE', headers: auth });
    assert.equal(delMissing.status, 404);

    const badStatus = await fetch(`${base}/api/incidents?status=NONSENSE`, { method: 'DELETE', headers: auth });
    assert.equal(badStatus.status, 400);

    const keep = mk();
    const drop = mk();
    store.updateIncidentStatus(drop.id, 'INVESTIGATING');
    store.updateIncidentStatus(drop.id, 'DISMISSED');
    const clearDismissed = await fetch(`${base}/api/incidents?status=DISMISSED`, { method: 'DELETE', headers: auth });
    assert.equal(clearDismissed.status, 200);
    assert.equal(store.getIncident(drop.id), null);
    assert.ok(store.getIncident(keep.id));
  });
});

// ── Deployments (Feature 1: deploy-aware incidents + rollback) ─────────────

test('POST /:repo/deploy writes a durable deployments row and a tool_executions row', async () => {
  const { getDb } = require('./db/connection');
  await withServer(async (base) => {
    const auth = await loginAndGetAuthHeader(base);
    const repoName = 'demo-app-' + crypto.randomUUID();

    _setClientForTesting({
      listTools: async () => [],
      callTool: async (name, params) => {
        assert.equal(name, 'deploy_repository');
        assert.equal(params.repo, repoName);
        return {
          repo: repoName, steps: [{ step: 'fetch', ok: true }, { step: 'pull', ok: true, output: 'ff' }],
          upToDate: false, message: 'Deployed successfully',
          fromSha: 'aaa1111', toSha: 'bbb2222', fromMessage: 'old commit', toMessage: 'new commit'
        };
      }
    });

    const res = await fetch(`${base}/api/deployments/${repoName}/deploy`, { method: 'POST', headers: auth });
    assert.equal(res.status, 200);
    await res.text(); // drain the SSE stream so the route's handler has fully run

    const row = getDb().prepare('SELECT * FROM deployments WHERE repo_name = ?').get(repoName);
    assert.ok(row, 'a deployments row must exist after a successful deploy');
    assert.equal(row.status, 'success');
    assert.equal(row.from_sha, 'aaa1111');
    assert.equal(row.to_sha, 'bbb2222');
    assert.equal(row.from_message, 'old commit');
    assert.equal(row.to_message, 'new commit');
    assert.equal(row.deployed_by, 'user');

    const execRow = getDb().prepare("SELECT * FROM tool_executions WHERE tool_name = 'deploy_repository' ORDER BY id DESC LIMIT 1").get();
    assert.ok(execRow, 'a human-triggered deploy must be audited, same as an AI-initiated one');
    assert.equal(execRow.status, 'ok');
    assert.equal(execRow.requested_by, 'user');

    _resetClientForTesting();
  });
});

test('an up-to-date deploy is recorded with status up_to_date, matching from/to sha', async () => {
  const { getDb } = require('./db/connection');
  await withServer(async (base) => {
    const auth = await loginAndGetAuthHeader(base);
    const repoName = 'uptodate-' + crypto.randomUUID();

    _setClientForTesting({
      listTools: async () => [],
      callTool: async () => ({
        repo: repoName, steps: [{ step: 'fetch', ok: true }], upToDate: true, message: 'Already up to date',
        fromSha: 'same0000', toSha: 'same0000', fromMessage: 'x', toMessage: 'x'
      })
    });

    await (await fetch(`${base}/api/deployments/${repoName}/deploy`, { method: 'POST', headers: auth })).text();

    const row = getDb().prepare('SELECT * FROM deployments WHERE repo_name = ?').get(repoName);
    assert.equal(row.status, 'up_to_date');
    assert.equal(row.from_sha, row.to_sha);

    _resetClientForTesting();
  });
});

test('a failed deploy is still recorded, with status failed and no sha (the tool threw before computing them)', async () => {
  const { getDb } = require('./db/connection');
  await withServer(async (base) => {
    const auth = await loginAndGetAuthHeader(base);
    const repoName = 'dirty-repo-' + crypto.randomUUID();

    _setClientForTesting({
      listTools: async () => [],
      callTool: async () => { throw new Error('Repository has uncommitted changes: 2 file(s).'); }
    });

    const res = await fetch(`${base}/api/deployments/${repoName}/deploy`, { method: 'POST', headers: auth });
    const body = await res.text();
    assert.match(body, /uncommitted changes/);

    const row = getDb().prepare('SELECT * FROM deployments WHERE repo_name = ?').get(repoName);
    assert.equal(row.status, 'failed');
    assert.equal(row.from_sha, null);

    const execRow = getDb().prepare("SELECT * FROM tool_executions WHERE tool_name = 'deploy_repository' AND status = 'error' ORDER BY id DESC LIMIT 1").get();
    assert.ok(execRow, 'a failed deploy is still audited');

    _resetClientForTesting();
  });
});

test('POST /:repo/rollback requires a sha and, on success, records a deployments row', async () => {
  const { getDb } = require('./db/connection');
  await withServer(async (base) => {
    const auth = await loginAndGetAuthHeader(base);
    const repoName = 'rollback-target-' + crypto.randomUUID();

    const missingSha = await fetch(`${base}/api/deployments/${repoName}/rollback`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({})
    });
    assert.equal(missingSha.status, 400);

    _setClientForTesting({
      listTools: async () => [],
      callTool: async (name, params) => {
        assert.equal(name, 'rollback_repository');
        assert.equal(params.sha, 'aaa1111');
        return {
          repo: repoName, steps: [{ step: 'reset', ok: true }], message: 'Rolled back to aaa1111',
          fromSha: 'bbb2222', toSha: 'aaa1111', fromMessage: 'bad deploy', toMessage: 'known good'
        };
      }
    });

    const res = await fetch(`${base}/api/deployments/${repoName}/rollback`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ sha: 'aaa1111' })
    });
    assert.equal(res.status, 200);
    await res.text();

    const row = getDb().prepare('SELECT * FROM deployments WHERE repo_name = ?').get(repoName);
    assert.ok(row);
    assert.equal(row.to_sha, 'aaa1111');
    assert.equal(row.from_sha, 'bbb2222');

    _resetClientForTesting();
  });
});
