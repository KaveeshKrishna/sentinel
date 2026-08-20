'use strict';

const fs = require('fs');
const { execSync } = require('child_process');

const HOST_PROC = process.env.HOST_PROC || '/proc';

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
 * Disk usage for host root filesystem.
 * Tries /host/root first (bind-mounted host /), falls back to container /.
 */
function getDiskUsage() {
  try {
    const target = fs.existsSync('/host/root') ? '/host/root' : '/';
    const output = execSync(`df -B1 ${target}`, { encoding: 'utf8', timeout: 5000 });
    const parts = output.trim().split('\n')[1].trim().split(/\s+/);
    const total = parseInt(parts[1]);
    const used = parseInt(parts[2]);
    const avail = parseInt(parts[3]);
    return [{
      filesystem: parts[0],
      mountpoint: '/',
      total,
      used,
      avail,
      usedPercent: total > 0 ? Math.round((used / total) * 100) : 0
    }];
  } catch {
    return [];
  }
}

module.exports = { getDiskIO, getDiskUsage };
