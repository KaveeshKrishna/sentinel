'use strict';

const express      = require('express');
const cookieParser = require('cookie-parser');
const helmet       = require('helmet');
const morgan       = require('morgan');
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
const incidentsRoutes    = require('./routes/incidents');
const settingsRoutes     = require('./routes/settings');
const toolsRoutes        = require('./routes/tools');
const resourcesRoutes    = require('./routes/resources');
const chatRoutes         = require('./routes/chat');
const approveRoutes      = require('./routes/approve');
const healthRoutes       = require('./routes/health');

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
  // Skipped under NODE_ENV=test so `node --test` output stays readable —
  // app.test.js exercises most routes and would otherwise interleave a
  // request log line with every assertion.
  app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev', {
    skip: () => process.env.NODE_ENV === 'test'
  }));
  app.use(cookieParser());
  app.use(express.json({ limit: '1mb' }));
  app.disable('x-powered-by');

  // ── Public routes ─────────────────────────────────────────────────────────
  app.get('/health', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));
  app.use('/api/auth', authRoutes);
  app.use('/api/setup', setupRoutes.router);
  app.get('/setup', setupRoutes.setupPageHandler);
  // One-click approval from a notification. Public by necessity (it is
  // opened from a phone, outside any session) but authenticated by an
  // HMAC-signed, short-lived, single-action token — and GET only ever
  // renders a confirm page, so a link preview cannot approve anything.
  // See routes/approve.js and notify/approveLink.js.
  app.use('/a', approveRoutes);

  // ── Protected API routes ─────────────────────────────────────────────────
  app.use('/api/system',      authMiddleware, systemRoutes);
  app.use('/api/docker',      authMiddleware, dockerRoutes);
  app.use('/api/services',    authMiddleware, servicesRoutes);
  app.use('/api/deployments', authMiddleware, deploymentsRoutes);
  app.use('/api/recordings',  authMiddleware, recordingsRoutes);
  app.use('/api/websites',    authMiddleware, websitesRoutes);
  app.use('/api/network',     authMiddleware, networkRoutes);
  app.use('/api/activity',    authMiddleware, activityRoutes);
  app.use('/api/incidents',   authMiddleware, incidentsRoutes);
  app.use('/api/settings',    authMiddleware, settingsRoutes);
  app.use('/api/tools',       authMiddleware, toolsRoutes);
  app.use('/api/resources',   authMiddleware, resourcesRoutes);
  app.use('/api/chat',        authMiddleware, chatRoutes);
  app.use('/api/health',      authMiddleware, healthRoutes);

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

  // Final safety net. Every route above already catches its own errors
  // and returns a curated, safe message (e.g. "API key is invalid") —
  // those are deliberate and untouched by this. This only catches what
  // slips past that: a bug, or a library-level error (e.g. express.json()
  // rejecting a malformed body) that calls next(err) directly. Without
  // this, Express's own default handler would echo err.message (and, in
  // non-production, the stack trace) straight to the client.
  app.use((err, _req, res, next) => {
    if (res.headersSent) return next(err);
    console.error('[sentinel] unhandled error:', err);
    const status = err.status || err.statusCode;
    const isClientError = status >= 400 && status < 500;
    res.status(isClientError ? status : 500)
      .json({ error: isClientError ? 'Bad request' : 'Internal server error' });
  });

  return app;
}

module.exports = { createApp };
