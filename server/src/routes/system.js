'use strict';

const express = require('express');
const router = express.Router();
const { getAgentClient } = require('../agent/client');

router.get('/snapshot', async (_req, res) => {
  try {
    const metrics = await getAgentClient().callTool('get_system_metrics');
    res.json(metrics);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/history', async (_req, res) => {
  try {
    const history = await getAgentClient().callTool('get_metric_history');
    res.json(history);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
