'use strict';

const { getSetting, setSetting } = require('../db/settings');

/**
 * How much of this host Ask Sentinel is allowed to look at.
 *
 * Two independent switches, because they are genuinely different risks:
 *
 *   ownData  — Sentinel's own records (recording sessions, incidents,
 *              activity). Nothing here leaves the database Sentinel
 *              already wrote, so this is on by default; without it Ask
 *              Sentinel can't answer "summarise recording session #12",
 *              which is the obvious question to ask it.
 *
 *   paths    — directories on the host the agent's read-only file tools
 *              may look inside. Empty by default: nothing on the
 *              filesystem is readable until an operator names a
 *              directory. This is the setting that widens what the AI
 *              can see, so it is deliberately explicit, per-path, and
 *              starts closed.
 *
 * The allowlist is *policy* and lives here. The invariants that must
 * hold regardless of policy — never a key, a credential store, /root,
 * /etc/sentinel; never a write; never an escape via symlink — live in
 * the agent (agent/src/tools/files.js), which enforces them on its own
 * behalf and cannot be talked out of them by anything this file says.
 */

const KEY_OWN_DATA = 'access.ownData';
const KEY_PATHS = 'access.paths';

const MAX_PATHS = 25;

function getAccessScope() {
  const rawPaths = getSetting(KEY_PATHS);
  let paths = [];
  if (rawPaths) {
    try {
      const parsed = JSON.parse(rawPaths);
      if (Array.isArray(parsed)) paths = parsed.filter(p => p && typeof p.path === 'string');
    } catch { /* malformed row falls back to closed, which is the safe default */ }
  }
  return {
    // Absent means default-on for own data, default-closed for the host.
    ownData: getSetting(KEY_OWN_DATA) !== 'false',
    paths
  };
}

/** Just the path strings, which is what the agent's file tools want. */
function getAllowedRoots() {
  return getAccessScope().paths.map(p => p.path);
}

function validatePath(raw) {
  const value = String(raw || '').trim();
  if (!value.startsWith('/')) throw new Error('Path must be absolute (start with /)');
  if (value.includes('..')) throw new Error('Path must not contain ".."');
  if (value.includes('\0')) throw new Error('Path is not valid');
  // Trailing slashes make two spellings of the same root look distinct
  // in the UI and in the agent's containment check.
  return value.length > 1 ? value.replace(/\/+$/, '') : value;
}

function setAccessScope({ ownData, paths }) {
  if (ownData !== undefined) setSetting(KEY_OWN_DATA, ownData ? 'true' : 'false');

  if (paths !== undefined) {
    if (!Array.isArray(paths)) throw new Error('paths must be an array');
    if (paths.length > MAX_PATHS) throw new Error(`At most ${MAX_PATHS} paths`);
    const seen = new Set();
    const cleaned = [];
    for (const entry of paths) {
      const path = validatePath(typeof entry === 'string' ? entry : entry?.path);
      if (seen.has(path)) continue;
      seen.add(path);
      cleaned.push({
        path,
        label: String((typeof entry === 'object' && entry?.label) || '').slice(0, 60) || null
      });
    }
    setSetting(KEY_PATHS, JSON.stringify(cleaned));
  }
  return getAccessScope();
}

module.exports = { getAccessScope, setAccessScope, getAllowedRoots, validatePath, MAX_PATHS };
