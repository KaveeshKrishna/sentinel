'use strict';

const express = require('express');
const router = express.Router();
const { getAgentClient } = require('../agent/client');

// Read-only catalog passthrough — lets a future UI show risk badges for
// what an incident is (or could be) recommending, without needing its own
// copy of the registry.
router.get('/', async (_req, res) => {
  try {
    res.json(await getAgentClient().listTools());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
