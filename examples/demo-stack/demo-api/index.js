'use strict';

// Minimal demo app for rehearsing Sentinel's incident loop. Deliberately
// tiny: connects to demo-db on every /health check, so `docker stop
// demo-db` produces a real connection-timeout error in this app's own
// logs and a failing container HEALTHCHECK — exactly the evidence and
// detector signal the incident engine is meant to react to.

const express = require('express');
const { Client } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

const DB_CONFIG = {
  host: process.env.DEMO_DB_HOST || 'demo-db',
  port: parseInt(process.env.DEMO_DB_PORT, 10) || 5432,
  user: process.env.DEMO_DB_USER || 'demo',
  password: process.env.DEMO_DB_PASSWORD || 'demo',
  database: process.env.DEMO_DB_NAME || 'demo',
  connectionTimeoutMillis: 2000
};

async function checkDb() {
  const client = new Client(DB_CONFIG);
  try {
    await client.connect();
    await client.query('SELECT 1');
    return true;
  } catch (err) {
    console.error(`[demo-api] database check failed: ${err.message}`);
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

app.get('/health', async (_req, res) => {
  const dbOk = await checkDb();
  if (dbOk) return res.status(200).json({ status: 'ok' });
  res.status(503).json({ status: 'error', reason: 'database unreachable' });
});

app.get('/', (_req, res) => res.json({ service: 'demo-api' }));

app.listen(PORT, () => console.log(`[demo-api] listening on ${PORT}`));
