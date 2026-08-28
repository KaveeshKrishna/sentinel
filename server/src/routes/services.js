'use strict';

const express = require('express');
const router = express.Router();
const { getAgentClient } = require('../agent/client');
const { logEvent } = require('../activity/logger');
const { suppressForToolCall } = require('../incidents/suppression');

const ALLOWED_ACTIONS = new Set(['start', 'stop', 'restart']);
const ACTION_TOOL = { start: 'start_service', stop: 'stop_service', restart: 'restart_service' };

router.get('/', async (_req, res) => {
  try {
    const statuses = await getAgentClient().callTool('list_services');
    res.json(Object.fromEntries(statuses.map(s => [s.name, s.status])));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post('/:service/:action', async (req, res) => {
  const { service, action } = req.params;

  if (!ALLOWED_ACTIONS.has(action)) {
    return res.status(400).json({ error: `Action "${action}" is not allowed` });
  }

  try {
    // Suppress before the call, not after: stopping `docker` starts
    // killing containers immediately, and the detector polls every 5s.
    // A deliberate action of the user's own shouldn't page them for its
    // intended consequences (for `docker` that's every container on the
    // host — see incidents/suppression.js).
    suppressForToolCall(ACTION_TOOL[action], { service });

    // approved: true — this is a direct, authenticated user action from
    // the Services page, not an AI-initiated one. The agent independently
    // re-checks that `service` is in its own managed-services allowlist.
    await getAgentClient().callTool(ACTION_TOOL[action], { service }, { approved: true });
    logEvent(`SERVICE_${action.toUpperCase()}`, `Service "${service}" ${action}ed`);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
