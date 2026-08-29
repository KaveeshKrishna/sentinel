#!/usr/bin/env node
/* Why didn't the detector raise an incident for a resource?
 * Usage: sudo node scripts/why-no-incident.js [type:externalId]
 * Read-only.
 */
const Database = require('/usr/lib/sentinel/server/node_modules/better-sqlite3');
const db = new Database('/var/lib/sentinel/sentinel.db', { readonly: true });
const target = process.argv[2] || 'service:caddy';
const [type, externalId] = target.split(':');

console.log(`\n=== auto-remediate opt-in list ===`);
const ar = db.prepare("SELECT value FROM settings WHERE key='autoRemediate.resources'").get();
console.log(ar ? ar.value : '(nothing opted in)');

console.log(`\n=== resource ${target} ===`);
const r = db.prepare('SELECT * FROM resources WHERE type=? AND external_id=?').get(type, externalId);
console.log(r || '(resource not registered)');

if (r) {
  console.log(`\n=== OPEN incidents for it (these BLOCK a new one via dedupe) ===`);
  console.table(db.prepare(
    `SELECT id, status, trigger_rule, datetime(detected_at/1000,'unixepoch','localtime') detected,
            datetime(updated_at/1000,'unixepoch','localtime') updated
     FROM incidents WHERE resource_id=? AND status NOT IN ('RESOLVED','FAILED','DISMISSED')`
  ).all(r.id));

  console.log(`=== its most recent incidents (any state) ===`);
  console.table(db.prepare(
    `SELECT id, status, trigger_rule, datetime(detected_at/1000,'unixepoch','localtime') detected
     FROM incidents WHERE resource_id=? ORDER BY id DESC LIMIT 5`
  ).all(r.id));

  const open = db.prepare(
    "SELECT id FROM incidents WHERE resource_id=? AND status NOT IN ('RESOLVED','FAILED','DISMISSED')"
  ).get(r.id);
  if (open) {
    console.log(`=== proposed actions on open incident #${open.id} ===`);
    console.table(db.prepare(
      'SELECT id, tool_name, params_json, real_risk, status, approved_by FROM incident_actions WHERE incident_id=?'
    ).all(open.id));
  }
}
