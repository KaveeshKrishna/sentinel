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
