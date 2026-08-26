'use strict';

const express = require('express');
const router = express.Router();
const {
  getSessions, getSession, deleteSession,
  getSamples, getContainerSamples
} = require('../recording/db');
const { startRecording, stopRecording, getRecordingState } = require('../recording/engine');

// ── Analytics ─────────────────────────────────────────────────────────────────

function avg(arr, key) {
  const vals = arr.map(r => r[key]).filter(v => v != null && !isNaN(v));
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
}

function max(arr, key) {
  const vals = arr.map(r => r[key]).filter(v => v != null && !isNaN(v));
  return vals.length ? Math.max(...vals) : 0;
}

function computeAnalytics(samples, containerSamples) {
  if (!samples.length) return {};

  const avgCpu  = avg(samples, 'cpu_usage');
  const avgRam  = avg(samples, 'ram_percent');
  const avgTemp = avg(samples.filter(s => s.cpu_temp != null), 'cpu_temp');
  const avgLoad = avg(samples, 'load_1');
  const maxTemp = max(samples, 'cpu_temp');
  const maxRam  = max(samples, 'ram_percent');
  const maxLoad = max(samples, 'load_1');
  const maxSwap = max(samples, 'swap_used');

  const diskGrowth = samples.length > 1
    ? (samples[samples.length - 1].disk_used || 0) - (samples[0].disk_used || 0)
    : 0;

  // Health scoring
  let score = 100;
  const issues = [];
  const positives = [];

  if (avgCpu > 80)     { score -= 20; issues.push(`High avg CPU (${avgCpu.toFixed(1)}%)`); }
  else if (avgCpu > 60){ score -= 8;  issues.push(`Elevated avg CPU (${avgCpu.toFixed(1)}%)`); }
  else if (avgCpu < 40) positives.push(`CPU averaged ${avgCpu.toFixed(1)}% (healthy)`);

  if (maxTemp > 85)       { score -= 25; issues.push(`Critical temperature spike (${maxTemp.toFixed(1)}°C)`); }
  else if (maxTemp > 75)  { score -= 12; issues.push(`High temperature (${maxTemp.toFixed(1)}°C)`); }
  else if (maxTemp > 65)  { score -= 5;  issues.push(`Elevated temperature (${maxTemp.toFixed(1)}°C)`); }
  else if (maxTemp > 0)   positives.push(`Temperature stayed below 65°C`);

  if (avgRam > 85)      { score -= 15; issues.push(`Critical avg RAM (${avgRam.toFixed(1)}%)`); }
  else if (avgRam > 70) { score -= 8;  issues.push(`High avg RAM (${avgRam.toFixed(1)}%)`); }
  else if (avgRam < 50) positives.push(`RAM averaged ${avgRam.toFixed(1)}% (comfortable)`);

  if (maxLoad > 4)   { score -= 15; issues.push(`System overloaded (max load ${maxLoad.toFixed(2)})`); }
  else if (maxLoad > 2) { score -= 5; issues.push(`High system load (max ${maxLoad.toFixed(2)})`); }
  else positives.push(`System load stayed below 2.0`);

  const swapPercent = samples[0]?.swap_total > 0
    ? (maxSwap / samples[0].swap_total) * 100 : 0;
  if (swapPercent > 50)    { score -= 10; issues.push(`Heavy swap usage (${swapPercent.toFixed(1)}%)`); }
  else if (swapPercent < 5) positives.push(`Swap remained below 5%`);

  const label = score >= 90 ? 'Excellent' : score >= 75 ? 'Good' : score >= 60 ? 'Fair' : score >= 40 ? 'Poor' : 'Critical';

  // Container stats
  const ctMap = {};
  for (const cs of containerSamples) {
    if (!ctMap[cs.container_name]) ctMap[cs.container_name] = [];
    ctMap[cs.container_name].push(cs);
  }
  const containerStats = Object.entries(ctMap).map(([name, rows]) => ({
    name,
    avgCpu:    Math.round(avg(rows, 'cpu_percent') * 100) / 100,
    avgRam:    Math.round(avg(rows, 'ram_usage')),
    restarts:  max(rows, 'restart_count'),
    downtime:  rows.filter(r => r.health_status === 'unhealthy').length
  }));

  return {
    avgCpu:   Math.round(avgCpu  * 10) / 10,
    avgRam:   Math.round(avgRam  * 10) / 10,
    avgTemp:  Math.round(avgTemp * 10) / 10,
    avgLoad:  Math.round(avgLoad * 100) / 100,
    maxTemp:  Math.round(maxTemp * 10) / 10,
    maxRam:   Math.round(maxRam  * 10) / 10,
    maxLoad:  Math.round(maxLoad * 100) / 100,
    maxSwap,
    diskGrowth,
    healthScore: Math.max(0, Math.round(score)),
    healthLabel: label,
    issues,
    positives,
    containerStats
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.get('/state',   (_req, res) => res.json(getRecordingState()));

router.post('/start', (req, res) => {
  try {
    res.json(startRecording(req.body?.name));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/stop', (_req, res) => {
  try {
    res.json(stopRecording());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/', (_req, res) => {
  try { res.json(getSessions()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id', (req, res) => {
  try {
    const session = getSession(parseInt(req.params.id));
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const samples          = getSamples(session.id);
    const containerSamples = getContainerSamples(session.id);
    const analytics        = computeAnalytics(samples, containerSamples);
    res.json({ session, samples, containerSamples, analytics });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  try { deleteSession(parseInt(req.params.id)); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// CSV export
router.get('/:id/export/csv', (req, res) => {
  const session = getSession(parseInt(req.params.id));
  if (!session) return res.status(404).json({ error: 'Not found' });
  const samples = getSamples(session.id);
  const cols = ['timestamp','cpu_usage','load_1','load_5','load_15','cpu_temp',
    'ram_used','ram_total','ram_percent','swap_used','disk_used','disk_total',
    'disk_read_speed','disk_write_speed','net_up_speed','net_down_speed'];
  const csv = [cols.join(','), ...samples.map(s => cols.map(c => s[c] ?? '').join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="sentinel-session-${session.id}.csv"`);
  res.send(csv);
});

// JSON export
router.get('/:id/export/json', (req, res) => {
  const session = getSession(parseInt(req.params.id));
  if (!session) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Disposition', `attachment; filename="sentinel-session-${session.id}.json"`);
  res.json({ session, samples: getSamples(session.id), containerSamples: getContainerSamples(session.id) });
});

module.exports = router;
