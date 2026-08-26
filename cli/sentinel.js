#!/usr/bin/env node
'use strict';

const fs = require('fs');
const readline = require('readline');
const { spawn } = require('child_process');
const systemd = require('./lib/systemd');
const { runChecks } = require('./lib/doctor');
const paths = require('./lib/paths');

const ICONS = { ok: '✓', warn: '!', fail: '✗', skip: '·' };

function println(...args) { console.log(...args); }

function isRoot() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

function requireRoot(action) {
  if (!isRoot()) {
    console.error(`This command needs root — re-run as: sudo sentinel ${action}`);
    process.exit(1);
  }
}

async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(`${question} [y/N] `, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

// ── Commands ────────────────────────────────────────────────────────────────

function cmdStatus() {
  println('Sentinel service status\n');
  for (const unit of systemd.UNITS) {
    const active = systemd.isActive(unit);
    const enabled = systemd.isEnabled(unit);
    const icon = active === 'active' ? ICONS.ok : ICONS.fail;
    println(`  ${icon} ${unit.padEnd(18)} ${active.padEnd(10)} (${enabled})`);
  }
  println('\nRun `sentinel doctor` for a full health check.');
}

function cmdStart() {
  requireRoot('start');
  systemd.start();
  println('Started sentinel-agent and sentinel-server.');
}

function cmdStop() {
  requireRoot('stop');
  // Stop server first — it depends on the agent, not the other way round.
  systemd.stop(['sentinel-server']);
  systemd.stop(['sentinel-agent']);
  println('Stopped sentinel-server and sentinel-agent.');
}

function cmdRestart() {
  requireRoot('restart');
  systemd.restart(['sentinel-agent']);
  systemd.restart(['sentinel-server']);
  println('Restarted sentinel-agent and sentinel-server.');
}

function cmdLogs(args) {
  const follow = args.includes('--follow') || args.includes('-f');
  const target = args.find(a => !a.startsWith('-'));
  const units = target === 'agent' ? ['sentinel-agent']
    : target === 'server' ? ['sentinel-server']
    : systemd.UNITS;

  const journalArgs = units.flatMap(u => ['-u', u]).concat(['--no-pager', '-o', 'short-iso']);
  if (follow) journalArgs.push('-f');

  const proc = spawn('journalctl', journalArgs, { stdio: 'inherit' });
  proc.on('exit', (code) => process.exit(code || 0));
}

async function cmdDoctor() {
  println('Running Sentinel health checks…\n');
  const results = await runChecks();

  let failCount = 0;
  for (const r of results) {
    if (r.status === 'fail') failCount++;
    const icon = ICONS[r.status] || '?';
    const line = r.detail ? `${r.name} — ${r.detail}` : r.name;
    println(`  ${icon} ${line}`);
  }

  println('');
  if (failCount > 0) {
    println(`${failCount} check(s) failed. See above.`);
    process.exit(1);
  } else {
    println('All critical checks passed.');
  }
}

function readEnvFile(path) {
  try {
    const content = fs.readFileSync(path, 'utf8');
    const out = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx < 0) continue;
      out[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
    }
    return out;
  } catch {
    return null;
  }
}

const SECRET_KEYS = new Set(['JWT_SECRET', 'SENTINEL_AGENT_TOKEN', 'ADMIN_PASSWORD_HASH']);

function cmdConfig() {
  println('Sentinel configuration\n');
  for (const [label, path] of [['agent', paths.AGENT_ENV], ['server', paths.SERVER_ENV]]) {
    println(`${label} (${path}):`);
    const env = readEnvFile(path);
    if (!env) {
      println('  not found or not readable as this user\n');
      continue;
    }
    for (const [key, value] of Object.entries(env)) {
      const display = SECRET_KEYS.has(key) ? (value ? '<set>' : '<empty>') : value;
      println(`  ${key}=${display}`);
    }
    println('');
  }
}

function cmdUpdate() {
  println('`sentinel update` is not yet implemented.');
  println('There is no release channel to update from yet — this repository');
  println('has no versioned releases. Pull the latest source and re-run the');
  println('installer to upgrade in place; it is idempotent and will not');
  println('touch your existing configuration or database.');
  process.exit(1);
}

async function cmdUninstall(args) {
  requireRoot('uninstall');
  const purge = args.includes('--purge');
  const assumeYes = args.includes('--yes') || args.includes('-y');

  println('This will stop and disable sentinel-agent and sentinel-server,');
  println('and remove their systemd unit files and installed application code.');
  if (purge) {
    println('--purge was given: configuration (/etc/sentinel) and the');
    println('database (/var/lib/sentinel) will ALSO be permanently deleted.');
  } else {
    println('Configuration and the database will be preserved.');
    println('(Pass --purge to remove those too.)');
  }

  if (!assumeYes && !(await confirm('Continue?'))) {
    println('Aborted.');
    return;
  }

  try { systemd.stop(['sentinel-server']); } catch { /* may already be stopped */ }
  try { systemd.stop(['sentinel-agent']); } catch { /* may already be stopped */ }
  try { systemd.disable(); } catch { /* may already be disabled */ }

  for (const unit of systemd.UNITS) {
    const unitFile = `${paths.SYSTEMD_UNIT_DIR}/${unit}.service`;
    try { fs.unlinkSync(unitFile); } catch { /* not present */ }
  }
  try { systemd.daemonReload(); } catch { /* best effort */ }

  fs.rmSync(paths.APP_DIR, { recursive: true, force: true });

  // The symlink now points at deleted code — remove it too, rather than
  // leaving `sentinel` resolvable-but-broken until a future reinstall.
  // Safe to do even though this script IS that symlink's target: Node
  // already has the source loaded, so execution continues fine.
  fs.rmSync('/usr/local/bin/sentinel', { force: true });

  if (purge) {
    fs.rmSync(paths.CONFIG_DIR, { recursive: true, force: true });
    fs.rmSync(paths.DATA_DIR, { recursive: true, force: true });
  }

  println('\nSentinel has been uninstalled.');
  if (!purge) {
    println(`Configuration is still at ${paths.CONFIG_DIR}, database at ${paths.DATA_DIR}.`);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────

const USAGE = `Usage: sentinel <command> [options]

Commands:
  status              Show service status
  start               Start sentinel-agent and sentinel-server
  stop                Stop sentinel-server and sentinel-agent
  restart             Restart both services
  logs [agent|server] [--follow]   Show/tail logs
  doctor              Run health checks
  config              Show current (non-secret) configuration
  update              Update Sentinel (not yet implemented)
  uninstall [--purge] [--yes]      Remove Sentinel
`;

async function main() {
  const [, , command, ...args] = process.argv;

  switch (command) {
    case 'status':    return cmdStatus();
    case 'start':     return cmdStart();
    case 'stop':      return cmdStop();
    case 'restart':   return cmdRestart();
    case 'logs':      return cmdLogs(args);
    case 'doctor':    return cmdDoctor();
    case 'config':    return cmdConfig();
    case 'update':    return cmdUpdate();
    case 'uninstall': return cmdUninstall(args);
    default:
      println(USAGE);
      process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  console.error('sentinel:', err.message);
  process.exit(1);
});
