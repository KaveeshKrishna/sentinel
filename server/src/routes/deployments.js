'use strict';

const express = require('express');
const router = express.Router();
const { getAgentClient } = require('../agent/client');
const { callToolAudited } = require('../incidents/toolCallAudit');
const { logEvent } = require('../activity/logger');
const { getDb } = require('../db/connection');
const { listResources } = require('../graph/resources');

router.get('/', async (_req, res) => {
  try {
    const repos = await getAgentClient().callTool('inspect_git_status');
    res.json(repos);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * Best-effort match of a repo name to the resource it deploys — used only
 * to populate `deployments.resource_id`'s informational cache, NEVER for
 * the actual deploy-correlation query (that joins on `repo_name` against
 * `resources.metadata_json->composeProject`, since one deploy can affect
 * several compose services and a single FK can't represent that
 * honestly — see context/deployCorrelation.js). Returns null on anything
 * but exactly one match, rather than guessing.
 */
function findResourceIdForRepo(repoName) {
  const matches = listResources().filter(
    r => r.type === 'container' && (r.metadata?.composeProject || '').toLowerCase() === repoName.toLowerCase()
  );
  return matches.length === 1 ? matches[0].id : null;
}

/**
 * Record a durable deploy row. `activity_events`'s own DEPLOYMENT entries
 * are capped at 50 rows total across every event type and pruned on
 * every write — never a history — so this table is the only place a
 * deploy's actual sha/message/outcome survives past an hour on a busy
 * host, and it's what context/deployCorrelation.js reads to connect a
 * later incident back to the deploy that likely caused it.
 */
function recordDeployment({ repoName, status, result, error }) {
  getDb().prepare(`
    INSERT INTO deployments (repo_name, resource_id, from_sha, to_sha, from_message, to_message, deployed_at, deployed_by, status, steps_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'user', ?, ?)
  `).run(
    repoName, findResourceIdForRepo(repoName),
    result?.fromSha ?? null, result?.toSha ?? null,
    result?.fromMessage ?? null, result?.toMessage ?? null,
    Date.now(), status,
    JSON.stringify(result?.steps ?? (error ? [{ step: 'error', ok: false, detail: error }] : []))
  );
}

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
    // clicking "Deploy" in the UI, not by the AI/incident engine. Routed
    // through callToolAudited (rather than the agent client directly) so
    // a human-triggered deploy gets a tool_executions row too — the same
    // audit trail an AI-initiated call already gets, and what the
    // Sentinel Health panel's tool-latency stats read from.
    const result = await callToolAudited(null, 'deploy_repository', { repo: repoName }, { approved: true, requestedBy: 'user' });

    for (const s of result.steps) {
      send(s.step, s.output || `✅ ${s.step} complete`, 'log');
    }

    if (result.upToDate) {
      send('check', `✅ ${result.message}`, 'success');
      logEvent('DEPLOYMENT', `${repoName}: already up to date`);
      recordDeployment({ repoName, status: 'up_to_date', result });
    } else {
      send('success', `✅ ${result.message}`, 'success');
      logEvent('DEPLOYMENT', `${repoName}: deployed successfully`);
      recordDeployment({ repoName, status: 'success', result });
    }
  } catch (err) {
    send('error', `❌ Deployment failed: ${err.message}`, 'error');
    logEvent('DEPLOYMENT', `${repoName}: deployment failed — ${err.message}`);
    recordDeployment({ repoName, status: 'failed', error: err.message });
  }

  res.write(`event: done\ndata: {}\n\n`);
  res.end();
});

/**
 * Roll a repository back to a previously-deployed commit.
 *
 * A direct UI click, exactly like Deploy above — the authenticated
 * session IS the approval, no incident or AI recommendation involved.
 * When rollback instead comes from an AI-recommended action, it goes
 * through the completely normal incident_actions -> AWAITING_APPROVAL ->
 * human-approve path (incidents/engine.js), never this route.
 */
router.post('/:repo/rollback', async (req, res) => {
  const repoName = req.params.repo;
  const sha = req.body?.sha;

  if (!sha || typeof sha !== 'string') {
    return res.status(400).json({ error: 'sha is required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (step, data, type = 'log') =>
    res.write(`data: ${JSON.stringify({ step, type, data, ts: Date.now() })}\n\n`);

  send('start', `↩ Rolling back ${repoName} to ${sha.slice(0, 7)}…`, 'info');

  try {
    const result = await callToolAudited(null, 'rollback_repository', { repo: repoName, sha }, { approved: true, requestedBy: 'user' });

    for (const s of result.steps) {
      send(s.step, s.output || `✅ ${s.step} complete`, 'log');
    }

    send('success', `✅ ${result.message}`, 'success');
    logEvent('DEPLOYMENT', `${repoName}: rolled back to ${result.toSha?.slice(0, 7) || sha.slice(0, 7)}`);
    recordDeployment({ repoName, status: 'success', result });
  } catch (err) {
    send('error', `❌ Rollback failed: ${err.message}`, 'error');
    logEvent('DEPLOYMENT', `${repoName}: rollback failed — ${err.message}`);
    recordDeployment({ repoName, status: 'failed', error: err.message });
  }

  res.write(`event: done\ndata: {}\n\n`);
  res.end();
});

module.exports = router;
