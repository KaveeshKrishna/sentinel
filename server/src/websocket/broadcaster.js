'use strict';

const WebSocket = require('ws');
const { verifyToken } = require('../auth/middleware');
const { parseCookies } = require('../utils/cookies');
const { getAgentClient } = require('../agent/client');
const { setSink } = require('../events/publish');

let wss = null;
let ticker = null;
let lastMetrics = null;
let lastHistory = null;

/**
 * Initialize WebSocket server attached to the existing HTTP server.
 * Validates the JWT cookie during the HTTP→WS upgrade handshake.
 *
 * Metrics and their 60-sample history are collected and buffered inside
 * the agent (it's the process with /proc access); this loop just polls
 * the agent once a second and relays to connected browser clients — it
 * holds no host state of its own.
 */
// Cross-site WebSocket hijacking defense: a browser always sends Origin
// on a WS handshake, cross-site or not (unlike plain navigation). The
// auth cookie is SameSite=Strict already, but that alone depends on
// correct browser behavior; checking Origin against the Host the
// request actually arrived on (which reflects the proxy's forwarded
// value, same as the login route's X-Forwarded-Proto handling) is the
// standard second layer. Non-browser clients that omit Origin entirely
// are let through — they can't rely on an auto-attached cookie anyway.
function isAllowedOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function initBroadcaster(server) {
  wss = new WebSocket.Server({ noServer: true });

  // Let the rest of the server push events without depending on this
  // module (see events/publish.js for why the direction matters).
  setSink(broadcast);

  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/ws') {
      socket.destroy();
      return;
    }
    if (!isAllowedOrigin(request)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const cookies = parseCookies(request.headers.cookie || '');
    try {
      verifyToken(cookies.sentinel_token);
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', () => {});
    // Send current snapshot immediately so sparklines populate at once
    if (lastMetrics) {
      ws.send(JSON.stringify({ type: 'init', data: lastMetrics, history: lastHistory }));
    }
  });

  // Detects dead connections (client crashed, network dropped without a
  // clean close frame) that would otherwise sit in wss.clients forever —
  // ws's own docs recommend exactly this ping/pong pattern. A client that
  // doesn't pong before the next tick is presumed dead and terminated.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);
  heartbeat.unref();

  const agent = getAgentClient();

  ticker = setInterval(async () => {
    try {
      const alive = [...wss.clients].filter(c => c.readyState === WebSocket.OPEN);
      if (alive.length === 0) return; // skip if nobody listening

      const [metrics, historyResult] = await Promise.all([
        agent.callTool('get_system_metrics'),
        agent.callTool('get_metric_history')
      ]);

      lastMetrics = metrics;
      lastHistory = historyResult.history;

      const payload = JSON.stringify({ type: 'metrics', data: metrics, history: lastHistory });
      for (const ws of alive) {
        ws.send(payload);
      }
    } catch (err) {
      console.error('[broadcaster] error:', err.message);
    }
  }, 1000);

  return wss;
}

/**
 * Push an arbitrary event to all connected authenticated clients.
 */
function broadcast(type, data) {
  if (!wss) return;
  const payload = JSON.stringify({ type, data });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}

module.exports = { initBroadcaster, broadcast, isAllowedOrigin };
