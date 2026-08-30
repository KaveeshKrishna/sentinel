'use strict';

const { getAgentClient } = require('../agent/client');
const { logEvent } = require('./logger');

const POLL_MS = 5000;

let lastSeenTs = Date.now();

/**
 * Poll the agent for container lifecycle events and log the ones worth
 * surfacing in the activity timeline. The agent (not server/) is the one
 * process watching the Docker event stream directly — see
 * agent/src/tools/docker.js's startEventWatch.
 */
async function pollOnce() {
  try {
    const events = await getAgentClient().callTool('get_docker_events', { since: lastSeenTs });
    for (const evt of events) {
      if (evt.type === 'die' && evt.exitCode !== '0') {
        logEvent('CONTAINER_CRASH', `Container ${evt.name} crashed (exit ${evt.exitCode})`);
      } else if (evt.type === 'oom') {
        logEvent('CONTAINER_CRASH', `Container ${evt.name} killed by OOM killer`);
      }
      lastSeenTs = Math.max(lastSeenTs, evt.ts);
    }
  } catch (err) {
    // Agent unreachable — don't spam the log every 5s, just note it once
    // per outage-ish window via the same interval; this is a poll, not a
    // persistent connection, so there's nothing to reconnect.
    console.error('[monitor] event poll error:', err.message);
  }
}

function startEventMonitoring() {
  setInterval(pollOnce, POLL_MS).unref?.();
}

module.exports = { startEventMonitoring };
