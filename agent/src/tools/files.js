'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

/**
 * Read-only filesystem inspection, confined to caller-supplied roots.
 *
 * Architecture decision #4 says dangerous operations are made
 * *unrequestable* rather than merely denied, and until now that included
 * reading files at all — there was no file tool in the registry, so no
 * prompt could ask for one. That was the right default, but it also
 * meant Ask Sentinel could not answer questions about anything that
 * isn't a metric, a container or a unit: a config file, an application
 * log outside Docker, a deploy artifact.
 *
 * These tools reopen exactly that much and no more:
 *
 *   - READ_ONLY, all three. Nothing here writes, moves, deletes or
 *     executes. There is still no file-write tool to ask for.
 *   - Confined to `roots` passed by the caller (the server's
 *     user-configured allowlist, empty by default — nothing is readable
 *     until the operator adds a path in Settings).
 *   - Independently narrowed by DENIED_PATTERNS below, which the caller
 *     cannot influence. Even a root of "/" cannot reach a private key,
 *     an env file, /etc/shadow, or Sentinel's own credential store. This
 *     is the invariant the agent enforces on its own behalf, in the same
 *     spirit as policy.isAuthorized() not trusting X-Sentinel-Approved.
 *   - Symlinks are resolved before the containment check, so a link
 *     inside an allowed directory cannot be used to step outside it.
 *   - Every read is size-capped, so a tool call can't pull a multi-GB
 *     file into the model's context or the agent's memory.
 */

/**
 * Paths that are never readable, whatever roots the caller passes.
 * Matched against the fully-resolved path.
 */
const DENIED_PATTERNS = [
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.gnupg(\/|$)/,
  /(^|\/)\.aws(\/|$)/,
  /(^|\/)\.kube(\/|$)/,
  /(^|\/)\.docker\/config\.json$/,
  /(^|\/)\.git-credentials$/,
  /(^|\/)\.netrc$/,
  /(^|\/)\.env(\.[\w-]+)?$/,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /^\/etc\/(shadow|gshadow|sudoers)(\/|$)/,
  /^\/etc\/sudoers\.d(\/|$)/,
  /^\/etc\/ssh(\/|$)/,
  /^\/etc\/ssl\/private(\/|$)/,
  /^\/etc\/sentinel(\/|$)/,       // our own tokens, JWT and encryption keys
  /^\/var\/lib\/sentinel(\/|$)/,  // the database: session rows, encrypted keys
  /^\/proc\/\d+\/environ$/,       // another process's environment = its secrets
  /^\/root(\/|$)/
];

/** Files whose *content* is never returned, even inside an allowed root. */
function isDenied(resolvedPath) {
  return DENIED_PATTERNS.some(re => re.test(resolvedPath));
}

const MAX_READ_BYTES = 256 * 1024;
const MAX_ENTRIES = 500;
const MAX_MATCHES = 100;
const MAX_SEARCH_FILES = 2000;

function normalizeRoots(roots) {
  if (!Array.isArray(roots)) return [];
  return roots
    .filter(r => typeof r === 'string' && r.startsWith('/'))
    .map(r => path.resolve(r));
}

/**
 * Resolve a requested path and prove it is inside an allowed root and
 * not denied. Throws with an operator-readable reason otherwise —
 * the model sees this text, so it must say what to do, not just "no".
 */
function resolveAllowed(requested, roots) {
  if (typeof requested !== 'string' || !requested.startsWith('/')) {
    throw new Error('Path must be absolute');
  }
  const allowed = normalizeRoots(roots);
  if (allowed.length === 0) {
    throw new Error(
      'No filesystem access is configured. An operator must add an allowed directory ' +
      'under Settings → Access Scope before any file can be read.'
    );
  }

  // realpath first: a symlink inside an allowed directory must not be
  // usable as a way out of it. A path that doesn't exist yet resolves as
  // far as it can, so a missing file still reports honestly.
  let resolved;
  try {
    resolved = fs.realpathSync(requested);
  } catch {
    resolved = path.resolve(requested);
  }

  // '/' needs its own case: `resolved.startsWith('/' + path.sep)` is
  // `startsWith('//')`, which is never true, so a root of '/' would
  // otherwise match nothing. Found by testing against the live agent —
  // the outcome looked correct (access refused) but for the wrong
  // reason, which would have masked the deny list not being reached.
  const inRoot = allowed.some(root =>
    root === path.sep || resolved === root || resolved.startsWith(root + path.sep)
  );
  if (!inRoot) {
    throw new Error(
      `"${requested}" is outside every allowed directory (${allowed.join(', ')}). ` +
      'An operator can add it under Settings → Access Scope.'
    );
  }
  if (isDenied(resolved)) {
    throw new Error(`"${requested}" is in a category Sentinel will never read (keys, credentials or secret stores).`);
  }
  return resolved;
}

function describe(entry, full) {
  let stat = null;
  try {
    stat = fs.lstatSync(full);
  } catch { /* vanished between readdir and stat */ }
  return {
    name: entry,
    path: full,
    type: stat?.isDirectory() ? 'directory' : stat?.isSymbolicLink() ? 'symlink' : 'file',
    size: stat?.isFile() ? stat.size : null,
    modified: stat ? stat.mtimeMs : null
  };
}

