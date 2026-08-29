'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const registerFileTools = require('./files');
const { isDenied, resolveAllowed } = require('./files');
const { ToolRegistry } = require('../registry');

let root, outside;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-files-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-outside-'));

  fs.mkdirSync(path.join(root, 'logs'));
  fs.writeFileSync(path.join(root, 'logs', 'app.log'), 'line one\nline two\nERROR boom\nline four\n');
  fs.writeFileSync(path.join(root, 'config.yml'), 'server:\n  port: 8889\n');
  fs.writeFileSync(path.join(root, 'secret.pem'), '-----BEGIN PRIVATE KEY-----');
  fs.writeFileSync(path.join(root, '.env'), 'API_KEY=super-secret-value');
  fs.writeFileSync(path.join(outside, 'private.txt'), 'should never be readable');
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

/**
 * The registry holds definitions; the HTTP layer calls handlers. Tests
 * go straight to the handler, which is where the containment checks live
 * — exactly the code path a real call takes after schema validation.
 */
function tools() {
  const registry = new ToolRegistry();
  registerFileTools(registry);
  const run = name => params => registry.get(name).handler(params);
  return {
    list: run('list_directory'),
    read: run('read_file'),
    search: run('search_files'),
    registry
  };
}

// ── Containment ─────────────────────────────────────────────────────────

test('with no roots configured, nothing is readable at all', async () => {
  const t = tools();
  await assert.rejects(() => t.read({ path: path.join(root, 'config.yml'), roots: [] }), /No filesystem access is configured/);
  await assert.rejects(() => t.list({ path: root }), /No filesystem access is configured/);
});

test('a file inside an allowed root is readable', async () => {
  const t = tools();
  const result = await t.read({ path: path.join(root, 'config.yml'), roots: [root] });
  assert.match(result.content, /port: 8889/);
});

test('a path outside every allowed root is refused', async () => {
  const t = tools();
  await assert.rejects(
    () => t.read({ path: path.join(outside, 'private.txt'), roots: [root] }),
    /outside every allowed directory/
  );
});

test('.. traversal cannot escape an allowed root', async () => {
  const t = tools();
  await assert.rejects(
    () => t.read({ path: path.join(root, '..', path.basename(outside), 'private.txt'), roots: [root] }),
    /outside every allowed directory/
  );
});

test('a symlink inside an allowed root cannot be used to step outside it', async () => {
  const link = path.join(root, 'escape-hatch');
  fs.symlinkSync(path.join(outside, 'private.txt'), link);
  const t = tools();
  await assert.rejects(
    () => t.read({ path: link, roots: [root] }),
    /outside every allowed directory/,
    'the path must be resolved BEFORE the containment check, or a link defeats it'
  );
  fs.rmSync(link);
});

test('a relative path is refused rather than resolved against some cwd', async () => {
  const t = tools();
  await assert.rejects(() => t.read({ path: 'config.yml', roots: [root] }), /must be absolute/);
});

// ── The deny list the caller cannot influence ───────────────────────────
// These hold even when the server passes a root that contains them —
// the agent enforces them on its own behalf, the same way policy.js
// doesn't trust the X-Sentinel-Approved header.

test('secrets are refused even when they sit inside an allowed root', async () => {
  const t = tools();
  await assert.rejects(() => t.read({ path: path.join(root, 'secret.pem'), roots: [root] }), /never read/);
  await assert.rejects(() => t.read({ path: path.join(root, '.env'), roots: [root] }), /never read/);
});

test('denied files are not even listed — their existence is a hint too', async () => {
  const t = tools();
  const { entries } = await t.list({ path: root, roots: [root] });
  const names = entries.map(e => e.name);
  assert.ok(names.includes('config.yml'));
  assert.ok(!names.includes('secret.pem'));
  assert.ok(!names.includes('.env'));
});

