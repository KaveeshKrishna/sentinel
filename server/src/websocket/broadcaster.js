'use strict';

const WebSocket = require('ws');
const { verifyToken } = require('../auth/middleware');
const { parseCookies } = require('../utils/cookies');
const { getAgentClient } = require('../agent/client');

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
function initBroadcaster(server) {
  wss = new WebSocket.Server({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/ws') {
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
    ws.on('error', () => {});
    // Send current snapshot immediately so sparklines populate at once
    if (lastMetrics) {
      ws.send(JSON.stringify({ type: 'init', data: lastMetrics, history: lastHistory }));
    }
  });

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

module.exports = { initBroadcaster, broadcast };
