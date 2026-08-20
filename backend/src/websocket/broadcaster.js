'use strict';

const WebSocket = require('ws');
const { verifyToken } = require('../auth/middleware');
const { parseCookies } = require('../utils/cookies');
const { collectAll } = require('../collectors');

const HISTORY_SIZE = 60;

// Per-metric history ring buffers (60 seconds of data)
const history = {
  cpu: [],
  memory: [],
  temperature: [],
  netUp: [],
  netDown: [],
  diskRead: [],
  diskWrite: [],
  load1: [],
  swap: []
};

function push(arr, val) {
  arr.push(val ?? 0);
  if (arr.length > HISTORY_SIZE) arr.shift();
}

let wss = null;
let ticker = null;
let lastMetrics = null;

/**
 * Initialize WebSocket server attached to the existing HTTP server.
 * Validates the JWT cookie during the HTTP→WS upgrade handshake.
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
    // Send current history snapshot immediately so sparklines populate at once
    if (lastMetrics) {
      ws.send(JSON.stringify({ type: 'init', data: lastMetrics, history }));
    }
  });

  // 1-second collection and broadcast loop
  ticker = setInterval(async () => {
    try {
      const alive = [...wss.clients].filter(c => c.readyState === WebSocket.OPEN);
      if (alive.length === 0) return; // skip if nobody listening

      const metrics = collectAll();

      // Update histories
      push(history.cpu, metrics.cpu.usage);
      push(history.memory, metrics.memory.usedPercent);
      push(history.temperature, metrics.temperature.current);
      push(history.netUp, metrics.network.txSpeed);
      push(history.netDown, metrics.network.rxSpeed);
      push(history.diskRead, metrics.disk.io.readSpeed);
      push(history.diskWrite, metrics.disk.io.writeSpeed);
      push(history.load1, metrics.cpu.load['1']);
      push(history.swap, metrics.memory.swapPercent);

      const payload = JSON.stringify({ type: 'metrics', data: metrics, history });
      lastMetrics = metrics;

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
