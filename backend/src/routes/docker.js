'use strict';

const express = require('express');
const Dockerode = require('dockerode');
const router = express.Router();
const { logEvent } = require('../activity/logger');

const docker = new Dockerode({ socketPath: '/var/run/docker.sock' });

// ── Helpers ───────────────────────────────────────────────────────────────────

function getContainerStats(container) {
  return new Promise((resolve, reject) =>
    container.stats({ stream: false }, (err, stats) => err ? reject(err) : resolve(stats))
  );
}

/**
 * Parse Docker's multiplexed log format (8-byte framed stream).
 * Each frame: [type(1), 0(3), size(4-BE), data(size)]
 */
function parseMuxedLogs(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  const lines = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const streamType = buffer[offset];
    const size = buffer.readUInt32BE(offset + 4);
    if (size === 0) { offset += 8; continue; }
    if (offset + 8 + size > buffer.length) break;
    const text = buffer.slice(offset + 8, offset + 8 + size).toString('utf8').trimEnd();
    if (text) lines.push({ stream: streamType === 2 ? 'stderr' : 'stdout', text });
    offset += 8 + size;
  }
  return lines;
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.get('/containers', async (_req, res) => {
  try {
    const list = await docker.listContainers({ all: true });

    const result = await Promise.all(list.map(async (c) => {
      let cpuPercent = 0, memUsage = 0;

      if (c.State === 'running') {
        try {
          const stats = await getContainerStats(docker.getContainer(c.Id));
          const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
          const sysDelta  = stats.cpu_stats.system_cpu_usage    - stats.precpu_stats.system_cpu_usage;
          const numCpus   = stats.cpu_stats.online_cpus || 1;
          cpuPercent = sysDelta > 0 ? (cpuDelta / sysDelta) * numCpus * 100 : 0;
          memUsage   = Math.max(0, (stats.memory_stats.usage || 0) - (stats.memory_stats.stats?.cache || 0));
        } catch {}
      }

      const inspect = await docker.getContainer(c.Id).inspect().catch(() => ({}));

      const ports = (c.Ports || [])
        .filter(p => p.PublicPort)
        .map(p => `${p.PublicPort}→${p.PrivatePort}`)
        .join(', ') || (c.Ports || []).map(p => `${p.PrivatePort}`).join(', ');

      return {
        id:           c.Id,
        shortId:      c.Id.substring(0, 12),
        name:         (c.Names[0] || '').replace(/^\//, ''),
        image:        c.Image,
        status:       c.Status,
        state:        c.State,
        cpuPercent:   Math.round(cpuPercent * 100) / 100,
        memUsage:     Math.round(memUsage),
        restartCount: inspect.RestartCount || 0,
        ports,
        health:       inspect.State?.Health?.Status || 'N/A',
        composeProject: c.Labels?.['com.docker.compose.project'] || null,
        composeFile:    inspect.HostConfig?.Binds?.find(b => b.includes('compose')) ||
                        c.Labels?.['com.docker.compose.project.config_files'] || null,
        created:      c.Created
      };
    }));

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/containers/:id/logs', async (req, res) => {
  try {
    const container = docker.getContainer(req.params.id);
    const tail = Math.min(parseInt(req.query.tail) || 200, 500);
    const buffer = await container.logs({ stdout: true, stderr: true, tail, follow: false, timestamps: true });
    res.json(parseMuxedLogs(buffer));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/containers/:id/start', async (req, res) => {
  try {
    const ct = docker.getContainer(req.params.id);
    const info = await ct.inspect();
    await ct.start();
    logEvent('DOCKER_START', `Container ${info.Name.replace(/^\//, '')} started`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/containers/:id/stop', async (req, res) => {
  try {
    const ct = docker.getContainer(req.params.id);
    const info = await ct.inspect();
    await ct.stop();
    logEvent('DOCKER_STOP', `Container ${info.Name.replace(/^\//, '')} stopped`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/containers/:id/restart', async (req, res) => {
  try {
    const ct = docker.getContainer(req.params.id);
    const info = await ct.inspect();
    await ct.restart();
    logEvent('DOCKER_RESTART', `Container ${info.Name.replace(/^\//, '')} restarted`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
