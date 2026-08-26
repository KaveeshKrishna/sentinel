'use strict';

const { getCpuUsage, getCpuInfo, getLoadAvg } = require('./cpu');
const { getMemoryInfo } = require('./memory');
const { getDiskIO, getDiskUsage } = require('./disk');
const { getNetworkStats, getPrimaryInterface } = require('./network');
const { getCpuTemperature } = require('./temperature');
const { getUptime } = require('./uptime');

/**
 * Collect all metrics in one pass. Called every second by the broadcaster.
 * Each individual collector is synchronous (file reads); we run them all
 * sequentially since Node's fs.readFileSync on /proc is very fast.
 */
function collectAll() {
  const cpu = getCpuUsage();
  const load = getLoadAvg();
  const memory = getMemoryInfo();
  const diskIO = getDiskIO();
  const diskUsage = getDiskUsage();
  const network = getNetworkStats();
  const primaryIface = getPrimaryInterface();
  const temperature = getCpuTemperature();
  const uptime = getUptime();

  // Aggregate network to primary interface (or first available)
  const netPrimary = (primaryIface && network[primaryIface]) || Object.values(network)[0] || {
    rxSpeed: 0, txSpeed: 0, rxTotal: 0, txTotal: 0
  };

  // Primary disk I/O (first disk found)
  const primaryDiskIO = diskIO[0] || { name: 'N/A', readSpeed: 0, writeSpeed: 0 };

  return {
    cpu: { usage: cpu, info: getCpuInfo(), load },
    memory,
    disk: {
      io: primaryDiskIO,
      allDisks: diskIO,
      usage: diskUsage[0] || null,
      allUsage: diskUsage
    },
    network: {
      ...netPrimary,
      interfaces: network,
      primary: primaryIface
    },
    temperature,
    uptime
  };
}

module.exports = { collectAll, getCpuInfo, getLoadAvg };
