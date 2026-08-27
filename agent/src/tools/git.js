'use strict';

const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const APPS_PATH = process.env.APPS_PATH || '/srv/apps';

async function safeExec(cmd, args, cwd, timeout = 15000) {
  const { stdout } = await execFileAsync(cmd, args, { cwd, timeout, encoding: 'utf8' });
  return stdout.trim();
}

function findComposeFile(repoPath) {
  for (const name of ['compose.yml', 'docker-compose.yml', 'compose.yaml', 'docker-compose.yaml']) {
    if (fs.existsSync(path.join(repoPath, name))) return name;
  }
  return null;
}

async function getRepoInfo(repoPath, name) {
  try {
    const branch = await safeExec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
    const logRaw = await safeExec('git', ['log', '-1', '--format=%H|%an|%ai|%s'], repoPath);
    const [hash, author, date, ...msgParts] = logRaw.split('|');
    const message = msgParts.join('|').trim();
    const statusOut = await safeExec('git', ['status', '--porcelain'], repoPath);
    const isClean = statusOut === '';
    let behind = 0;
    let ahead = 0;
    try {
      behind = parseInt(await safeExec('git', ['rev-list', 'HEAD..@{upstream}', '--count'], repoPath), 10) || 0;
      ahead = parseInt(await safeExec('git', ['rev-list', '@{upstream}..HEAD', '--count'], repoPath), 10) || 0;
    } catch { /* no upstream configured */ }

    return {
      name,
      path: repoPath,
      branch,
      commit: {
        hash: hash?.slice(0, 7),
        fullHash: hash?.trim(),
        author: author?.trim(),
        date: date?.trim(),
        message: message?.slice(0, 120)
      },
      clean: isClean,
      uncommittedFiles: isClean ? 0 : statusOut.split('\n').filter(Boolean).length,
      ahead,
      behind,
      composeFile: findComposeFile(repoPath)
    };
  } catch (err) {
    return { name, path: repoPath, error: err.message };
  }
}

function discoverRepos() {
  const repos = [];
  try {
    const entries = fs.readdirSync(APPS_PATH, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const repoPath = path.join(APPS_PATH, entry.name);
      if (!fs.existsSync(path.join(repoPath, '.git'))) continue;
      repos.push({ name: entry.name, path: repoPath });
    }
  } catch { /* APPS_PATH not present */ }
  return repos;
}

/**
 * Resolve a repo name to its path, refusing anything outside APPS_PATH.
 * path.basename() strips traversal segments, but that alone still lets
 * e.g. `".."` resolve to a real sibling directory — the second check
 * (must be a *known* git repo, from the discovered list) closes that gap.
 */
function resolveRepoPath(name) {
  const safeName = path.basename(name);
  const repoPath = path.join(APPS_PATH, safeName);
  const known = discoverRepos().some(r => r.name === safeName);
  if (!known || !fs.existsSync(path.join(repoPath, '.git'))) {
    throw new Error(`"${safeName}" is not a known git repository under ${APPS_PATH}`);
  }
  return { safeName, repoPath };
}

/**
 * The agent runs as root; repos under APPS_PATH are owned by whatever
 * user actually deploys them (not root). Since Git 2.35.2, a `git`
 * command refuses to run at all in a repo owned by a different user
 * than the one invoking it ("detected dubious ownership") unless that
 * path is explicitly allow-listed — root has no standing exception.
 * Called once at agent startup so every discovered repo is trusted
 * before the first git call, and re-run on restart so a newly-cloned
 * repo picks it up without a separate manual step.
 */
function ensureSafeDirectories() {
  const repos = discoverRepos();
  if (repos.length === 0) return;

  let alreadyTrusted = new Set();
  try {
    const out = execFileSync('git', ['config', '--system', '--get-all', 'safe.directory'], { encoding: 'utf8' });
    alreadyTrusted = new Set(out.split('\n').filter(Boolean));
  } catch { /* key not set yet — git exits non-zero, nothing trusted so far */ }

  for (const { path: repoPath } of repos) {
    if (alreadyTrusted.has(repoPath)) continue;
    try {
      execFileSync('git', ['config', '--system', '--add', 'safe.directory', repoPath]);
    } catch (err) {
      console.error(`[sentinel-agent] failed to trust ${repoPath} as a git safe.directory:`, err.message);
    }
  }
}

