'use strict';

const fs = require('fs');

const HOST_PROC = process.env.HOST_PROC || '/proc';

/**
 * Parse /proc/meminfo and return human-useful fields in bytes.
 * Uses the "used = total - free - buffers - reclaimable cached" formula
 * to match what `free -h` reports as "used".
 */
function getMemoryInfo() {
  try {
    const content = fs.readFileSync(`${HOST_PROC}/meminfo`, 'utf8');
    const parsed = {};
    for (const line of content.split('\n')) {
      const match = line.match(/^(\w+):\s+(\d+)/);
      if (match) parsed[match[1]] = parseInt(match[2]) * 1024; // kB → bytes
    }

    const total = parsed.MemTotal || 0;
    const free = parsed.MemFree || 0;
    const buffers = parsed.Buffers || 0;
    const cached = (parsed.Cached || 0) + (parsed.SReclaimable || 0) - (parsed.Shmem || 0);
    const available = parsed.MemAvailable || free + cached + buffers;
    const used = Math.max(0, total - free - buffers - cached);

    const swapTotal = parsed.SwapTotal || 0;
    const swapFree = parsed.SwapFree || 0;
    const swapUsed = swapTotal - swapFree;

    return {
      total,
      used,
      free: available,
      cached: buffers + cached,
      available,
      usedPercent: total > 0 ? Math.round((used / total) * 10000) / 100 : 0,
      swapTotal,
      swapUsed,
      swapFree,
      swapPercent: swapTotal > 0 ? Math.round((swapUsed / swapTotal) * 10000) / 100 : 0
    };
  } catch {
    return { total: 0, used: 0, free: 0, cached: 0, available: 0, usedPercent: 0, swapTotal: 0, swapUsed: 0, swapFree: 0, swapPercent: 0 };
  }
}

module.exports = { getMemoryInfo };
