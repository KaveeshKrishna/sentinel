'use strict';

const { collectAll, getCpuInfo, getLoadAvg } = require('../collectors');

const HISTORY_SIZE = 60;
const TICK_MS = 1000;

// Rolling 60-sample (1/sec) history, source of truth for both the live
// dashboard sparklines and the incident context engine's "what did metrics
// look like leading up to this" evidence.
const history = {
  cpu: [], memory: [], temperature: [], netUp: [], netDown: [],
  diskRead: [], diskWrite: [], load1: [], swap: []
};

let lastMetrics = null;
let tickTimer = null;

function push(arr, val) {
  arr.push(val ?? 0);
  if (arr.length > HISTORY_SIZE) arr.shift();
}

function tick() {
  try {
    const metrics = collectAll();
    push(history.cpu, metrics.cpu.usage);
    push(history.memory, metrics.memory.usedPercent);
    push(history.temperature, metrics.temperature.current);
    push(history.netUp, metrics.network.txSpeed);
    push(history.netDown, metrics.network.rxSpeed);
    push(history.diskRead, metrics.disk.io.readSpeed);
    push(history.diskWrite, metrics.disk.io.writeSpeed);
    push(history.load1, metrics.cpu.load['1']);
    push(history.swap, metrics.memory.swapPercent);
    lastMetrics = metrics;
  } catch (err) {
    console.error('[agent] metrics tick error:', err.message);
  }
}

/** Start the 1 Hz collection loop. Idempotent. */
function startMetricsLoop() {
  if (tickTimer) return;
  tick(); // populate immediately so the first request isn't empty
  tickTimer = setInterval(tick, TICK_MS);
  tickTimer.unref?.();
}

module.exports = function registerSystemTools(registry) {
  startMetricsLoop();

  registry.register({
    name: 'get_system_metrics',
    description: 'Get the latest CPU, memory, disk, network, and temperature snapshot for the host.',
    risk: 'READ_ONLY',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => lastMetrics || collectAll()
  });

  registry.register({
    name: 'get_metric_history',
    description: 'Get up to the last 60 seconds of rolling metric history (1 sample/second) for CPU, memory, temperature, network, disk I/O, load, and swap.',
    risk: 'READ_ONLY',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => ({ history, sampleIntervalMs: TICK_MS })
  });

  registry.register({
    name: 'run_health_check',
    description: 'Run a basic self-health check of the host agent (metrics collection freshness, CPU info, load).',
    risk: 'READ_ONLY',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => ({
      ok: lastMetrics !== null,
      lastCollectionAt: lastMetrics ? Date.now() : null,
      cpuInfo: getCpuInfo(),
      load: getLoadAvg()
    })
  });
};
