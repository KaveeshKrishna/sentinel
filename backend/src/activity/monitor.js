'use strict';

const Dockerode = require('dockerode');
const { logEvent } = require('./logger');

const docker = new Dockerode({ socketPath: '/var/run/docker.sock' });

/**
 * Subscribe to the Docker events stream and log container-level events.
 * Reconnects automatically on stream errors or end.
 */
function startEventMonitoring() {
  docker.getEvents({}, (err, stream) => {
    if (err) {
      console.error('[monitor] Docker events error:', err.message);
      setTimeout(startEventMonitoring, 15000);
      return;
    }

    stream.on('data', (chunk) => {
      try {
        const event = JSON.parse(chunk.toString());
        if (event.Type !== 'container') return;

        const name = event.Actor?.Attributes?.name || event.id?.substring(0, 12) || 'unknown';
        const action = event.Action;

        switch (action) {
          case 'die': {
            const exitCode = event.Actor?.Attributes?.exitCode || '?';
            if (exitCode !== '0') {
              logEvent('CONTAINER_CRASH', `Container ${name} crashed (exit ${exitCode})`);
            }
            break;
          }
          case 'oom':
            logEvent('CONTAINER_CRASH', `Container ${name} killed by OOM killer`);
            break;
          default:
            break;
        }
      } catch {}
    });

    stream.on('error', () => setTimeout(startEventMonitoring, 10000));
    stream.on('end',   () => setTimeout(startEventMonitoring, 5000));
  });
}

module.exports = { startEventMonitoring };
