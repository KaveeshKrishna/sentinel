'use strict';

const { getDb } = require('../db/connection');

/**
 * Upsert a resource node (container/service/website). Called
 * opportunistically whenever the detector or context engine observes
 * one, so `resources` stays current without a separate discovery pass.
 *
 * A caller that omits `metadata` never erases metadata a DIFFERENT
 * caller already recorded — the ON CONFLICT clause COALESCEs to the
 * existing row's value rather than overwriting with NULL. This matters
 * concretely: `detector.js`'s `checkContainerHealth` upserts compose
 * labels (composeProject/composeService) for deploy correlation, but
 * `raiseIncident`'s own upserts (e.g. on a container_exit event) call
 * this with no metadata at all — without the COALESCE, a container
 * dying would wipe the very metadata needed to correlate its incident
 * with a recent deploy, in the same tick that incident is raised.
 */
function upsertResource({ type, externalId, name, metadata }) {
  const db = getDb();
  const now = Date.now();
  const metadataJson = metadata !== undefined ? JSON.stringify(metadata) : null;

  db.prepare(`
    INSERT INTO resources (type, external_id, name, metadata_json, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(type, external_id) DO UPDATE SET
      name = excluded.name,
      metadata_json = COALESCE(excluded.metadata_json, resources.metadata_json),
      last_seen_at = excluded.last_seen_at
  `).run(type, externalId, name, metadataJson, now, now);

  return getResourceByRef(type, externalId);
}

function getResourceByRef(type, externalId) {
  const row = getDb().prepare('SELECT * FROM resources WHERE type = ? AND external_id = ?').get(type, externalId);
  return row ? deserialize(row) : null;
}

function getResource(id) {
  const row = getDb().prepare('SELECT * FROM resources WHERE id = ?').get(id);
  return row ? deserialize(row) : null;
}

function listResources() {
  return getDb().prepare('SELECT * FROM resources ORDER BY type, name').all().map(deserialize);
}

function deserialize(row) {
  return { ...row, metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null };
}

module.exports = { upsertResource, getResourceByRef, getResource, listResources };
