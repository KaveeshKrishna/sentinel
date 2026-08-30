'use strict';

const fs = require('fs');

const HOST_PROC = process.env.HOST_PROC || '/proc';
const DISK_TARGET = process.env.DISK_TARGET || '/';

let prevDiskStats = {};

/**
 * Parse /proc/diskstats — only keep whole disks (not partitions).
 */
function readDiskStats() {
  const stats = {};
  try {
    const content = fs.readFileSync(`${HOST_PROC}/diskstats`, 'utf8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      const p = line.trim().split(/\s+/);
      const name = p[2];
      // Accept: sda, sdb, nvme0n1, vda, hda, xvda (whole disks only)
      if (!/^(sd[a-z]|nvme\d+n\d+|vd[a-z]|hd[a-z]|xvd[a-z])$/.test(name)) continue;
      stats[name] = {
        sectorsRead: parseInt(p[5]),
        sectorsWritten: parseInt(p[9])
      };
    }
  } catch {}
  return stats;
}

/**
 * Delta-based disk I/O speeds in bytes/second (called once per second).
 */
function getDiskIO() {
  const current = readDiskStats();
  const result = [];
  for (const [name, curr] of Object.entries(current)) {
    const prev = prevDiskStats[name];
    result.push({
      name,
      readSpeed: prev ? Math.max(0, (curr.sectorsRead - prev.sectorsRead) * 512) : 0,
      writeSpeed: prev ? Math.max(0, (curr.sectorsWritten - prev.sectorsWritten) * 512) : 0
    });
  }
  prevDiskStats = current;
  return result;
}

/**
 * Device name for a mountpoint, read from /proc/mounts (cached — mount
 * table changes rarely and this is display-only).
 */
let mountDeviceCache = null;
let mountDeviceCacheAt = 0;
const MOUNT_CACHE_TTL_MS = 60_000;

function findMountDevice(target) {
  const now = Date.now();
  if (mountDeviceCache && now - mountDeviceCacheAt < MOUNT_CACHE_TTL_MS) {
    return mountDeviceCache[target] || 'unknown';
  }
  const map = {};
  try {
    const content = fs.readFileSync(`${HOST_PROC}/mounts`, 'utf8');
    for (const line of content.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 2) continue;
      map[parts[1]] = parts[0];
    }
  } catch {}
  mountDeviceCache = map;
  mountDeviceCacheAt = now;
  return map[target] || 'unknown';
}

/**
 * Disk usage for the target filesystem (defaults to host root '/').
 * Runs natively on the host — no bind-mount indirection needed once
 * Sentinel is installed as a systemd service rather than a container.
 * Cached briefly since usage changes on a timescale of minutes, not
 * once-per-second broadcast ticks.
 */
let diskUsageCache = null;
let diskUsageCacheAt = 0;
const DISK_USAGE_TTL_MS = 30_000;

function getDiskUsage() {
  const now = Date.now();
  if (diskUsageCache && now - diskUsageCacheAt < DISK_USAGE_TTL_MS) return diskUsageCache;

  try {
    const stats = fs.statfsSync(DISK_TARGET);
    const total = stats.blocks * stats.bsize;
    const avail = stats.bavail * stats.bsize;
    const used = total - stats.bfree * stats.bsize;
    diskUsageCache = [{
      filesystem: findMountDevice(DISK_TARGET),
      mountpoint: DISK_TARGET,
      total,
      used,
      avail,
      usedPercent: total > 0 ? Math.round((used / total) * 100) : 0
    }];
  } catch {
    diskUsageCache = [];
  }
  diskUsageCacheAt = now;
  return diskUsageCache;
}

module.exports = { getDiskIO, getDiskUsage };
