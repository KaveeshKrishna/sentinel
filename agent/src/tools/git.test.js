'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// APPS_PATH is read once at require time (`const APPS_PATH = process.env.APPS_PATH || ...`
// at the top of git.js), so it must be set BEFORE requiring the module —
// same pattern other test files use for DB_PATH.
const APPS_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-apps-'));
process.env.APPS_PATH = APPS_PATH;

const registerGitTools = require('./git');
const { ToolRegistry } = require('../registry');

const REPO_NAME = 'demo-repo';
const REPO_PATH = path.join(APPS_PATH, REPO_NAME);
let remotePath;

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function commitFile(cwd, filename, content, message) {
  fs.writeFileSync(path.join(cwd, filename), content);
  git(['add', filename], cwd);
  git(['commit', '-m', message], cwd);
  return git(['rev-parse', 'HEAD'], cwd);
}

before(() => {
  // A bare "remote" so the working repo has a real @{upstream} — deploy's
  // fetch/pull and rollback's reset-then-refetch story both depend on
  // that existing, not just a local-only repo with no tracking branch.
  remotePath = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-remote-'));
  git(['init', '--bare', '-b', 'main', remotePath]);

  const seedPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-seed-'));
  git(['init', '-b', 'main', seedPath]);
  git(['config', 'user.email', 'test@example.com'], seedPath);
  git(['config', 'user.name', 'Test'], seedPath);
  commitFile(seedPath, 'app.txt', 'v1', 'initial commit');
  git(['remote', 'add', 'origin', remotePath], seedPath);
  git(['push', 'origin', 'main'], seedPath);

  git(['clone', remotePath, REPO_PATH]);
  git(['config', 'user.email', 'test@example.com'], REPO_PATH);
  git(['config', 'user.name', 'Test'], REPO_PATH);
});

after(() => {
  fs.rmSync(APPS_PATH, { recursive: true, force: true });
  fs.rmSync(remotePath, { recursive: true, force: true });
});

function tools() {
  const registry = new ToolRegistry();
  registerGitTools(registry);
  return {
    deploy: (params) => registry.get('deploy_repository').handler(params),
    verifyDeploy: (params) => registry.get('deploy_repository').verify(params),
    rollback: (params) => registry.get('rollback_repository').handler(params),
    verifyRollback: (params) => registry.get('rollback_repository').verify(params),
    registry
  };
}

/** Push a new commit to the shared remote from a throwaway clone — simulates "someone else deployed a change upstream". */
function pushNewCommitToRemote(filename, content, message) {
  const pusher = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-push-'));
  git(['clone', remotePath, pusher]);
  git(['config', 'user.email', 'test@example.com'], pusher);
  git(['config', 'user.name', 'Test'], pusher);
  const sha = commitFile(pusher, filename, content, message);
  git(['push', 'origin', 'main'], pusher);
  fs.rmSync(pusher, { recursive: true, force: true });
  return sha;
}

// ── deploy_repository: sha/message capture ──────────────────────────────

test('deploying with nothing new reports up to date, with matching from/to sha', async () => {
  const t = tools();
  const result = await t.deploy({ repo: REPO_NAME });
  assert.equal(result.upToDate, true);
  assert.equal(result.fromSha, result.toSha);
  assert.equal(result.fromMessage, result.toMessage);
  assert.match(result.fromMessage, /initial commit/);
});

test('deploying a real change captures distinct from/to sha and messages, no compose file present', async () => {
  const newSha = pushNewCommitToRemote('app.txt', 'v2', 'bump to v2');
  const t = tools();

  const result = await t.deploy({ repo: REPO_NAME });
  assert.equal(result.upToDate, false);
  assert.match(result.message, /No compose file/);
  assert.equal(result.toSha, newSha);
  assert.notEqual(result.fromSha, result.toSha);
  assert.match(result.fromMessage, /initial commit/);
  assert.match(result.toMessage, /bump to v2/);
});

test('deploy refuses a dirty working tree, before touching fromSha capture', async () => {
  fs.writeFileSync(path.join(REPO_PATH, 'untracked-change.txt'), 'oops');
  const t = tools();
  await assert.rejects(() => t.deploy({ repo: REPO_NAME }), /uncommitted changes/);
  fs.rmSync(path.join(REPO_PATH, 'untracked-change.txt'));
});

test("deploy's verify delegates to the shared compose-check helper (no compose file here)", async () => {
  const t = tools();
  const result = await t.verifyDeploy({ repo: REPO_NAME });
  assert.deepEqual(result, { ok: true, detail: 'No compose file to verify' });
});

// ── rollback_repository ──────────────────────────────────────────────────

test('rollback moves HEAD back to a known-good commit', async () => {
  const before = git(['rev-parse', 'HEAD'], REPO_PATH);
  const t = tools();

  const result = await t.rollback({ repo: REPO_NAME, sha: before.slice(0, 7) });
  // Roll forward again for later tests to have a clean baseline.
  const after = git(['rev-parse', 'HEAD'], REPO_PATH);

  assert.equal(result.toSha, after);
  assert.equal(after, before);
  assert.match(result.message, /Rolled back/);
  assert.match(result.toMessage, /bump to v2|initial commit/);
});

test('rollback to the very first commit works and matches its message', async () => {
  const firstSha = git(['log', '--reverse', '--format=%H'], REPO_PATH).split('\n')[0];
  const t = tools();

  const result = await t.rollback({ repo: REPO_NAME, sha: firstSha });
  assert.equal(git(['rev-parse', 'HEAD'], REPO_PATH), firstSha);
  assert.match(result.fromMessage, /bump to v2/, 'fromMessage is what HEAD was BEFORE the rollback');
  assert.match(result.toMessage, /initial commit/);

  // Fast-forward back to the tip for later tests — this is exactly the
  // "roll back now, fix forward later" property reset --hard preserves.
  await t.deploy({ repo: REPO_NAME });
});

test('rollback refuses a dirty working tree', async () => {
  const sha = git(['rev-parse', 'HEAD'], REPO_PATH);
  fs.writeFileSync(path.join(REPO_PATH, 'untracked-change.txt'), 'oops');
  const t = tools();
  await assert.rejects(() => t.rollback({ repo: REPO_NAME, sha }), /uncommitted changes/);
  fs.rmSync(path.join(REPO_PATH, 'untracked-change.txt'));
});

test('rollback refuses a sha that was never fetched, with a clear reason', async () => {
  const t = tools();
  await assert.rejects(
    () => t.rollback({ repo: REPO_NAME, sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }),
    /Unknown commit .* not have been fetched/
  );
});

test('rollback\'s verify delegates to the same shared compose-check helper as deploy', async () => {
  const t = tools();
  const result = await t.verifyRollback({ repo: REPO_NAME });
  assert.deepEqual(result, { ok: true, detail: 'No compose file to verify' });
});

test('a malformed sha is rejected by the schema before the handler ever runs', () => {
  const t = tools();
  const { valid, errors } = t.registry.validateParams('rollback_repository', { repo: REPO_NAME, sha: 'not-a-sha!!' });
  assert.equal(valid, false);
  assert.ok(errors.length > 0);
});

// ── Registration shape ───────────────────────────────────────────────────

test('rollback_repository is registered MEDIUM_RISK, same tier as deploy_repository', () => {
  const t = tools();
  assert.equal(t.registry.get('rollback_repository').risk, 'MEDIUM_RISK');
  assert.equal(t.registry.get('deploy_repository').risk, 'MEDIUM_RISK');
});
