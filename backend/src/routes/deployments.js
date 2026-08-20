'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const { execSync, spawn } = require('child_process');
const router = express.Router();
const { logEvent } = require('../activity/logger');

const APPS_PATH = process.env.APPS_PATH || '/srv/apps';

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeExec(cmd, cwd) {
  return execSync(cmd, { encoding: 'utf8', cwd, timeout: 15000 }).trim();
}

function findComposeFile(repoPath) {
  for (const name of ['compose.yml', 'docker-compose.yml', 'compose.yaml', 'docker-compose.yaml']) {
    if (fs.existsSync(path.join(repoPath, name))) return name;
  }
  return null;
}

function getRepoInfo(repoPath, name) {
  try {
    const branch = safeExec('git rev-parse --abbrev-ref HEAD', repoPath);
    const logRaw  = safeExec('git log -1 --format=%H|%an|%ai|%s', repoPath);
    const [hash, author, date, ...msgParts] = logRaw.split('|');
    const message = msgParts.join('|').trim();
    const statusOut = safeExec('git status --porcelain', repoPath);
    const isClean   = statusOut === '';
    let behind = 0, ahead = 0;
    try {
      behind = parseInt(safeExec('git rev-list HEAD..@{upstream} --count', repoPath)) || 0;
      ahead  = parseInt(safeExec('git rev-list @{upstream}..HEAD --count', repoPath)) || 0;
    } catch {}

    return {
      name,
      path: repoPath,
      branch,
      commit: {
        hash: hash?.slice(0, 7),
        fullHash: hash?.trim(),
        author: author?.trim(),
        date: date?.trim(),
        message: message?.slice(0, 120)
      },
      clean: isClean,
      uncommittedFiles: isClean ? 0 : statusOut.split('\n').filter(Boolean).length,
      ahead,
      behind,
      composeFile: findComposeFile(repoPath)
    };
  } catch (err) {
    return { name, path: repoPath, error: err.message };
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.get('/', (_req, res) => {
  const repos = [];
  try {
    const entries = fs.readdirSync(APPS_PATH, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const repoPath = path.join(APPS_PATH, entry.name);
      if (!fs.existsSync(path.join(repoPath, '.git'))) continue;
      repos.push(getRepoInfo(repoPath, entry.name));
    }
  } catch {}
  res.json(repos);
});

/**
 * Deploy a repository via SSE.
 * Sequence: git fetch → check dirty → git pull --ff-only → docker compose build → up -d
 */
router.post('/:repo/deploy', (req, res) => {
  const repoName = path.basename(req.params.repo); // prevent path traversal
  const repoPath = path.join(APPS_PATH, repoName);

  if (!fs.existsSync(path.join(repoPath, '.git'))) {
    return res.status(400).json({ error: 'Not a valid git repository' });
  }

  // Pre-flight: uncommitted changes check
  try {
    const dirty = safeExec('git status --porcelain', repoPath);
    if (dirty !== '') {
      return res.status(400).json({
        error: 'Repository has uncommitted changes. Commit or stash them before deploying.',
        changes: dirty.split('\n').filter(Boolean)
      });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  // Set up SSE stream
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (step, data, type = 'log') =>
    res.write(`data: ${JSON.stringify({ step, type, data, ts: Date.now() })}\n\n`);

  const done = () => {
    res.write(`event: done\ndata: {}\n\n`);
    res.end();
  };

  (async () => {
    try {
      // 1. Fetch
      send('fetch', '🔄 Fetching from remote…', 'info');
      safeExec('git fetch --prune', repoPath);

      // 2. Check if behind
      let behind = 0;
      try { behind = parseInt(safeExec('git rev-list HEAD..@{upstream} --count', repoPath)) || 0; } catch {}

      const branch = safeExec('git rev-parse --abbrev-ref HEAD', repoPath);

      if (behind === 0) {
        send('check', `✅ Already up to date on branch "${branch}"`, 'success');
        logEvent('DEPLOYMENT', `${repoName}: already up to date`);
        return done();
      }

      // 3. Pull (fast-forward only)
      send('pull', `⬇  Pulling ${behind} new commit(s) on "${branch}"…`, 'info');
      const pullOut = safeExec('git pull --ff-only', repoPath);
      send('pull', pullOut, 'log');

      // 4. Docker
      const composeFile = findComposeFile(repoPath);
      if (!composeFile) {
        send('done', '✅ Pulled. No compose file found — skipping Docker steps.', 'success');
        logEvent('DEPLOYMENT', `${repoName}: pulled (no Docker)`);
        return done();
      }

      send('build', `🔨 Building images (${composeFile})…`, 'info');
      await new Promise((resolve, reject) => {
        const proc = spawn('docker', ['compose', '-f', path.join(repoPath, composeFile), 'build'], { cwd: repoPath });
        proc.stdout.on('data', c => send('build', c.toString(), 'log'));
        proc.stderr.on('data', c => send('build', c.toString(), 'log'));
        proc.on('close', code => code === 0 ? resolve() : reject(new Error(`Build exited ${code}`)));
      });

      send('up', '🚀 Starting containers…', 'info');
      await new Promise((resolve, reject) => {
        const proc = spawn('docker', ['compose', '-f', path.join(repoPath, composeFile), 'up', '-d'], { cwd: repoPath });
        proc.stdout.on('data', c => send('up', c.toString(), 'log'));
        proc.stderr.on('data', c => send('up', c.toString(), 'log'));
        proc.on('close', code => code === 0 ? resolve() : reject(new Error(`Up exited ${code}`)));
      });

      logEvent('DEPLOYMENT', `${repoName}: deployed successfully`);
      send('success', `✅ ${repoName} deployed successfully!`, 'success');
    } catch (err) {
      send('error', `❌ Deployment failed: ${err.message}`, 'error');
    }
    done();
  })();
});

module.exports = router;
