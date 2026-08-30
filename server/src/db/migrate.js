'use strict';

const fs = require('fs');
const path = require('path');
const { getDb } = require('./connection');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * Apply any migration in migrations/ not yet recorded in
 * schema_migrations, in filename order (numeric prefixes keep that
 * order stable and human-readable). Each migration runs in its own
 * transaction, so a failure partway through a file rolls that file back
 * without re-applying migrations that already succeeded.
 */
function migrate() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          TEXT PRIMARY KEY,
      applied_at  INTEGER NOT NULL
    );
  `);

  const applied = new Set(db.prepare('SELECT id FROM schema_migrations').all().map(r => r.id));
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const run = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(file, Date.now());
    });
    run();
    console.log(`[db] applied migration ${file}`);
  }

  return db;
}

module.exports = { migrate, MIGRATIONS_DIR };
