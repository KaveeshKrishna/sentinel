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
