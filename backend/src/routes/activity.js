'use strict';

const express = require('express');
const router = express.Router();
const { getEvents } = require('../activity/logger');

router.get('/', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  res.json(getEvents(limit));
});

module.exports = router;