module.exports = function registerFileTools(registry) {
  registry.register({
    name: 'list_directory',
    description:
      'List the files and subdirectories of a directory on the host. Read-only. Only works for ' +
      'directories the operator has explicitly allowed in Settings → Access Scope.',
    risk: 'READ_ONLY',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute directory path, e.g. /var/log' },
        roots: { type: 'array', items: { type: 'string' }, description: 'Allowed roots (supplied by the server)' }
      },
      required: ['path'],
      additionalProperties: false
    },
    handler: async ({ path: target, roots }) => {
      const resolved = resolveAllowed(target, roots);
      const stat = await fsp.stat(resolved);
      if (!stat.isDirectory()) throw new Error(`"${target}" is not a directory`);

      const names = (await fsp.readdir(resolved)).sort();
      const entries = names
        .slice(0, MAX_ENTRIES)
        .map(name => describe(name, path.join(resolved, name)))
        // A denied path is not listed at all: its existence is itself a
        // hint worth withholding, and it can never be read anyway.
        .filter(e => !isDenied(e.path));

      return {
        path: resolved,
        entries,
        truncated: names.length > MAX_ENTRIES,
        totalEntries: names.length
      };
    }
  });

  registry.register({
    name: 'read_file',
    description:
      'Read the contents of a text file on the host. Read-only, size-capped, and only for files ' +
      'under a directory the operator has allowed in Settings → Access Scope. Never returns keys, ' +
      'credentials or secret stores.',
    risk: 'READ_ONLY',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute file path' },
        tail: { type: 'number', description: 'Return only the last N lines (useful for logs)' },
        roots: { type: 'array', items: { type: 'string' }, description: 'Allowed roots (supplied by the server)' }
      },
      required: ['path'],
      additionalProperties: false
    },
    handler: async ({ path: target, tail, roots }) => {
      const resolved = resolveAllowed(target, roots);
      const stat = await fsp.stat(resolved);
      if (!stat.isFile()) throw new Error(`"${target}" is not a regular file`);

      // Read only the tail of a large file rather than refusing it — a
      // 2 GB log is exactly the thing worth looking at the end of.
      const start = Math.max(0, stat.size - MAX_READ_BYTES);
      const handle = await fsp.open(resolved, 'r');
      let content;
      try {
        const buffer = Buffer.alloc(Math.min(stat.size, MAX_READ_BYTES));
        await handle.read(buffer, 0, buffer.length, start);
        content = buffer.toString('utf8');
      } finally {
        await handle.close();
      }

      if (start > 0) content = content.slice(content.indexOf('\n') + 1);
      if (tail && Number.isFinite(tail)) {
        const lines = content.split('\n');
        // A file ending in a newline splits to a trailing empty element;
        // counting it would silently return one fewer line than asked for.
        if (lines[lines.length - 1] === '') lines.pop();
        content = lines.slice(-Math.floor(tail)).join('\n');
      }

      return {
        path: resolved,
        size: stat.size,
        modified: stat.mtimeMs,
        truncated: start > 0,
        content
      };
    }
  });

  registry.register({
    name: 'search_files',
    description:
      'Search for a literal string inside files under an allowed directory, returning matching ' +
      'lines with their file and line number. Read-only.',
    risk: 'READ_ONLY',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute directory to search under' },
        query: { type: 'string', description: 'Literal text to look for (not a regex)' },
        roots: { type: 'array', items: { type: 'string' }, description: 'Allowed roots (supplied by the server)' }
      },
      required: ['path', 'query'],
      additionalProperties: false
    },
    handler: async ({ path: target, query, roots }) => {
      if (!query || typeof query !== 'string') throw new Error('query is required');
      const root = resolveAllowed(target, roots);

      const matches = [];
      let filesScanned = 0;

      // Iterative walk with explicit budgets — a recursive descent over
      // an unexpectedly huge tree is how a "read-only" tool still takes
      // a host down.
      const queue = [root];
      while (queue.length > 0 && matches.length < MAX_MATCHES && filesScanned < MAX_SEARCH_FILES) {
        const dir = queue.shift();
        let names;
        try {
          names = await fsp.readdir(dir, { withFileTypes: true });
        } catch {
          continue; // unreadable directory — skip, don't fail the whole search
        }
        for (const entry of names) {
          const full = path.join(dir, entry.name);
          if (isDenied(full)) continue;
          if (entry.isDirectory()) {
            queue.push(full);
          } else if (entry.isFile()) {
            if (filesScanned >= MAX_SEARCH_FILES || matches.length >= MAX_MATCHES) break;
            filesScanned++;
            let text;
            try {
              const stat = await fsp.stat(full);
              if (stat.size > MAX_READ_BYTES) continue; // don't grep giant binaries
              text = await fsp.readFile(full, 'utf8');
            } catch {
              continue; // binary or unreadable
            }
            text.split('\n').forEach((line, i) => {
              if (matches.length < MAX_MATCHES && line.includes(query)) {
                matches.push({ path: full, line: i + 1, text: line.slice(0, 400) });
              }
            });
          }
        }
      }

      return {
        root,
        query,
        matches,
        filesScanned,
        truncated: matches.length >= MAX_MATCHES || filesScanned >= MAX_SEARCH_FILES
      };
    }
  });
};

module.exports.DENIED_PATTERNS = DENIED_PATTERNS;
module.exports.isDenied = isDenied;
module.exports.resolveAllowed = resolveAllowed;
