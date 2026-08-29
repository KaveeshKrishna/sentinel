'use strict';

const fs = require('fs');
const http = require('http');
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

// Tail-seek tuning. Caddy's default roll size is 100 MB, and this runs on
// every inspect_network call — reading the whole file from byte 0 each
// time (the original implementation) meant ~100 MB of I/O and JSON
// parsing to answer a question about the last few minutes.
const TAIL_CHUNK_BYTES = 256 * 1024;
const MAX_TAIL_BYTES = 16 * 1024 * 1024; // hard ceiling: a very busy host, or an unparseable file, can't blow memory

/** Unix-seconds `ts` from one Caddy JSON log line, in ms; null if unparseable. */
function parseLineTs(line) {
  try {
    const ts = JSON.parse(line).ts;
    return typeof ts === 'number' ? ts * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Read backwards from EOF until far enough back to cover `cutoffMs`.
 *
 * Caddy writes chronologically, so once a complete line at the front of
 * the accumulated buffer is older than the cutoff, everything before it
 * is older still and can be skipped entirely.
 */
async function readTailLines(filePath, cutoffMs) {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const { size } = await fh.stat();
    let pos = size;
    let buf = Buffer.alloc(0);

    while (pos > 0 && buf.length < MAX_TAIL_BYTES) {
      const chunkSize = Math.min(TAIL_CHUNK_BYTES, pos);
      pos -= chunkSize;
      const chunk = Buffer.alloc(chunkSize);
      await fh.read(chunk, 0, chunkSize, pos);
      buf = Buffer.concat([chunk, buf]);

      // The buffer's first line is partial unless we've reached byte 0,
      // so the first *complete* one starts just past the first newline.
      const nl = buf.indexOf(0x0a);
      if (pos > 0 && nl === -1) continue;
      const complete = buf.subarray(pos === 0 ? 0 : nl + 1).toString('utf8');
      const firstLine = complete.split('\n', 1)[0];
      const ts = parseLineTs(firstLine);
      if (ts !== null && ts < cutoffMs) break; // read back far enough
    }

    const lines = buf.toString('utf8').split('\n');
    if (pos > 0) lines.shift(); // drop the partial line we started mid-way through
    return lines;
  } finally {
    await fh.close();
  }
}

/**
 * Parse Caddy JSON access logs from the last `minutes` minutes, reading
 * only the tail of the file rather than all of it (see readTailLines).
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

    for (const line of await readTailLines(CADDY_LOG, cutoff)) {
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

/**
 * A site's health is the HTTP probe of its upstream, not whether a
 * Docker container sits on that port. Sentinel's own domain proxies to
 * a systemd service; any non-containerised upstream (a bare process, a
 * remote host) was previously badged "unknown" while serving 200s.
 * `upstream` records where the response came from; `status` is what the
 * UI badges.
 */
function deriveWebsiteStatus({ port, httpStatus, containerName }) {
  if (!port) return { status: 'unknown', upstream: 'unknown' };       // e.g. a static-file site, no reverse_proxy
  if (httpStatus === 0) return { status: 'stopped', upstream: 'down' }; // nothing listening
  const upstream = containerName ? 'container' : 'host';
  if (httpStatus >= 500) return { status: 'unhealthy', upstream };      // reachable but erroring
  return { status: 'running', upstream };
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
        const { status, upstream } = deriveWebsiteStatus({
          port: site.port, httpStatus: response.status, containerName
        });

        return {
          domain: site.domain,
          localPort: site.port,
          proxyTarget: site.proxyTarget,
          status,
          upstream,
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
module.exports._readTailLines = readTailLines;
module.exports._deriveWebsiteStatus = deriveWebsiteStatus;
