'use strict';

const fs = require('fs');

const HOST_PROC = process.env.HOST_PROC || '/proc';

let prevStats = {};

/**
 * Read /proc/net/dev and return per-interface byte/packet counters.
 * Skips loopback (lo) and virtual docker bridges.
 */
function readNetDev() {
  const stats = {};
  try {
    const content = fs.readFileSync(`${HOST_PROC}/net/dev`, 'utf8');
    const lines = content.split('\n').slice(2); // skip 2 header lines
    for (const line of lines) {
      if (!line.trim()) continue;
      const colonIdx = line.indexOf(':');
      if (colonIdx < 0) continue;
      const iface = line.slice(0, colonIdx).trim();
      // Skip loopback and docker virtual interfaces
      if (iface === 'lo' || iface.startsWith('docker') || iface.startsWith('br-') || iface.startsWith('veth')) continue;
      const parts = line.slice(colonIdx + 1).trim().split(/\s+/);
      stats[iface] = {
        rxBytes: parseInt(parts[0]),
        rxPackets: parseInt(parts[1]),
        txBytes: parseInt(parts[8]),
        txPackets: parseInt(parts[9])
      };
    }
  } catch {}
  return stats;
}

/**
 * Calculate per-second speeds for each interface.
 * Returns speeds in bytes/sec and running totals.
 */
function getNetworkStats() {
  const current = readNetDev();
  const result = {};
  for (const [iface, curr] of Object.entries(current)) {
    const prev = prevStats[iface];
    result[iface] = {
      rxSpeed: prev ? Math.max(0, curr.rxBytes - prev.rxBytes) : 0,
      txSpeed: prev ? Math.max(0, curr.txBytes - prev.txBytes) : 0,
      rxTotal: curr.rxBytes,
      txTotal: curr.txBytes,
      rxPackets: curr.rxPackets,
      txPackets: curr.txPackets
    };
  }
  prevStats = current;
  return result;
}

/**
 * Find the default route interface (the one with 00000000 destination in /proc/net/route).
 */
function getPrimaryInterface() {
  try {
    const content = fs.readFileSync(`${HOST_PROC}/net/route`, 'utf8');
    for (const line of content.split('\n').slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts[1] === '00000000') return parts[0]; // default route
    }
  } catch {}
  return null;
}

/**
 * Count ESTABLISHED connections to `port` in one /proc/net/tcp{,6} table.
 */
function countEstablished(path, port) {
  try {
    const content = fs.readFileSync(path, 'utf8');
    let count = 0;
    for (const line of content.split('\n').slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) continue;
      const localPort = parseInt(parts[1].split(':').pop(), 16);
      const state = parts[3];
      if (localPort === port && state === '01') count++; // 01 = ESTABLISHED
    }
    return count;
  } catch {
    return 0;
  }
}

/**
 * Count established SSH connections (port 22) across both IPv4 and IPv6
 * connection tables — a v6-only SSH session was previously invisible here.
 */
function getSshSessions() {
  return countEstablished(`${HOST_PROC}/net/tcp`, 22) + countEstablished(`${HOST_PROC}/net/tcp6`, 22);
}

module.exports = { getNetworkStats, getPrimaryInterface, getSshSessions };
