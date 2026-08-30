'use strict';

const http = require('http');

const { migrate } = require('./db/migrate');

// Migrations must run before anything else touches the database —
// activity logging, user lookups, and the setup-token bootstrap all
// assume their tables already exist.
migrate();

const { createApp } = require('./app');
const { initBroadcaster } = require('./websocket/broadcaster');
const { startEventMonitoring } = require('./activity/monitor');
const { startIncidentDetection } = require('./incidents/detector');
const { ensureSetupToken } = require('./setup/bootstrap');
const { logEvent } = require('./activity/logger');

const PORT = parseInt(process.env.PORT, 10) || 3000;

const app = createApp();
const server = http.createServer(app);

initBroadcaster(server);

// Polls the agent for Docker events; see activity/monitor.js.
startEventMonitoring();

// Evaluates detector rules (container exit/oom/unhealthy, service
// inactive, sustained resource thresholds) and drives the incident
// engine; see incidents/detector.js.
startIncidentDetection();

// Prints a one-time setup token + /setup URL if no admin exists yet.
ensureSetupToken(PORT);

server.listen(PORT, '0.0.0.0', () => {
  logEvent('SYSTEM_START', 'Sentinel server started');
  console.log(`[sentinel] Server listening on port ${PORT}`);
  console.log(`[sentinel] NODE_ENV = ${process.env.NODE_ENV || 'development'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
process.on('SIGINT',  () => { server.close(() => process.exit(0)); });
