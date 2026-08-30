'use strict';

const express = require('express');
const router = express.Router();
const { listResources } = require('../graph/resources');
const { registerRelationship } = require('../graph/relationships');

router.get('/', (_req, res) => {
  res.json(listResources());
});

router.post('/relationships', (req, res) => {
  const { fromType, fromExternalId, fromName, toType, toExternalId, toName, relationship } = req.body || {};
  if (!fromType || !fromExternalId || !toType || !toExternalId || !relationship) {
    return res.status(400).json({ error: 'fromType, fromExternalId, toType, toExternalId, and relationship are required' });
  }
  const result = registerRelationship(
    { type: fromType, externalId: fromExternalId, name: fromName || fromExternalId },
    { type: toType, externalId: toExternalId, name: toName || toExternalId },
    relationship
  );
  res.json(result);
});

module.exports = router;
