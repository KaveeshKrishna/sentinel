#!/usr/bin/env node
/* Why didn't the detector raise / auto-remediate an incident for a resource?
 * Usage: sudo node scripts/why-no-incident.js [type:externalId]   (default service:caddy)
 * Read-only.
 */
const Database = require('/usr/lib/sentinel/server/node_modules/better-sqlite3');
const db = new Database('/var/lib/sentinel/sentinel.db', { readonly: true });
const target = process.argv[2] || 'service:caddy';
const [type, externalId] = target.split(':');

const ar = db.prepare("SELECT value FROM settings WHERE key='autoRemediate.resources'").get();
console.log(`\n=== auto-remediate opt-in list ===\n${ar ? ar.value : '(nothing opted in)'}`);

const r = db.prepare('SELECT * FROM resources WHERE type=? AND external_id=?').get(type, externalId);
console.log(`\n=== resource ${target} ===`);
console.log(r || '(resource not registered — the detector has never observed it)');
if (!r) process.exit(0);

const open = db.prepare(
  "SELECT * FROM incidents WHERE resource_id=? AND status NOT IN ('RESOLVED','FAILED','DISMISSED')"
).get(r.id);
console.log(`\n=== OPEN incident (blocks a new one via dedupe) ===`);
console.log(open
  ? { id: open.id, status: open.status, trigger: open.trigger_rule,
      detected: new Date(open.detected_at).toLocaleString(),
      updated: new Date(open.updated_at).toLocaleString(),
      root_cause: (open.root_cause || '').slice(0, 200) }
  : '(none — a new incident can be raised)');

if (open) {
  console.log(`\n=== proposed/all actions on #${open.id} ===`);
  console.table(db.prepare(
    'SELECT id, tool_name, params_json, real_risk, status, approved_by FROM incident_actions WHERE incident_id=?'
  ).all(open.id));

  const restorative = db.prepare(
    "SELECT COUNT(*) n FROM incident_actions WHERE incident_id=? AND tool_name IN ('start_service','restart_service','start_container','restart_container')"
  ).get(open.id).n;
  console.log(`restorative actions proposed: ${restorative}` +
    (restorative === 0 ? '  <-- nothing to auto-remediate from the AI; the canonical fallback (restart) should kick in on the next poll if opted in' : ''));

  console.log(`\n=== evidence on #${open.id} ===`);
  for (const e of db.prepare('SELECT source_tool, summary FROM incident_evidence WHERE incident_id=? ORDER BY id').all(open.id)) {
    console.log(`\n[${e.source_tool}]\n${(e.summary || '').slice(0, 400)}`);
  }

  console.log(`\n=== AI runs for #${open.id} ===`);
  for (const run of db.prepare('SELECT attempt, error, substr(raw_response,1,500) raw FROM ai_runs WHERE incident_id=? ORDER BY id').all(open.id)) {
    console.log(`\n--- attempt ${run.attempt}${run.error ? '  ERROR: ' + run.error : ''} ---\n${run.raw || '(no response)'}`);
  }
}

console.log(`\n=== recent auto-remediations for this resource (rate-limit counter) ===`);
console.table(db.prepare(`
  SELECT a.id, a.tool_name, a.status, datetime(a.approved_at/1000,'unixepoch','localtime') approved_at
  FROM incident_actions a JOIN incidents i ON i.id=a.incident_id
  WHERE i.resource_id=? AND a.approved_by IS NULL AND a.approved_at >= ?
  ORDER BY a.id DESC
`).all(r.id, Date.now() - 3600000));
