'use strict';

process.env.SENTINEL_AGENT_TOKEN = 'integration-test-token';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./index');
const { ToolRegistry } = require('./registry');

function buildTestRegistry() {
  const registry = new ToolRegistry();
  registry.register({
    name: 'echo_read',
    description: 'read-only echo',
    risk: 'READ_ONLY',
    parameters: {
      type: 'object',
      properties: { msg: { type: 'string' } },
      required: ['msg'],
      additionalProperties: false
    },
    handler: async ({ msg }) => ({ echoed: msg })
  });
  registry.register({
    name: 'dangerous_action',
    description: 'a high-risk action',
    risk: 'HIGH_RISK',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => ({ didIt: true })
  });
  registry.register({
    name: 'checkable_action',
    description: 'a medium-risk action with a verify check',
    risk: 'MEDIUM_RISK',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => ({ didIt: true }),
    verify: async () => ({ ok: true, detail: 'confirmed' })
  });
  return registry;
}

async function withServer(fn) {
  const app = createApp(buildTestRegistry());
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const port = server.address().port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('GET /health requires no auth', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
  });
});

test('GET /tools requires the bearer token', async () => {
  await withServer(async (base) => {
    const unauthed = await fetch(`${base}/tools`);
    assert.equal(unauthed.status, 401);

    const authed = await fetch(`${base}/tools`, { headers: { Authorization: 'Bearer integration-test-token' } });
    assert.equal(authed.status, 200);
    const tools = await authed.json();
    assert.ok(tools.some(t => t.name === 'echo_read'));
  });
});

test('a READ_ONLY tool executes without an approval header', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/tools/echo_read`, {
      method: 'POST',
      headers: { Authorization: 'Bearer integration-test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg: 'hi' })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.result.echoed, 'hi');
  });
});

test('a HIGH_RISK tool is rejected without approval, even though a compromised or buggy caller might claim it should run', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/tools/dangerous_action`, {
      method: 'POST',
      headers: { Authorization: 'Bearer integration-test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(res.status, 403);
  });
});

test('a HIGH_RISK tool executes once the approval header is present', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/tools/dangerous_action`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer integration-test-token',
        'Content-Type': 'application/json',
        'X-Sentinel-Approved': 'true'
      },
      body: JSON.stringify({})
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.result.didIt, true);
  });
});

test('an unknown tool name is rejected with 404', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/tools/not_a_real_tool`, {
      method: 'POST',
      headers: { Authorization: 'Bearer integration-test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(res.status, 404);
  });
});

test('POST /tools/:name/verify runs the verify check when one is defined', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/tools/checkable_action/verify`, {
      method: 'POST',
      headers: { Authorization: 'Bearer integration-test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.result.ok, true);
    assert.equal(body.result.detail, 'confirmed');
  });
});

test('POST /tools/:name/verify 404s for a tool with no verify check', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/tools/dangerous_action/verify`, {
      method: 'POST',
      headers: { Authorization: 'Bearer integration-test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(res.status, 404);
  });
});

test('POST /tools/:name/verify requires no approval header, only auth', async () => {
  await withServer(async (base) => {
    const unauthed = await fetch(`${base}/tools/checkable_action/verify`, { method: 'POST' });
    assert.equal(unauthed.status, 401);
  });
});

test('invalid parameters are rejected by schema validation before the handler runs', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/tools/echo_read`, {
      method: 'POST',
      headers: { Authorization: 'Bearer integration-test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ notMsg: 'oops' })
    });
    assert.equal(res.status, 400);
  });
});
