'use strict';

const fs = require('fs');
const http = require('http');
const readline = require('readline');
const Dockerode = require('dockerode');
const { getSshSessions } = require('../collectors/network');

const HOST_PROC = process.env.HOST_PROC || '/proc';
const CADDY_FILE = process.env.CADDY_FILE || '/etc/caddy/Caddyfile';
const CADDY_LOG = process.env.CADDY_LOG || '/var/log/caddy/access.log';
const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';

function getCloudflaredStatus() {
  try {
    const pids = fs.readdirSync(HOST_PROC).filter(d => /^\d+$/.test(d));
    for (const pid of pids) {
      try {
        const comm = fs.readFileSync(`${HOST_PROC}/${pid}/comm`, 'utf8').trim();
        if (comm === 'cloudflared') return 'running';
      } catch { /* pid exited between readdir and read */ }
    }
    return 'stopped';
  } catch {
    return 'unknown';
  }
}

/**
 * Parse Caddy JSON access logs from the last `minutes` minutes.
 * Known limitation: reads the whole file from the start on every call —
 * fine for now, tracked for a tail-seek rewrite once log files get large
 * (see ARCHITECTURE.md known issues).
 */
async function getCaddyStats(minutes) {
  const stats = {
    requestsPerMinute: 0, totalRequests: 0, domains: {}, statusCodes: {},
    avgResponseTime: 0, errors4xx: 0, errors5xx: 0, available: false
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
        const host = entry.request?.host || 'unknown';
        const status = entry.status || 0;
        const dur = (entry.duration || 0) * 1000; // seconds -> ms
        requests.push({ ts, host, status, dur });
      } catch { /* malformed log line */ }
    }

    if (requests.length > 0) {
      stats.totalRequests = requests.length;
      stats.requestsPerMinute = Math.round(requests.length / minutes);
      stats.avgResponseTime = Math.round(requests.reduce((s, r) => s + r.dur, 0) / requests.length);
      for (const r of requests) {
        stats.domains[r.host] = (stats.domains[r.host] || 0) + 1;
        stats.statusCodes[r.status] = (stats.statusCodes[r.status] || 0) + 1;
        if (r.status >= 400 && r.status < 500) stats.errors4xx++;
        if (r.status >= 500) stats.errors5xx++;
      }
    }
  } catch { /* CADDY_LOG unreadable — Caddy not installed, or wrong path */ }
  return stats;
}

/**
 * Parse a Caddyfile and return an array of {domain, port} site blocks.
 * Walks brace depth to find each site block's real closing `}` instead of
 * matching up to the first `}` anywhere in the block — a site with a
 * nested directive (e.g. `log { output file X { roll_size ... } }`, the
 * standard shape for JSON access logging) would otherwise have its body
 * truncated mid-nesting, silently dropping its reverse_proxy line and
 * desyncing which text the next site's match starts from.
 */
function parseCaddyfile(content) {
  const clean = content.replace(/#[^\n]*/g, '');
  const sites = [];
  const openRx = /(?:https?:\/\/)?([a-zA-Z0-9][a-zA-Z0-9\-.*]+\.[a-zA-Z]{2,})\s*\{/g;
  let m;
  while ((m = openRx.exec(clean)) !== null) {
    const domain = m[1].trim();
    const bodyStart = openRx.lastIndex;
    let depth = 1;
    let i = bodyStart;
    while (i < clean.length && depth > 0) {
      if (clean[i] === '{') depth++;
      else if (clean[i] === '}') depth--;
      i++;
    }
    const body = clean.slice(bodyStart, i - 1);
    openRx.lastIndex = i; // resume scanning after this site's real closing brace

    const proxyM = body.match(/reverse_proxy\s+([^\s\n]+)/);
    if (!proxyM) continue;
    const target = proxyM[1].trim();
    const portM = target.match(/:(\d+)$/);
    sites.push({ domain, proxyTarget: target, port: portM ? parseInt(portM[1], 10) : null });
  }
  return sites;
}

function pingLocal(port) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = http.request({ host: '127.0.0.1', port, path: '/', timeout: 4000 }, (res) => {
      res.resume(); // consume to free the socket
      resolve({ time: Date.now() - t0, status: res.statusCode });
    });
    req.on('error', () => resolve({ time: -1, status: 0 }));
    req.on('timeout', () => { req.destroy(); resolve({ time: -1, status: 0 }); });
    req.end();
  });
}

module.exports = function registerNetworkTools(registry) {
  registry.register({
    name: 'inspect_network',
    description: 'Get network health signals: SSH session count, cloudflared tunnel status, and recent reverse-proxy (Caddy) request analytics.',
    risk: 'READ_ONLY',
    parameters: {
      type: 'object',
      properties: { minutes: { type: 'integer', minimum: 1, maximum: 60 } },
      additionalProperties: false
    },
    handler: async ({ minutes } = {}) => {
      const [caddy, sshSessions, cloudflareTunnel] = await Promise.all([
        getCaddyStats(minutes || 5),
        Promise.resolve(getSshSessions()),
        Promise.resolve(getCloudflaredStatus())
      ]);
      return { caddy, sshSessions, cloudflareTunnel };
    }
  });

  registry.register({
    name: 'get_website_health',
    description: "Discover websites from the reverse-proxy configuration and check each one's reachability, response time, and matching container.",
    risk: 'READ_ONLY',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      let caddyContent = '';
      try { caddyContent = fs.readFileSync(CADDY_FILE, 'utf8'); } catch { /* Caddy not installed */ }

      const sites = parseCaddyfile(caddyContent);
      const docker = new Dockerode({ socketPath: DOCKER_SOCKET });
      const running = await docker.listContainers({ all: false }).catch(() => []);

      return Promise.all(sites.map(async (site) => {
        let dockerStatus = 'unknown';
        let containerName = null;
        if (site.port) {
          const match = running.find(c => c.Ports?.some(p =>
            p.PublicPort === site.port || p.PrivatePort === site.port
          ));
          if (match) {
            dockerStatus = match.State;
            containerName = (match.Names[0] || '').replace(/^\//, '');
          }
        }
        const response = site.port ? await pingLocal(site.port) : { time: -1, status: 0 };
        return {
          domain: site.domain,
          localPort: site.port,
          proxyTarget: site.proxyTarget,
          dockerStatus,
          containerName,
          responseTime: response.time,
          httpStatus: response.status
        };
      }));
    }
  });
};

module.exports._parseCaddyfile = parseCaddyfile;
