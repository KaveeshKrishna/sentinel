'use strict';

const express = require('express');
const router = express.Router();
const { collectAll } = require('../collectors');

router.get('/snapshot', (_req, res) => {
  try {
    res.json(collectAll());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
