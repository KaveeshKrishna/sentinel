'use strict';

const express = require('express');
const router = express.Router();
const { getEvents, MAX_ACTIVITY_EVENTS } = require('../activity/logger');

router.get('/', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || MAX_ACTIVITY_EVENTS, MAX_ACTIVITY_EVENTS);
  res.json(getEvents(limit));
});

module.exports = router;
