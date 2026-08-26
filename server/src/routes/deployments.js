'use strict';

const express = require('express');
const router = express.Router();
const { getAgentClient } = require('../agent/client');
const { logEvent } = require('../activity/logger');

router.get('/', async (_req, res) => {
  try {
    const repos = await getAgentClient().callTool('inspect_git_status');
    res.json(repos);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * Deploy a repository. The agent's deploy_repository tool runs the whole
 * sequence (dirty-check -> fetch -> pull -> build -> up) as one call and
 * returns a step log at the end, rather than streaming it live — a known
 * simplification versus the previous SSE-per-line UX, tracked for Phase 4
 * (frontend rework). The SSE wire format is preserved here so the
 * existing frontend consumer keeps working; it just receives the step
 * log all at once instead of progressively.
 */
router.post('/:repo/deploy', async (req, res) => {
  const repoName = req.params.repo;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (step, data, type = 'log') =>
    res.write(`data: ${JSON.stringify({ step, type, data, ts: Date.now() })}\n\n`);

  send('start', `🔄 Deploying ${repoName}…`, 'info');

  try {
    // approved: true — triggered directly by an authenticated user
    // clicking "Deploy" in the UI, not by the AI/incident engine.
    const result = await getAgentClient().callTool('deploy_repository', { repo: repoName }, { approved: true });

    for (const s of result.steps) {
      send(s.step, s.output || `✅ ${s.step} complete`, 'log');
    }

    if (result.upToDate) {
      send('check', `✅ ${result.message}`, 'success');
      logEvent('DEPLOYMENT', `${repoName}: already up to date`);
    } else {
      send('success', `✅ ${result.message}`, 'success');
      logEvent('DEPLOYMENT', `${repoName}: deployed successfully`);
    }
  } catch (err) {
    send('error', `❌ Deployment failed: ${err.message}`, 'error');
    logEvent('DEPLOYMENT', `${repoName}: deployment failed — ${err.message}`);
  }

  res.write(`event: done\ndata: {}\n\n`);
  res.end();
});

module.exports = router;
