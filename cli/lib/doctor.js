'use strict';

const fs = require('fs');
const os = require('os');
const http = require('http');
const { execFileSync } = require('child_process');
const paths = require('./paths');
const { isActive, isEnabled } = require('./systemd');

const MIN_NODE_MAJOR = 20;
const DISK_WARN_PERCENT_FREE = 10;

/** A single check result. status: 'ok' | 'warn' | 'fail' | 'skip' */
function check(name, status, detail) {
  return { name, status, detail };
}

function which(binary) {
  try {
    execFileSync('which', [binary], { stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

function requestOverSocket(socketPath, path, headers, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.request({ socketPath, path, method: 'GET', headers, timeout: timeoutMs }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: null }); });
    req.on('error', () => resolve({ status: 0, body: null }));
    req.end();
  });
}

async function runChecks() {
  const results = [];

  // ── OS / arch / Node ────────────────────────────────────────────────────
  try {
    const release = fs.readFileSync('/etc/os-release', 'utf8');
    const prettyName = release.match(/^PRETTY_NAME="?([^"\n]+)"?/m)?.[1] || 'unknown';
    results.push(check('Operating system', process.platform === 'linux' ? 'ok' : 'fail', prettyName));
  } catch {
    results.push(check('Operating system', 'warn', 'Could not read /etc/os-release'));
  }

  results.push(check('Architecture', ['x64', 'arm64'].includes(process.arch) ? 'ok' : 'warn', process.arch));

  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  results.push(check('Node.js version', nodeMajor >= MIN_NODE_MAJOR ? 'ok' : 'fail',
    `${process.version} (need >=${MIN_NODE_MAJOR})`));

  // ── systemd units ───────────────────────────────────────────────────────
  for (const unit of paths.UNITS) {
    const unitFile = `${paths.SYSTEMD_UNIT_DIR}/${unit}.service`;
    if (!fs.existsSync(unitFile)) {
      results.push(check(`Unit: ${unit}`, 'fail', 'not installed'));
      continue;
    }
    const active = isActive(unit);
    const enabled = isEnabled(unit);
    results.push(check(`Unit: ${unit}`, active === 'active' ? 'ok' : 'fail', `${active}, ${enabled}`));
  }

  // ── Agent socket ────────────────────────────────────────────────────────
  let socketOk = false;
  try {
    const stat = fs.statSync(paths.AGENT_SOCKET);
    if (!stat.isSocket()) {
      results.push(check('Agent socket', 'fail', `${paths.AGENT_SOCKET} exists but is not a socket`));
    } else {
      const mode = (stat.mode & 0o777).toString(8);
      results.push(check('Agent socket file', mode === '660' ? 'ok' : 'warn', `mode ${mode} (expected 660)`));
      socketOk = true;
    }
  } catch {
    results.push(check('Agent socket', 'fail', `${paths.AGENT_SOCKET} not found — is sentinel-agent running?`));
  }

  if (socketOk) {
    let token = process.env.SENTINEL_AGENT_TOKEN || null;
    if (!token) {
      try { token = fs.readFileSync(paths.AGENT_TOKEN, 'utf8').trim(); } catch { /* not readable by this user */ }
    }
    const health = await requestOverSocket(paths.AGENT_SOCKET, '/health', {});
    results.push(check('Agent reachability', health.status === 200 ? 'ok' : 'fail',
      health.status === 200 ? 'responded to /health' : 'no response (is the service running?)'));

    if (token) {
      const metrics = await requestOverSocket(paths.AGENT_SOCKET, '/tools', { Authorization: `Bearer ${token}` });
      results.push(check('Agent auth + tool catalog', metrics.status === 200 ? 'ok' : 'fail',
        metrics.status === 200 ? `${(JSON.parse(metrics.body || '[]')).length} tools registered` : `HTTP ${metrics.status}`));
    } else {
      results.push(check('Agent auth + tool catalog', 'skip', `cannot read ${paths.AGENT_TOKEN} as this user`));
    }
  }

  // ── Database ────────────────────────────────────────────────────────────
  try {
    fs.accessSync(paths.DB_PATH, fs.constants.R_OK | fs.constants.W_OK);
    const stat = fs.statSync(paths.DB_PATH);
    results.push(check('Database', 'ok', `${paths.DB_PATH} (${(stat.size / 1024).toFixed(0)} KB)`));
  } catch {
    results.push(check('Database', 'warn', `${paths.DB_PATH} not found or not accessible yet (created on first server start)`));
  }

  // ── Disk / memory ───────────────────────────────────────────────────────
  try {
    const stat = fs.statfsSync('/');
    const total = stat.blocks * stat.bsize;
    const avail = stat.bavail * stat.bsize;
    const percentFree = total > 0 ? (avail / total) * 100 : 0;
    results.push(check('Disk space (/)', percentFree < DISK_WARN_PERCENT_FREE ? 'warn' : 'ok',
      `${percentFree.toFixed(1)}% free (${(avail / 1e9).toFixed(1)} GB)`));
  } catch {
    results.push(check('Disk space (/)', 'skip', 'fs.statfsSync unavailable'));
  }

  const memFreePercent = (os.freemem() / os.totalmem()) * 100;
  results.push(check('Memory', memFreePercent < 10 ? 'warn' : 'ok',
    `${(os.totalmem() / 1e9).toFixed(1)} GB total, ${memFreePercent.toFixed(0)}% free`));

  // ── /proc, /sys readability ────────────────────────────────────────────
  try {
    fs.accessSync('/proc/stat', fs.constants.R_OK);
    results.push(check('/proc readable', 'ok'));
  } catch {
    results.push(check('/proc readable', 'fail', 'agent metrics collection will not work'));
  }
  try {
    fs.accessSync('/sys/class/thermal', fs.constants.R_OK);
    results.push(check('/sys/class/thermal readable', 'ok'));
  } catch {
    results.push(check('/sys/class/thermal readable', 'warn', 'no thermal zones — temperature will read as unavailable'));
  }

  // ── Detected capabilities ──────────────────────────────────────────────
  const capabilities = [
    ['Docker', 'docker', 'docker'],
    ['Caddy', 'caddy', 'caddy'],
    ['nginx', 'nginx', 'nginx'],
    ['cloudflared', 'cloudflared', 'cloudflared']
  ];
  for (const [label, binary, unit] of capabilities) {
    const present = which(binary);
    if (!present) {
      results.push(check(`Capability: ${label}`, 'skip', 'not detected'));
      continue;
    }
    const active = isActive(unit);
    results.push(check(`Capability: ${label}`, 'ok', active === 'active' ? 'active' : `installed, ${active}`));
  }
  results.push(check('Capability: GPU', which('nvidia-smi') ? 'ok' : 'skip',
    which('nvidia-smi') ? 'nvidia-smi detected' : 'not detected'));

  // ── AI provider ──────────────────────────────────────────────────────
  // Read-only count of enabled ai_credentials rows. Shells out to the
  // `sqlite3` CLI (like this file already shells out to `systemctl`,
  // `which`, etc.) rather than adding better-sqlite3 as a dependency of
  // this small CLI package just for one diagnostic line — no key is ever
  // decrypted here, only counted; doctor is a health check, not a
  // credential validator.
  if (!which('sqlite3')) {
    results.push(check('AI provider', 'skip', 'sqlite3 CLI not installed — cannot inspect ai_credentials'));
  } else if (!fs.existsSync(paths.DB_PATH)) {
    results.push(check('AI provider', 'skip', `${paths.DB_PATH} not found or not accessible yet`));
  } else {
    try {
      const out = execFileSync(
        'sqlite3', [paths.DB_PATH, 'SELECT COUNT(*) FROM ai_credentials WHERE enabled = 1;'],
        { encoding: 'utf8', timeout: 3000 }
      ).trim();
      const enabledCount = parseInt(out, 10) || 0;
      results.push(enabledCount > 0
        ? check('AI provider', 'ok', `${enabledCount} enabled credential${enabledCount === 1 ? '' : 's'} — diagnosis/chat/reports available`)
        : check('AI provider', 'warn', 'no AI provider configured — diagnosis, Ask Sentinel and reports are disabled'));
    } catch (err) {
      results.push(check('AI provider', 'skip', `could not query ai_credentials: ${err.message}`));
    }
  }

  return results;
}

module.exports = { runChecks };
