'use strict';

const { getDb } = require('../db/connection');

/**
 * Most real outages are caused by a deploy, and until now Sentinel had no
 * way to say so: `commit.date` on a repo is the git AUTHOR date, not
 * deploy time, and `deployments` (migration 015) is the first durable
 * record of when a repo was actually deployed to.
 *
 * The join key is `resources.metadata_json->composeProject` against
 * `deployments.repo_name`, matching Docker Compose's own default
 * project-name convention (the basename of the directory holding the
 * compose file — which for a repo under APPS_PATH is the repo name
 * itself, unless an operator overrides it). A resource with no compose
 * metadata (a systemd service, a website, the host) simply cannot
 * correlate — an accepted scope limit, not a silent degradation: those
 * trigger rules never call this at all in practice, since only
 * container-shaped incidents have compose labels to match on.
 */

/**
 * The most recent deploy to `resource`'s repo inside the window ending at
 * `detectedAt`, or null. Pure DB read — no agent call, so it's cheap
 * enough to run on every incident's evidence-gathering pass.
 *
 * @param {{metadata?: {composeProject?: string}}|null} resource
 * @param {number} detectedAt - incident.detected_at (epoch ms)
 * @param {number} windowMs - how far back to look (settings/detectorConfig.js's deployCorrelationWindowMs)
 */
function findRecentDeployForResource(resource, detectedAt, windowMs) {
  const repoName = resource?.metadata?.composeProject;
  if (!repoName) return null;

  const row = getDb().prepare(`
    SELECT * FROM deployments
     WHERE LOWER(repo_name) = LOWER(?)
       AND deployed_at BETWEEN ? AND ?
     ORDER BY deployed_at DESC
     LIMIT 1
  `).get(repoName, detectedAt - windowMs, detectedAt);

  return row || null;
}

/** Human-readable "N minutes/hours before this incident", for the evidence summary. */
function humanizeDelta(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

/**
 * Build the incident_evidence row shape (see context/engine.js's
 * `gatherEvidence`) for a correlated deploy, or null if none was found.
 */
function buildDeployCorrelationEvidence(resource, incident, windowMs) {
  const deploy = findRecentDeployForResource(resource, incident.detected_at, windowMs);
  if (!deploy) return null;

  const shortFrom = deploy.from_sha ? deploy.from_sha.slice(0, 7) : '?';
  const shortTo = deploy.to_sha ? deploy.to_sha.slice(0, 7) : '?';
  const delta = humanizeDelta(incident.detected_at - deploy.deployed_at);

  return {
    resourceId: resource?.id ?? null,
    sourceTool: 'deploy_correlation',
    summary: `${deploy.repo_name} was deployed ${delta} before this incident: `
      + `"${deploy.from_message || '?'}" (${shortFrom}) -> "${deploy.to_message || '?'}" (${shortTo})`,
    data: deploy
  };
}

module.exports = { findRecentDeployForResource, buildDeployCorrelationEvidence, humanizeDelta };
