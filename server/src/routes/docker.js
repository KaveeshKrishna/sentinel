'use strict';

const express = require('express');
const router = express.Router();
const { getAgentClient } = require('../agent/client');
const { logEvent } = require('../activity/logger');
const { suppressForToolCall } = require('../incidents/suppression');

router.get('/containers', async (_req, res) => {
  try {
    const containers = await getAgentClient().callTool('list_containers');
    res.json(containers);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/containers/:id/logs', async (req, res) => {
  try {
    const tail = Math.min(parseInt(req.query.tail, 10) || 200, 500);
    const logs = await getAgentClient().callTool('get_container_logs', { id: req.params.id, tail });
    res.json(logs);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Start/stop/restart are triggered directly by an authenticated user
// clicking a button in the UI — the session's own auth is the approval,
// so these call the agent with approved: true. An AI-proposed action
// inside the incident engine (Phase 3) goes through a separate approval
// step before it can set that flag.
router.post('/containers/:id/start', async (req, res) => {
  try {
    // See incidents/suppression.js — a container the user just acted on
    // themselves shouldn't raise an incident for doing what they asked.
    suppressForToolCall('start_container', { id: req.params.id });
    const result = await getAgentClient().callTool('start_container', { id: req.params.id }, { approved: true });
    logEvent('DOCKER_START', `Container ${result.name} started`);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post('/containers/:id/stop', async (req, res) => {
  try {
    // See incidents/suppression.js — a container the user just acted on
    // themselves shouldn't raise an incident for doing what they asked.
    suppressForToolCall('stop_container', { id: req.params.id });
    const result = await getAgentClient().callTool('stop_container', { id: req.params.id }, { approved: true });
    logEvent('DOCKER_STOP', `Container ${result.name} stopped`);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post('/containers/:id/restart', async (req, res) => {
  try {
    // See incidents/suppression.js — a container the user just acted on
    // themselves shouldn't raise an incident for doing what they asked.
    suppressForToolCall('restart_container', { id: req.params.id });
    const result = await getAgentClient().callTool('restart_container', { id: req.params.id }, { approved: true });
    logEvent('DOCKER_RESTART', `Container ${result.name} restarted`);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
