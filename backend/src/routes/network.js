'use strict';

const express = require('express');
const fs = require('fs');
const os = require('os');
const readline = require('readline');
const router = express.Router();
const { getSshSessions, getNetworkStats, getPrimaryInterface } = require('../collectors/network');

const CADDY_LOG = process.env.CADDY_LOG || '/host/caddy/logs/access.log';

/**
 * Best-effort detection of the primary LAN IP when LAN_IP isn't configured.
 */
function detectLanIp() {
  const ifaces = os.networkInterfaces();
  for (const entries of Object.values(ifaces)) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return null;
}

/**
 * Parse Caddy JSON access logs from the last `minutes` minutes.
 * Returns requests/min, top domains, status codes, avg response time, error counts.
 */
async function getCaddyStats(minutes = 5) {
  const stats = {
    requestsPerMinute: 0,
    totalRequests: 0,
    domains: {},
    statusCodes: {},
    avgResponseTime: 0,
    errors4xx: 0,
    errors5xx: 0,
    available: false
  };

  try {
    if (!fs.existsSync(CADDY_LOG)) return stats;
    stats.available = true;

    const cutoff = Date.now() - minutes * 60 * 1000;
    const requests = [];

    const rl = readline.createInterface({
      input: fs.createReadStream(CADDY_LOG, { encoding: 'utf8' }),
      crlfDelay: Infinity
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        const ts = (entry.ts || 0) * 1000; // Caddy uses Unix seconds (float)
        if (ts < cutoff) continue;
        const host   = entry.request?.host || 'unknown';
        const status = entry.status  || 0;
        const dur    = (entry.duration || 0) * 1000; // seconds → ms
        requests.push({ ts, host, status, dur });
      } catch {}
    }

    if (requests.length > 0) {
      stats.totalRequests      = requests.length;
      stats.requestsPerMinute  = Math.round(requests.length / minutes);
      stats.avgResponseTime    = Math.round(requests.reduce((s, r) => s + r.dur, 0) / requests.length);

      for (const r of requests) {
        stats.domains[r.host]       = (stats.domains[r.host] || 0) + 1;
        stats.statusCodes[r.status] = (stats.statusCodes[r.status] || 0) + 1;
        if (r.status >= 400 && r.status < 500) stats.errors4xx++;
        if (r.status >= 500)                   stats.errors5xx++;
      }
    }
  } catch {}

  return stats;
}

/**
 * Check if the cloudflared tunnel is running by inspecting /host/proc.
 */
function getCloudflaredStatus() {
  try {
    const HOST_PROC = process.env.HOST_PROC || '/proc';
    const pids = fs.readdirSync(HOST_PROC).filter(d => /^\d+$/.test(d));
    for (const pid of pids) {
      try {
        const comm = fs.readFileSync(`${HOST_PROC}/${pid}/comm`, 'utf8').trim();
        if (comm === 'cloudflared') return 'running';
      } catch {}
    }
    return 'stopped';
  } catch {
    return 'unknown';
  }
}

router.get('/stats', async (_req, res) => {
  try {
    const [caddyStats, sshCount, cloudflareTunnel] = await Promise.all([
      getCaddyStats(5),
      Promise.resolve(getSshSessions()),
      Promise.resolve(getCloudflaredStatus())
    ]);

    res.json({
      caddy:             caddyStats,
      sshSessions:       sshCount,
      cloudflareTunnel,
      publicIp:          process.env.PUBLIC_IP  || null,
      lanIp:             process.env.LAN_IP      || detectLanIp()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
