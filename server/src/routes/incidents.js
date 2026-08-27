'use strict';

const express = require('express');
const router = express.Router();
const store = require('../incidents/store');
const engine = require('../incidents/engine');
const { STATES } = require('../incidents/states');
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
