'use strict';

const express = require('express');
const router = express.Router();
const { getAgentClient } = require('../agent/client');

router.get('/', async (_req, res) => {
  try {
    const sites = await getAgentClient().callTool('get_website_health');
    res.json(sites);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
