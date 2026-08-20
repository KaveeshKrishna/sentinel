'use strict';

const express = require('express');
const fs = require('fs');
const http = require('http');
const Dockerode = require('dockerode');
const router = express.Router();

const docker = new Dockerode({ socketPath: '/var/run/docker.sock' });
const CADDY_FILE = process.env.CADDY_FILE || '/host/caddy/Caddyfile';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parse a Caddyfile and return an array of {domain, port} site blocks.
 * Handles http:// and bare domain names. Ignores comments and global blocks.
 */
function parseCaddyfile(content) {
  // Strip comments
  const clean = content.replace(/#[^\n]*/g, '');
  const sites = [];
  // Match: [http://]domain.tld [{ ... reverse_proxy host:port ... }]
  const blockRx = /(?:https?:\/\/)?([a-zA-Z0-9][a-zA-Z0-9\-.*]+\.[a-zA-Z]{2,})\s*\{([^}]*)\}/g;
  let m;
  while ((m = blockRx.exec(clean)) !== null) {
    const domain = m[1].trim();
    const body   = m[2];
    const proxyM = body.match(/reverse_proxy\s+([^\s\n]+)/);
    if (!proxyM) continue;
    const target = proxyM[1].trim();
    const portM  = target.match(/:(\d+)$/);
    sites.push({ domain, proxyTarget: target, port: portM ? parseInt(portM[1]) : null });
  }
  return sites;
}

/**
 * Ping localhost:port and return response time in ms (or -1 on error).
 */
function ping(port) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = http.request({ host: '127.0.0.1', port, path: '/', timeout: 4000 }, (res) => {
      res.resume(); // consume to free socket
      resolve({ time: Date.now() - t0, status: res.statusCode });
    });
    req.on('error', () => resolve({ time: -1, status: 0 }));
    req.on('timeout', () => { req.destroy(); resolve({ time: -1, status: 0 }); });
    req.end();
  });
}

// ── Route ─────────────────────────────────────────────────────────────────────

router.get('/', async (_req, res) => {
  try {
    let caddyContent = '';
    try { caddyContent = fs.readFileSync(CADDY_FILE, 'utf8'); } catch {}

    const sites   = parseCaddyfile(caddyContent);
    const running = await docker.listContainers({ all: false }).catch(() => []);

    const results = await Promise.all(sites.map(async (site) => {
      // Match container by port mapping
      let dockerStatus = 'unknown';
      let containerName = null;
      if (site.port) {
        const match = running.find(c => c.Ports?.some(p =>
          p.PublicPort === site.port || p.PrivatePort === site.port
        ));
        if (match) {
          dockerStatus  = match.State;
          containerName = (match.Names[0] || '').replace(/^\//, '');
        }
      }

      const response = site.port ? await ping(site.port) : { time: -1, status: 0 };

      return {
        domain:        site.domain,
        localPort:     site.port,
        proxyTarget:   site.proxyTarget,
        dockerStatus,
        containerName,
        httpsStatus:   'via Cloudflare',
        responseTime:  response.time,
        httpStatus:    response.status
      };
    }));

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
