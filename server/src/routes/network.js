'use strict';

const express = require('express');
const router = express.Router();
const { getAgentClient } = require('../agent/client');

router.get('/stats', async (_req, res) => {
  try {
    const { caddy, sshSessions, cloudflareTunnel } = await getAgentClient().callTool('inspect_network', { minutes: 5 });
    res.json({
      caddy,
      sshSessions,
      cloudflareTunnel,
      publicIp: process.env.PUBLIC_IP || null,
      lanIp: process.env.LAN_IP || null
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
