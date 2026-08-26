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

  return db;
}

module.exports = { getDb, DB_PATH };
