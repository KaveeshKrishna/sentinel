'use strict';

const express      = require('express');
const http         = require('http');
const cookieParser = require('cookie-parser');
const helmet       = require('helmet');
const path         = require('path');
const fs           = require('fs');

const authRoutes        = require('./auth/routes');
const { authMiddleware } = require('./auth/middleware');
const systemRoutes      = require('./routes/system');
const dockerRoutes      = require('./routes/docker');
const servicesRoutes    = require('./routes/services');
const deploymentsRoutes = require('./routes/deployments');
const recordingsRoutes  = require('./routes/recordings');
const websitesRoutes    = require('./routes/websites');
const networkRoutes     = require('./routes/network');
const activityRoutes    = require('./routes/activity');
const { initBroadcaster } = require('./websocket/broadcaster');
const { initDb }         = require('./recording/db');
const { startEventMonitoring } = require('./activity/monitor');

const app  = express();
const PORT = parseInt(process.env.PORT) || 3000;

// ── Security & parsing middleware ─────────────────────────────────────────────
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

// ── Public routes ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));
app.use('/api/auth', authRoutes);

// ── Protected API routes ──────────────────────────────────────────────────────
app.use('/api/system',      authMiddleware, systemRoutes);
app.use('/api/docker',      authMiddleware, dockerRoutes);
app.use('/api/services',    authMiddleware, servicesRoutes);
app.use('/api/deployments', authMiddleware, deploymentsRoutes);
app.use('/api/recordings',  authMiddleware, recordingsRoutes);
app.use('/api/websites',    authMiddleware, websitesRoutes);
app.use('/api/network',     authMiddleware, networkRoutes);
app.use('/api/activity',    authMiddleware, activityRoutes);

// ── Frontend static files ─────────────────────────────────────────────────────
const frontendDist = path.join(__dirname, '../public');
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist, { index: false }));
  // SPA fallback — all non-API routes → index.html
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api') && !req.path.startsWith('/ws')) {
      res.sendFile(path.join(frontendDist, 'index.html'));
    } else {
      res.status(404).json({ error: 'Not found' });
    }
  });
} else {
  // Dev mode: frontend served by Vite on :5173
  app.get('/', (_req, res) => res.json({ status: 'backend ok', mode: 'development' }));
}

// ── HTTP server + WebSocket ───────────────────────────────────────────────────
const server = http.createServer(app);
initBroadcaster(server);

// ── SQLite init ───────────────────────────────────────────────────────────────
initDb();

// ── Docker event monitoring ───────────────────────────────────────────────────
startEventMonitoring();

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[sentinel] Server listening on port ${PORT}`);
  console.log(`[sentinel] NODE_ENV = ${process.env.NODE_ENV || 'development'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
process.on('SIGINT',  () => { server.close(() => process.exit(0)); });