module.exports = function registerGitTools(registry) {
  registry.register({
    name: 'inspect_git_status',
    description: 'Get git status (branch, dirty state, ahead/behind, last commit) for one repository, or all discovered repositories if none is specified.',
    risk: 'READ_ONLY',
    parameters: {
      type: 'object',
      properties: { repo: { type: 'string' } },
      additionalProperties: false
    },
    handler: async ({ repo } = {}) => {
      if (repo) {
        const { safeName, repoPath } = resolveRepoPath(repo);
        return getRepoInfo(repoPath, safeName);
      }
      const repos = discoverRepos();
      return Promise.all(repos.map(r => getRepoInfo(r.path, r.name)));
    }
  });

  registry.register({
    name: 'inspect_recent_deployment',
    description: 'Get the most recent commit and deployment-relevant configuration (compose file presence) for one repository.',
    risk: 'READ_ONLY',
    parameters: {
      type: 'object',
      properties: { repo: { type: 'string', minLength: 1 } },
      required: ['repo'],
      additionalProperties: false
    },
    handler: async ({ repo }) => {
      const { safeName, repoPath } = resolveRepoPath(repo);
      return getRepoInfo(repoPath, safeName);
    }
  });

  registry.register({
    name: 'deploy_repository',
    description: 'Deploy a repository: fetch, fast-forward pull (refuses if the working tree is dirty), then docker compose build + up -d if a compose file is present.',
    risk: 'MEDIUM_RISK',
    parameters: {
      type: 'object',
      properties: { repo: { type: 'string', minLength: 1 } },
      required: ['repo'],
      additionalProperties: false
    },
    handler: async ({ repo }) => {
      const { safeName, repoPath } = resolveRepoPath(repo);
      const steps = [];

      const dirty = await safeExec('git', ['status', '--porcelain'], repoPath);
      if (dirty !== '') {
        const count = dirty.split('\n').filter(Boolean).length;
        throw new Error(`Repository has uncommitted changes: ${count} file(s). Commit or stash before deploying.`);
      }

      await safeExec('git', ['fetch', '--prune'], repoPath);
      steps.push({ step: 'fetch', ok: true });

      let behind = 0;
      try {
        behind = parseInt(await safeExec('git', ['rev-list', 'HEAD..@{upstream}', '--count'], repoPath), 10) || 0;
      } catch { /* no upstream configured */ }

      if (behind === 0) {
        return { repo: safeName, steps, upToDate: true, message: 'Already up to date' };
      }

      const pullOut = await safeExec('git', ['pull', '--ff-only'], repoPath);
      steps.push({ step: 'pull', ok: true, output: pullOut });

      const composeFile = findComposeFile(repoPath);
      if (!composeFile) {
        return { repo: safeName, steps, upToDate: false, message: 'Pulled. No compose file found — skipping Docker steps.' };
      }

      await execFileAsync('docker', ['compose', '-f', path.join(repoPath, composeFile), 'build'], { cwd: repoPath, timeout: 300000 });
      steps.push({ step: 'build', ok: true });

      await execFileAsync('docker', ['compose', '-f', path.join(repoPath, composeFile), 'up', '-d'], { cwd: repoPath, timeout: 120000 });
      steps.push({ step: 'up', ok: true });

      return { repo: safeName, steps, upToDate: false, message: 'Deployed successfully' };
    },
    verify: async ({ repo }) => {
      const { repoPath } = resolveRepoPath(repo);
      const composeFile = findComposeFile(repoPath);
      if (!composeFile) return { ok: true, detail: 'No compose file to verify' };
      try {
        const { stdout } = await execFileAsync(
          'docker', ['compose', '-f', path.join(repoPath, composeFile), 'ps', '--format', 'json'],
          { cwd: repoPath, timeout: 15000 }
        );
        return { ok: true, detail: stdout };
      } catch (err) {
        return { ok: false, detail: err.message };
      }
    }
  });
};

module.exports.ensureSafeDirectories = ensureSafeDirectories;
