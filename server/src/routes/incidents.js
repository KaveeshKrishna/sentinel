'use strict';

const express = require('express');
const router = express.Router();
const store = require('../incidents/store');
const engine = require('../incidents/engine');
const { STATES } = require('../incidents/states');
const { getTimeline } = require('../incidents/timeline');
const { generateReport, getReport, renderReportMarkdown } = require('../ai/report');
const { getResource } = require('../graph/resources');

// Resource id -> {type, name} is cheap (resources are few, unindexed reads
// off the small `resources` table) and saves the UI a second round trip
// per incident just to render something more useful than a raw id.
function withResource(incident) {
  const resource = getResource(incident.resource_id);
  return { ...incident, resourceName: resource?.name ?? null, resourceType: resource?.type ?? null };
}

router.get('/', (req, res) => {
  res.json(store.listIncidents({ status: req.query.status }).map(withResource));
});

router.get('/:id', (req, res) => {
  const incident = store.getIncident(Number(req.params.id));
  if (!incident) return res.status(404).json({ error: 'Incident not found' });
  res.json({
    ...withResource(incident),
    evidence: store.getEvidence(incident.id),
    actions: store.getActions(incident.id)
  });
});

router.post('/:id/approve', async (req, res) => {
  const incidentId = Number(req.params.id);
  const incident = store.getIncident(incidentId);
  if (!incident) return res.status(404).json({ error: 'Incident not found' });

  const { actionId } = req.body || {};
  if (!actionId) return res.status(400).json({ error: 'actionId is required' });

  try {
    const updated = await engine.approve(incidentId, { actionId, userId: req.user?.sub ?? null });
    res.json(updated);
  } catch (err) {
    if (err.name === 'IllegalTransitionError') return res.status(409).json({ error: err.message });
    res.status(502).json({ error: err.message });
  }
});

// Everything recorded about one incident, merged into a single ordered
// list plus a per-stage rollup for the OBSERVE -> DIAGNOSE -> PLAN ->
// ACT -> VERIFY strip. Read-only over tables that were previously
// write-only from the API's perspective.
router.get('/:id/timeline', (req, res) => {
  const incident = store.getIncident(Number(req.params.id));
  if (!incident) return res.status(404).json({ error: 'Incident not found' });
  res.json(getTimeline(incident.id, incident));
});

// The AI-written post-incident report. Generated automatically when an
// incident closes; this pair lets the UI read it and regenerate it (for
// an incident that closed before a provider was configured, or one whose
// generation failed).
router.get('/:id/report', (req, res) => {
  const incident = store.getIncident(Number(req.params.id));
  if (!incident) return res.status(404).json({ error: 'Incident not found' });

  const stored = getReport(incident.id);
  if (!stored) return res.json({ report: null, markdown: null, generatedAt: null });
  res.json({ ...stored, markdown: renderReportMarkdown(stored.report, incident) });
});

router.post('/:id/report', async (req, res) => {
  const incident = store.getIncident(Number(req.params.id));
  if (!incident) return res.status(404).json({ error: 'Incident not found' });

  const result = await generateReport(incident.id);
  if (!result.ok) return res.status(502).json({ error: result.error });

  const stored = getReport(incident.id);
  res.json({ ...stored, markdown: renderReportMarkdown(stored.report, incident) });
});

// Bulk delete — filter-aware "Clear" button in the UI. `?status=FAILED`
// clears only that state; no query string clears every incident. Must be
// declared before '/:id' so the bare path isn't captured as an id.
router.delete('/', (req, res) => {
  const status = req.query.status;
  if (status !== undefined && !STATES.includes(status)) {
    return res.status(400).json({ error: `Unknown status "${status}"` });
  }
  const deleted = store.deleteIncidents({ status: status || undefined });
  res.json({ deleted });
});

router.delete('/:id', (req, res) => {
  const deleted = store.deleteIncident(Number(req.params.id));
  if (!deleted) return res.status(404).json({ error: 'Incident not found' });
  res.json({ deleted });
});

// Diagnose on demand.
//
// Incidents are no longer diagnosed automatically unless their resource
// is opted into auto-remediation (see incidents/detector.js's
// shouldAutoDiagnose) — detection is free, a provider call is not, and a
// free tier's daily allowance is easily spent by routine container churn
// nobody was watching. This is the button that spends one deliberately.
router.post('/:id/diagnose', async (req, res) => {
  const incidentId = Number(req.params.id);
  const incident = store.getIncident(incidentId);
  if (!incident) return res.status(404).json({ error: 'Incident not found' });

  try {
    // An incident that never left DETECTED has gathered no evidence yet,
    // so it needs the full investigate-then-diagnose pass; one that has
    // been round this loop before only needs re-diagnosing against what
    // is already known.
    res.json(incident.status === 'DETECTED'
      ? await engine.startInvestigation(incidentId)
      : await engine.rediagnose(incidentId));
  } catch (err) {
    if (err.name === 'IllegalTransitionError') return res.status(409).json({ error: err.message });
    res.status(502).json({ error: err.message });
  }
});

// "Ask AI instead" — for when a runbook-matched diagnosis isn't trusted
// this time. Deliberately NOT the same as /diagnose's non-DETECTED branch
// (rediagnose, which reuses whatever evidence already exists): a
// runbook-only incident has ZERO evidence rows, since evidence-gathering
// is exactly what a runbook match skips (incidents/runbooks.js). This
// route runs the full gather-then-diagnose pass instead.
router.post('/:id/ai-diagnose', async (req, res) => {
  const incidentId = Number(req.params.id);
  if (!store.getIncident(incidentId)) return res.status(404).json({ error: 'Incident not found' });
  try {
    res.json(await engine.forceAiDiagnosis(incidentId));
  } catch (err) {
    if (err.name === 'IllegalTransitionError') return res.status(409).json({ error: err.message });
    res.status(502).json({ error: err.message });
  }
});

// Re-run diagnosis against all evidence gathered so far — including the
// output of any approved READ_ONLY investigation action. This is how a
// "I can't tell from this, show me the logs" diagnosis gets turned into
// an actionable one without waiting for the detector's stuck-retry.
router.post('/:id/rediagnose', async (req, res) => {
  const incidentId = Number(req.params.id);
  if (!store.getIncident(incidentId)) return res.status(404).json({ error: 'Incident not found' });
  try {
    res.json(await engine.rediagnose(incidentId));
  } catch (err) {
    if (err.name === 'IllegalTransitionError') return res.status(409).json({ error: err.message });
    res.status(502).json({ error: err.message });
  }
});

router.post('/:id/dismiss', (req, res) => {
  const incidentId = Number(req.params.id);
  if (!store.getIncident(incidentId)) return res.status(404).json({ error: 'Incident not found' });
  try {
    res.json(engine.dismiss(incidentId));
  } catch (err) {
    if (err.name === 'IllegalTransitionError') return res.status(409).json({ error: err.message });
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
