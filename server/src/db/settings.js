'use strict';

const { getDb } = require('./connection');

function getSetting(key) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  getDb().prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, Date.now());
}

function deleteSetting(key) {
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(key);
}

module.exports = { getSetting, setSetting, deleteSetting };
