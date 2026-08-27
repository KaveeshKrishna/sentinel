#!/usr/bin/env node
/* Inspect the ai_runs table — the exact request/response per AI call.
 * Usage:  sudo node scripts/ai-runs.js [limit]        # list recent runs
 *         sudo node scripts/ai-runs.js show <id>      # full dump of one run
 * Read-only. No sqlite3 CLI needed on this host.
 */
const path = require('path');
const Database = require(
  path.join('/usr/lib/sentinel/server/node_modules/better-sqlite3')
);
const db = new Database('/var/lib/sentinel/sentinel.db', { readonly: true });

const [, , cmd, arg] = process.argv;

if (cmd === 'show') {
  const row = db.prepare('SELECT * FROM ai_runs WHERE id = ?').get(Number(arg));
  if (!row) { console.error('no such ai_runs id'); process.exit(1); }
  for (const [k, v] of Object.entries(row)) {
    console.log('\n=== ' + k + ' ===');
    console.log(v);
  }
} else {
  const limit = Number(cmd) || 15;
  const rows = db.prepare(
    `SELECT id, incident_id, purpose, provider, model, attempt,
            substr(error,1,60) AS error, prompt_tokens, completion_tokens,
            latency_ms, datetime(created_at/1000,'unixepoch','localtime') AS at
     FROM ai_runs ORDER BY id DESC LIMIT ?`
  ).all(limit);
  console.table(rows);
  console.log('\nrun:  sudo node scripts/ai-runs.js show <id>   for the full request_summary / raw_response / parsed_json');
}
