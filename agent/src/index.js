'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const { authMiddleware } = require('./auth');
const { ToolRegistry } = require('./registry');
const { isAuthorized } = require('./policy');
const registerAllTools = require('./tools');
const { ensureSafeDirectories } = require('./tools/git');

const SOCKET_PATH = process.env.SENTINEL_AGENT_SOCKET || '/run/sentinel/agent.sock';

/**
 * Build the agent's Express app around a given registry. Split out from
 * start() so tests can exercise routes without binding a real socket.
 */
function createApp(registry) {
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.disable('x-powered-by');

  // Unauthenticated so a supervisor/doctor can probe liveness without
  // holding the bearer token.
  app.get('/health', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));

  app.use(authMiddleware);

  app.get('/tools', (_req, res) => {
    res.json(registry.list());
  });

  app.post('/tools/:name', async (req, res) => {
    const { name } = req.params;
    const tool = registry.get(name);
    if (!tool) return res.status(404).json({ error: `Unknown tool "${name}"` });

    const { valid, errors } = registry.validateParams(name, req.body);
    if (!valid) return res.status(400).json({ error: 'Invalid parameters', details: errors });

    // Independent re-check: the server is expected to have already applied
    // its own approval policy, but the agent never trusts that — it makes
    // its own risk decision from the tool's own (fixed, code-defined) risk
    // classification, not whatever the caller claims about it.
    const approved = req.headers['x-sentinel-approved'] === 'true';
    if (!isAuthorized(tool.risk, approved)) {
      return res.status(403).json({ error: `Tool "${name}" (risk ${tool.risk}) requires approval` });
    }

    try {
      const result = await tool.handler(req.body || {});
      res.json({ ok: true, result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Runs a tool's post-action check (e.g. "is the container actually
  // Running now?"). Never mutates anything, so it needs no approval
  // gate — just the same bearer-token auth as everything else on this
  // socket. The server-side verification engine (Phase 3) polls this
  // with its own retry/timeout policy; this endpoint itself is a single
  // point-in-time check.
  app.post('/tools/:name/verify', async (req, res) => {
    const { name } = req.params;
    const tool = registry.get(name);
    if (!tool) return res.status(404).json({ error: `Unknown tool "${name}"` });
    if (!tool.verify) return res.status(404).json({ error: `Tool "${name}" has no verify check` });

    try {
      const result = await tool.verify(req.body || {});
      res.json({ ok: true, result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Never let a thrown error leak a stack trace to the caller.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error('[agent] unhandled error:', err);
    res.status(500).json({ error: 'Internal agent error' });
  });

  return app;
}

function buildRegistry() {
  const registry = new ToolRegistry();
  registerAllTools(registry);
  return registry;
}

function start() {
  // Runs before the registry ever handles a real git call — see the
  // function's own comment for why this is needed at all (root running
  // git against non-root-owned repos).
  try {
    ensureSafeDirectories();
  } catch (err) {
    console.error('[sentinel-agent] ensureSafeDirectories failed:', err.message);
  }

  const registry = buildRegistry();
  const app = createApp(registry);

  // Clean up a stale socket file from a previous unclean shutdown.
  try {
    if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);
  } catch { /* nothing to clean up */ }
  fs.mkdirSync(path.dirname(SOCKET_PATH), { recursive: true });

  const server = app.listen(SOCKET_PATH, () => {
    // 0660 root:sentinel — filesystem ACL is the first auth factor;
    // the bearer token (auth.js) is the second, independent one.
    fs.chmodSync(SOCKET_PATH, 0o660);
    console.log(`[sentinel-agent] listening on ${SOCKET_PATH}`);
  });

  process.on('SIGTERM', () => server.close(() => process.exit(0)));
  process.on('SIGINT', () => server.close(() => process.exit(0)));

  return server;
}

if (require.main === module) {
  start();
}

module.exports = { createApp, buildRegistry, start };
