'use strict';

// Regression guard for the core Phase 1 invariant: no shell-string
// interpolation (execSync, or the nsenter container-escape pattern it
// replaced) survives anywhere in agent/ or server/. Every process spawn
// in this codebase should use execFile/spawn with an argv array instead.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function listJsFiles(dir) {
  let out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.endsWith('.test.js')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(listJsFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** Strip /* *\/ block comments and // line comments so mentioning the
 * removed nsenter pattern in an explanatory comment doesn't trip this
 * guard — only actual code should. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

test('no execSync or nsenter usage anywhere in agent/src or server/src', () => {
  const roots = [
    path.join(__dirname), // agent/src
    path.join(__dirname, '..', '..', 'server', 'src')
  ];
  const offenders = [];
  for (const root of roots) {
    for (const file of listJsFiles(root)) {
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      if (/\bexecSync\s*\(/.test(code) || /\bnsenter\b/.test(code)) {
        offenders.push(file);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