test('a root of "/" still cannot reach the categories that are always denied', () => {
  // The important property: this does not depend on which roots were
  // passed, so a bug or a compromise in the server cannot widen it.
  for (const p of [
    '/etc/shadow', '/etc/sentinel/agent.token', '/var/lib/sentinel/sentinel.db',
    '/root/.bashrc', '/home/someone/.ssh/id_rsa', '/etc/ssl/private/server.key',
    '/srv/app/.env', '/proc/1/environ', '/home/u/.aws/credentials'
  ]) {
    assert.equal(isDenied(p), true, `${p} must never be readable`);
  }
  for (const p of ['/var/log/syslog', '/srv/apps/x/config.yml', '/etc/caddy/Caddyfile']) {
    assert.equal(isDenied(p), false, `${p} is ordinary and should be allowed`);
  }
});

test('a root of "/" contains everything — and then the deny list is what refuses secrets', () => {
  // Regression: `resolved.startsWith('/' + sep)` is startsWith('//'),
  // which is never true, so '/' used to match nothing. Access was still
  // refused, but by the containment check rather than the deny list —
  // hiding whether the deny list worked at all.
  assert.throws(
    () => resolveAllowed('/etc/shadow', ['/']),
    /never read/,
    'must be refused BY THE DENY LIST, not by an accidental containment miss'
  );
  assert.throws(() => resolveAllowed('/etc/sentinel/agent.token', ['/']), /never read/);
  assert.throws(() => resolveAllowed('/root/.bashrc', ['/']), /never read/);

  // ...while an ordinary path under '/' does resolve.
  const ordinary = path.join(root, 'config.yml');
  assert.equal(resolveAllowed(ordinary, ['/']), fs.realpathSync(ordinary));
});

test('resolveAllowed accepts a root that equals the path itself', () => {
  assert.equal(resolveAllowed(root, [root]), fs.realpathSync(root));
});

// ── Bounded output ──────────────────────────────────────────────────────

test('read_file honours a tail line count', async () => {
  const t = tools();
  const result = await t.read({ path: path.join(root, 'logs', 'app.log'), tail: 2, roots: [root] });
  assert.equal(result.content.split('\n').filter(Boolean).length, 2);
  assert.match(result.content, /line four/);
});

test('a very large file is tail-truncated rather than refused or fully loaded', async () => {
  const big = path.join(root, 'big.log');
  fs.writeFileSync(big, 'x'.repeat(400 * 1024) + '\nLAST LINE\n');
  const t = tools();
  const result = await t.read({ path: big, roots: [root] });
  assert.equal(result.truncated, true);
  assert.ok(result.content.length <= 256 * 1024);
  assert.match(result.content, /LAST LINE/, 'the end of a log is the part worth having');
  fs.rmSync(big);
});

test('reading a directory reports that clearly instead of throwing something opaque', async () => {
  const t = tools();
  await assert.rejects(() => t.read({ path: path.join(root, 'logs'), roots: [root] }), /not a regular file/);
});

// ── Search ──────────────────────────────────────────────────────────────

test('search_files finds a literal match with its file and line number', async () => {
  const t = tools();
  const result = await t.search({ path: root, query: 'ERROR', roots: [root] });
  assert.equal(result.matches.length, 1);
  assert.match(result.matches[0].path, /app\.log$/);
  assert.equal(result.matches[0].line, 3);
});

test('search never returns a hit from a denied file', async () => {
  const t = tools();
  const result = await t.search({ path: root, query: 'super-secret-value', roots: [root] });
  assert.equal(result.matches.length, 0, 'a secret must not leak through search either');
});

test('search is confined to the allowed roots', async () => {
  const t = tools();
  await assert.rejects(
    () => t.search({ path: outside, query: 'never', roots: [root] }),
    /outside every allowed directory/
  );
});

// ── Registration ────────────────────────────────────────────────────────

test('all three tools are registered READ_ONLY, so they can never be approved as mutations', () => {
  const registry = new ToolRegistry();
  registerFileTools(registry);
  for (const name of ['list_directory', 'read_file', 'search_files']) {
    assert.equal(registry.get(name).risk, 'READ_ONLY', `${name} must be READ_ONLY`);
  }
});

test('there is still no file-WRITE tool to ask for', () => {
  const registry = new ToolRegistry();
  registerFileTools(registry);
  const names = registry.list().map(t => t.name);
  for (const forbidden of ['write_file', 'delete_file', 'move_file', 'chmod', 'append_file']) {
    assert.ok(!names.includes(forbidden), `${forbidden} must not exist`);
  }
});
