'use strict';

const express      = require('express');
const cookieParser = require('cookie-parser');
const helmet       = require('helmet');
const path         = require('path');
const fs           = require('fs');

const authRoutes         = require('./auth/routes');
const { authMiddleware } = require('./auth/middleware');
const setupRoutes        = require('./setup/routes');
const systemRoutes       = require('./routes/system');
const dockerRoutes       = require('./routes/docker');
const servicesRoutes     = require('./routes/services');
const deploymentsRoutes  = require('./routes/deployments');
const recordingsRoutes   = require('./routes/recordings');
const websitesRoutes     = require('./routes/websites');
const networkRoutes      = require('./routes/network');
const activityRoutes     = require('./routes/activity');

/**
 * Build the Express app. Split out from server.js (which additionally
 * wires up the HTTP server, WebSocket broadcaster, and Docker-event
 * poller) so routes can be exercised in tests without binding a real
 * port or requiring a live agent connection for routes a given test
 * doesn't touch.
 */
function createApp() {
  const app = express();

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        scriptSrc:  ["'self'", "'unsafe-inline'"],
        styleSrc:   ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc:    ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc:     ["'self'", 'data:'],
        workerSrc:  ["'self'", 'blob:']
      }
    }
  }));
  app.use(cookieParser());
  app.use(express.json({ limit: '1mb' }));
  app.disable('x-powered-by');

  // ── Public routes ─────────────────────────────────────────────────────────
  app.get('/health', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));
  app.use('/api/auth', authRoutes);
  app.use('/api/setup', setupRoutes.router);
  app.get('/setup', setupRoutes.setupPageHandler);

  // ── Protected API routes ─────────────────────────────────────────────────
  app.use('/api/system',      authMiddleware, systemRoutes);
  app.use('/api/docker',      authMiddleware, dockerRoutes);
  app.use('/api/services',    authMiddleware, servicesRoutes);
  app.use('/api/deployments', authMiddleware, deploymentsRoutes);
  app.use('/api/recordings',  authMiddleware, recordingsRoutes);
  app.use('/api/websites',    authMiddleware, websitesRoutes);
  app.use('/api/network',     authMiddleware, networkRoutes);
  app.use('/api/activity',    authMiddleware, activityRoutes);

  // ── Frontend static files ────────────────────────────────────────────────
  const frontendDist = path.join(__dirname, '../public');
  if (fs.existsSync(frontendDist)) {
    app.use(express.static(frontendDist, { index: false }));
    app.get('*', (req, res) => {
      if (!req.path.startsWith('/api') && !req.path.startsWith('/ws')) {
        res.sendFile(path.join(frontendDist, 'index.html'));
      } else {
        res.status(404).json({ error: 'Not found' });
      }
    });
  } else {
    app.get('/', (_req, res) => res.json({ status: 'backend ok', mode: 'development' }));
  }

  return app;
}

module.exports = { createApp };
