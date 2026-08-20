'use strict';

const express = require('express');
const { execSync } = require('child_process');
const router = express.Router();
const { logEvent } = require('../activity/logger');

const ALLOWED_SERVICES = new Set(['docker', 'caddy', 'cloudflared', 'ssh', 'ufw']);
const ALLOWED_ACTIONS  = new Set(['start', 'stop', 'restart']);

/**
 * Run a systemctl command in the host's namespaces via nsenter.
 * Requires: pid: host  and  privileged: true  in compose.yml.
 */
function nsenter(action, service) {
  return execSync(
    `nsenter -t 1 -m -u -i -n -p -- systemctl ${action} ${service}`,
    { encoding: 'utf8', timeout: 8000 }
  ).trim();
}

function getServiceStatus(service) {
  try {
    return nsenter('is-active', service) || 'unknown';
  } catch (err) {
    // is-active exits non-zero for inactive; parse stdout
    return (err.stdout || '').trim() || 'inactive';
  }
}

router.get('/', (_req, res) => {
  const statuses = {};
  for (const svc of ALLOWED_SERVICES) {
    statuses[svc] = getServiceStatus(svc);
  }
  res.json(statuses);
});

router.post('/:service/:action', (req, res) => {
  const { service, action } = req.params;

  if (!ALLOWED_SERVICES.has(service)) {
    return res.status(400).json({ error: `Service "${service}" is not allowed` });
  }
  if (!ALLOWED_ACTIONS.has(action)) {
    return res.status(400).json({ error: `Action "${action}" is not allowed` });
  }

  try {
    nsenter(action, service);
    logEvent(`SERVICE_${action.toUpperCase()}`, `Service "${service}" ${action}ed`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
