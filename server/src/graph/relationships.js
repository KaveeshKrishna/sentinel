'use strict';

const { getDb } = require('../db/connection');
const { upsertResource } = require('./resources');

/**
 * Register a static dependency edge, e.g. demo-api depends_on demo-db.
 * Upserts both endpoints as resources first so an edge can be declared
 * before either side has actually been observed by the detector.
 */
function registerRelationship(fromRef, toRef, relationship) {
  const from = upsertResource(fromRef);
  const to = upsertResource(toRef);

  getDb().prepare(`
    INSERT INTO resource_relationships (from_resource_id, to_resource_id, relationship, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(from_resource_id, to_resource_id, relationship) DO NOTHING
  `).run(from.id, to.id, relationship, Date.now());

  return { from, to, relationship };
}

/** Neighbours in either direction — a resource this one depends_on, or that depends on it. */
function getNeighbours(resourceId) {
  const db = getDb();
  const outgoing = db.prepare(`
    SELECT r.*, rr.relationship, 'outgoing' AS direction
    FROM resource_relationships rr JOIN resources r ON r.id = rr.to_resource_id
    WHERE rr.from_resource_id = ?
  `).all(resourceId);
  const incoming = db.prepare(`
    SELECT r.*, rr.relationship, 'incoming' AS direction
    FROM resource_relationships rr JOIN resources r ON r.id = rr.from_resource_id
    WHERE rr.to_resource_id = ?
  `).all(resourceId);
  return [...outgoing, ...incoming];
}

/** Resources that declare a dependency ON this one (i.e. this one has dependents). */
function getDependents(resourceId) {
  return getDb().prepare(`
    SELECT r.* FROM resource_relationships rr JOIN resources r ON r.id = rr.from_resource_id
    WHERE rr.to_resource_id = ? AND rr.relationship = 'depends_on'
  `).all(resourceId);
}

module.exports = { registerRelationship, getNeighbours, getDependents };
