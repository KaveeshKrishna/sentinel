'use strict';

const fs = require('fs');

const HOST_PROC = process.env.HOST_PROC || '/proc';

let prevStat = null;

/**
 * Parse /proc/stat cpu line into idle and total ticks.
 */
function readCpuStat() {
  const content = fs.readFileSync(`${HOST_PROC}/stat`, 'utf8');
  const line = content.split('\n')[0].trim().split(/\s+/);
  const [, user, nice, system, idle, iowait, irq, softirq, steal] = line.map(Number);
  const total = user + nice + system + idle + iowait + irq + softirq + steal;
  return { idle: idle + iowait, total };
}

/**
 * Calculate CPU usage % since last call. First call returns 0.
 */
function getCpuUsage() {
  const current = readCpuStat();
  if (!prevStat) {
    prevStat = current;
    return 0;
  }
  const diffTotal = current.total - prevStat.total;
  const diffIdle = current.idle - prevStat.idle;
  const usage = diffTotal > 0 ? (1 - diffIdle / diffTotal) * 100 : 0;
  prevStat = current;
  return Math.round(usage * 100) / 100;
}

// model/thread count are static for the life of the process; frequency is
// dynamic (scaling governor) but doesn't need per-second precision — both
// are cached with a short TTL instead of re-parsing /proc/cpuinfo every tick.
let cpuInfoCache = null;
let cpuInfoCacheAt = 0;
const CPU_INFO_TTL_MS = 2000;

/**
 * CPU model, thread count, and average current frequency.
 */
function getCpuInfo() {
  const now = Date.now();
  if (cpuInfoCache && now - cpuInfoCacheAt < CPU_INFO_TTL_MS) return cpuInfoCache;

  try {
    const content = fs.readFileSync(`${HOST_PROC}/cpuinfo`, 'utf8');
    const lines = content.split('\n');
    const model = lines.find(l => l.startsWith('model name'))?.split(':')[1]?.trim() || 'Unknown';
    const threads = (content.match(/^processor\s*:/gm) || []).length;
    const freqs = lines
      .filter(l => l.startsWith('cpu MHz'))
      .map(l => parseFloat(l.split(':')[1]));
    const avgFreq = freqs.length > 0 ? freqs.reduce((a, b) => a + b, 0) / freqs.length : 0;
    cpuInfoCache = { model, threads, frequency: Math.round(avgFreq) };
  } catch {
    cpuInfoCache = { model: 'Unknown', threads: 1, frequency: 0 };
  }
  cpuInfoCacheAt = now;
  return cpuInfoCache;
}

/**
 * Read 1m / 5m / 15m load averages from /proc/loadavg.
 */
function getLoadAvg() {
  try {
    const content = fs.readFileSync(`${HOST_PROC}/loadavg`, 'utf8');
    const [one, five, fifteen] = content.trim().split(/\s+/).map(Number);
    return { '1': one, '5': five, '15': fifteen };
  } catch {
    return { '1': 0, '5': 0, '15': 0 };
  }
}

module.exports = { getCpuUsage, getCpuInfo, getLoadAvg };
