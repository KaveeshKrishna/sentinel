'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/sentinel.db');

let db = null;

/**
 * Open (or return the already-open) shared SQLite connection. Every
 * module that needs the database imports this instead of opening its
 * own connection, so pragmas and migrations only ever apply once.
 */
function getDb() {
  if (db) return db;

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  // better-sqlite3 creates the file with the process umask (0644 in
  // practice). The containing directory is already 0750 sentinel:sentinel
  // so this was never a real exposure, but the file holds session rows
  // and encrypted provider keys — it should not be world-readable on its
  // own terms. WAL/SHM are created alongside it and get the same
  // treatment. Best-effort: a bind-mounted or read-only path can refuse
  // chmod, and that must not stop the server from booting.
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.chmodSync(DB_PATH + suffix, 0o640); } catch { /* not present yet, or not ours to chmod */ }
  }

  return db;
}

module.exports = { getDb, DB_PATH };
