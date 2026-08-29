'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = path.join(os.tmpdir(), `sentinel-test-deploycorr-${crypto.randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { migrate } = require('../db/migrate');
const { getDb } = require('../db/connection');
const { findRecentDeployForResource, buildDeployCorrelationEvidence, humanizeDelta } = require('./deployCorrelation');

before(() => migrate());
beforeEach(() => getDb().prepare('DELETE FROM deployments').run());
after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(DB_PATH + suffix); } catch { /* already gone */ }
  }
});

const WINDOW_MS = 15 * 60 * 1000;

function seedDeploy({ repoName, deployedAt, fromSha = 'aaa1111', toSha = 'bbb2222', fromMessage = 'old', toMessage = 'new', status = 'success' }) {
  getDb().prepare(`
    INSERT INTO deployments (repo_name, resource_id, from_sha, to_sha, from_message, to_message, deployed_at, deployed_by, status, steps_json)
    VALUES (?, NULL, ?, ?, ?, ?, ?, 'user', ?, '[]')
  `).run(repoName, fromSha, toSha, fromMessage, toMessage, deployedAt, status);
}

test('a deploy inside the window, matching repo, is found', () => {
  const now = Date.now();
  seedDeploy({ repoName: 'demo-api', deployedAt: now - 4 * 60 * 1000 });
  const resource = { metadata: { composeProject: 'demo-api' } };

  const deploy = findRecentDeployForResource(resource, now, WINDOW_MS);
  assert.ok(deploy);
  assert.equal(deploy.repo_name, 'demo-api');
});

test('matching is case-insensitive on repo name', () => {
  const now = Date.now();
  seedDeploy({ repoName: 'Demo-API', deployedAt: now - 1000 });
  const resource = { metadata: { composeProject: 'demo-api' } };
  assert.ok(findRecentDeployForResource(resource, now, WINDOW_MS));
});

test('a deploy outside the window is not found', () => {
  const now = Date.now();
  seedDeploy({ repoName: 'old-repo', deployedAt: now - WINDOW_MS - 60000 });
  const resource = { metadata: { composeProject: 'old-repo' } };
  assert.equal(findRecentDeployForResource(resource, now, WINDOW_MS), null);
});

test('a deploy to a different repo does not match', () => {
  const now = Date.now();
  seedDeploy({ repoName: 'unrelated-repo', deployedAt: now - 1000 });
  const resource = { metadata: { composeProject: 'demo-api' } };
  assert.equal(findRecentDeployForResource(resource, now, WINDOW_MS), null);
});

test('a resource with no compose metadata cannot correlate', () => {
  const now = Date.now();
  seedDeploy({ repoName: 'demo-api', deployedAt: now - 1000 });
  assert.equal(findRecentDeployForResource({ metadata: null }, now, WINDOW_MS), null);
  assert.equal(findRecentDeployForResource(null, now, WINDOW_MS), null);
  assert.equal(findRecentDeployForResource({ metadata: {} }, now, WINDOW_MS), null);
});

test('the most recent matching deploy wins when several are in-window', () => {
  const now = Date.now();
  const repoName = 'multi-deploy-' + crypto.randomUUID();
  seedDeploy({ repoName, deployedAt: now - 10 * 60 * 1000, toSha: 'first000' });
  seedDeploy({ repoName, deployedAt: now - 2 * 60 * 1000, toSha: 'second000' });

  const deploy = findRecentDeployForResource({ metadata: { composeProject: repoName } }, now, WINDOW_MS);
  assert.equal(deploy.to_sha, 'second000');
});

test('buildDeployCorrelationEvidence returns null when nothing correlates', () => {
  const incident = { detected_at: Date.now(), resource_id: 1 };
  const resource = { id: 1, metadata: { composeProject: 'nothing-deployed-here-' + crypto.randomUUID() } };
  assert.equal(buildDeployCorrelationEvidence(resource, incident, WINDOW_MS), null);
});

test('buildDeployCorrelationEvidence produces a summary with both messages and shas, and the raw row as data', () => {
  const repoName = 'evidence-repo-' + crypto.randomUUID();
  const now = Date.now();
  seedDeploy({
    repoName, deployedAt: now - 4 * 60 * 1000,
    fromSha: '1111111abc', toSha: '2222222def',
    fromMessage: 'fix logging', toMessage: 'bump node to 22'
  });
  const resource = { id: 5, metadata: { composeProject: repoName } };
  const incident = { detected_at: now, resource_id: 5 };

  const evidence = buildDeployCorrelationEvidence(resource, incident, WINDOW_MS);
  assert.equal(evidence.sourceTool, 'deploy_correlation');
  assert.equal(evidence.resourceId, 5);
  assert.match(evidence.summary, /fix logging/);
  assert.match(evidence.summary, /bump node to 22/);
  assert.match(evidence.summary, /1111111/);
  assert.match(evidence.summary, /2222222/);
  assert.match(evidence.summary, /4m before this incident/);
  assert.equal(evidence.data.repo_name, repoName);
});

test('humanizeDelta renders seconds, minutes, and hours sensibly', () => {
  assert.equal(humanizeDelta(45 * 1000), '45s');
  assert.equal(humanizeDelta(4 * 60 * 1000), '4m');
  assert.equal(humanizeDelta(3 * 60 * 60 * 1000), '3h');
});
