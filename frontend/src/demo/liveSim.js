/**
 * The demo's live telemetry simulator.
 *
 * Produces a believable, gently fluctuating `get_system_metrics` snapshot
 * once a second and pushes it (plus the occasional activity event) to any
 * subscribed mock WebSocket. Emits the exact shape agent/src/collectors
 * produce so every section renders unchanged.
 */
import { CPU_MODEL, MEM_TOTAL_BYTES, DISK_TOTAL_BYTES, DISK2_TOTAL_BYTES } from './fixtures.js';
import { getState, mutate, nextId } from './state.js';

const HISTORY = 60;
const subscribers = new Set();
let timer = null;
let activityTimer = null;

const boot = Date.now();
let uptimeBase = 11 * 86400 + 4 * 3600; // ~11 days

// Random-walk anchors
let cpu = 12, ram = 41, temp = 49, load = 0.42;
let diskUsedPct = 37.1;
let rxTotal = 998_877_665_544, txTotal = 112_233_445_566;
let rxPackets = 8_123_456, txPackets = 7_004_311;
let spikeTicks = 0;

const history = {
  cpu: [], memory: [], temperature: [], netUp: [], netDown: [],
  diskRead: [], diskWrite: [], load1: [], swap: [],
};

function walk(v, drift, lo, hi) {
  return clamp(v + rand(-drift, drift), lo, hi);
}
function rand(a, b) { return a + Math.random() * (b - a); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function push(arr, v) { arr.push(v); if (arr.length > HISTORY) arr.shift(); }

function tick() {
  // Occasional CPU spike, decaying over a few seconds
  if (spikeTicks > 0) { spikeTicks--; cpu = walk(cpu, 6, 30, 78); }
  else {
    cpu = walk(cpu, 2.5, 5, 26);
    if (Math.random() < 0.012) spikeTicks = Math.round(rand(4, 12));
  }
  ram = walk(ram, 0.6, 33, 47);
  temp = walk(temp, 0.7, 43, 57) + (spikeTicks > 0 ? 3 : 0);
  temp = clamp(temp, 43, 68);
  load = walk(load, 0.08, 0.15, spikeTicks > 0 ? 2.4 : 1.2);
  diskUsedPct = clamp(diskUsedPct + rand(-0.002, 0.004), 30, 60);

  const netUp = Math.round(rand(8e3, spikeTicks > 0 ? 5e6 : 9e5));
  const netDn = Math.round(rand(2e4, spikeTicks > 0 ? 1.2e7 : 2e6));
  const dRead = Math.round(rand(0, spikeTicks > 0 ? 8e6 : 5e5));
  const dWrite = Math.round(rand(1e4, spikeTicks > 0 ? 1.1e7 : 9e5));
  rxTotal += netDn; txTotal += netUp;
  rxPackets += Math.round(netDn / 1400); txPackets += Math.round(netUp / 1400);

  push(history.cpu, round(cpu, 2));
  push(history.memory, round(ram, 2));
  push(history.temperature, round(temp, 1));
  push(history.netUp, netUp);
  push(history.netDown, netDn);
  push(history.diskRead, dRead);
  push(history.diskWrite, dWrite);
  push(history.load1, round(load, 2));
  push(history.swap, 0);

  const metrics = snapshot({ netUp, netDn, dRead, dWrite });
  broadcast({ type: 'metrics', data: metrics, history });
}

function snapshot(io) {
  const usedBytes = Math.round(MEM_TOTAL_BYTES * ram / 100);
  const diskUsed = Math.round(DISK_TOTAL_BYTES * diskUsedPct / 100);
  const disk2Used = Math.round(DISK2_TOTAL_BYTES * 0.18);
  const netIface = {
    rxSpeed: io.netDn, txSpeed: io.netUp, rxTotal, txTotal, rxPackets, txPackets,
  };
  return {
    cpu: {
      usage: round(cpu, 2),
      info: { ...CPU_MODEL },
      load: { 1: round(load, 2), 5: round(load * 0.85, 2), 15: round(load * 0.7, 2) },
    },
    memory: {
      total: MEM_TOTAL_BYTES, used: usedBytes,
      free: MEM_TOTAL_BYTES - usedBytes,
      cached: Math.round(MEM_TOTAL_BYTES * 0.22),
      available: MEM_TOTAL_BYTES - usedBytes,
      usedPercent: round(ram, 2),
      swapTotal: 2_147_479_552, swapUsed: 0, swapFree: 2_147_479_552, swapPercent: 0,
    },
    disk: {
      io: { name: 'vda', readSpeed: io.dRead, writeSpeed: io.dWrite },
      allDisks: [
        { name: 'vda', readSpeed: io.dRead, writeSpeed: io.dWrite },
        { name: 'vdb', readSpeed: Math.round(rand(0, 2e5)), writeSpeed: Math.round(rand(0, 3e5)) },
      ],
      usage: { filesystem: '/dev/vda1', mountpoint: '/', total: DISK_TOTAL_BYTES, used: diskUsed, avail: DISK_TOTAL_BYTES - diskUsed, usedPercent: Math.round(diskUsedPct) },
      allUsage: [
        { filesystem: '/dev/vda1', mountpoint: '/', total: DISK_TOTAL_BYTES, used: diskUsed, avail: DISK_TOTAL_BYTES - diskUsed, usedPercent: Math.round(diskUsedPct) },
        { filesystem: '/dev/vdb1', mountpoint: '/data', total: DISK2_TOTAL_BYTES, used: disk2Used, avail: DISK2_TOTAL_BYTES - disk2Used, usedPercent: 18 },
      ],
    },
    network: {
      ...netIface,
      interfaces: { eth0: netIface },
      primary: 'eth0',
    },
    temperature: { current: round(temp, 1), zone: 'thermal_zone0', type: 'x86_pkg_temp', allZones: [{ zone: 'thermal_zone0', type: 'x86_pkg_temp', temp: round(temp, 1) }] },
    uptime: uptimeBase + (Date.now() - boot) / 1000,
  };
}

// ─── benign background activity ──────────────────────────────────────────────
const AMBIENT = [
  ['CADDY_RELOAD', 'Caddy configuration reloaded'],
  ['DOCKER_RESTART', 'Container demo-worker restarted'],
  ['SSH_LOGIN', 'SSH login from 10.0.0.14 (kaveesh)'],
  ['SERVICE_RESTART', 'Service "cloudflared" restarted'],
  ['DEPLOYMENT', 'demo-web: deployed 3f1aa20 successfully'],
];
function ambientTick() {
  const [type, message] = AMBIENT[Math.floor(Math.random() * AMBIENT.length)];
  const event = { id: nextId('activity'), type, message, timestamp: Date.now(), details: null };
  mutate(s => { s.activity = [event, ...s.activity].slice(0, 50); });
  broadcast({ type: 'activity', data: withMeta(event) });
  scheduleAmbient();
}
function scheduleAmbient() {
  clearTimeout(activityTimer);
  activityTimer = setTimeout(ambientTick, rand(45_000, 120_000));
}

// EVENT_META mirror (server/src/activity/logger.js) so live pushes carry icon/color
const EVENT_META = {
  SSH_LOGIN: { icon: 'lock', color: '#3b82f6' }, LOGIN: { icon: 'key', color: '#3b82f6' }, LOGOUT: { icon: 'unlock', color: '#7d8590' },
  DEPLOYMENT: { icon: 'rocket', color: '#22c55e' },
  DOCKER_START: { icon: 'check', color: '#22c55e' }, DOCKER_STOP: { icon: 'square', color: '#f59e0b' }, DOCKER_RESTART: { icon: 'refresh-cw', color: '#3b82f6' },
  CONTAINER_CRASH: { icon: 'zap-off', color: '#ef4444' },
  SERVICE_START: { icon: 'check', color: '#22c55e' }, SERVICE_STOP: { icon: 'x', color: '#f59e0b' }, SERVICE_RESTART: { icon: 'refresh-cw', color: '#3b82f6' },
  RECORDING_START: { icon: 'circle', color: '#ef4444' }, RECORDING_STOP: { icon: 'square', color: '#7d8590' },
  SYSTEM_START: { icon: 'arrow-up', color: '#a855f7' }, CADDY_RELOAD: { icon: 'globe', color: '#06b6d4' }, SETUP_COMPLETED: { icon: 'shield', color: '#a855f7' },
  INCIDENT_DETECTED: { icon: 'alert-circle', color: '#ef4444' }, INCIDENT_DIAGNOSED: { icon: 'brain', color: '#a855f7' },
  INCIDENT_APPROVED: { icon: 'check-circle', color: '#22c55e' }, INCIDENT_DISMISSED: { icon: 'slash-circle', color: '#7d8590' },
  INCIDENT_ACTION_EXECUTED: { icon: 'settings', color: '#3b82f6' }, INCIDENT_RESOLVED: { icon: 'check', color: '#22c55e' }, INCIDENT_FAILED: { icon: 'x-circle', color: '#ef4444' },
  INCIDENT_AUTO_REMEDIATE: { icon: 'cpu', color: '#06b6d4' }, INCIDENT_REDIAGNOSE: { icon: 'refresh-cw', color: '#a855f7' },
};
export function withMeta(event) {
  return { ...event, ...(EVENT_META[event.type] || { icon: '•', color: '#7d8590' }) };
}

// ─── pub/sub ─────────────────────────────────────────────────────────────────
export function subscribe(fn) {
  subscribers.add(fn);
  start();
  // immediate snapshot so sparklines populate at once
  fn({ type: 'init', data: snapshot({ netUp: 0, netDn: 0, dRead: 0, dWrite: 0 }), history });
  return () => {
    subscribers.delete(fn);
    if (subscribers.size === 0) stop();
  };
}
export function broadcast(msg) {
  for (const fn of subscribers) { try { fn(msg); } catch { /* ignore */ } }
}
function start() {
  if (timer) return;
  // Prime the history so the first render isn't a flat line
  for (let i = 0; i < HISTORY; i++) tick();
  timer = setInterval(tick, 1000);
  scheduleAmbient();
}
function stop() {
  clearInterval(timer); timer = null;
  clearTimeout(activityTimer); activityTimer = null;
}

function round(v, dp) { const f = 10 ** dp; return Math.round(v * f) / f; }
