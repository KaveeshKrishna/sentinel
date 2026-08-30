/**
 * The demo's mutable world, persisted per-visitor in localStorage.
 *
 * Everything the mock server reads or writes lives here. It is seeded from
 * buildFixtures() on first load and after "Reset demo". Nothing here ever
 * touches a real backend — the demo build has none.
 */
import { buildFixtures } from './fixtures.js';

const STATE_KEY = 'sentinel-demo-state-v1';
const AUTH_KEY = 'sentinel-demo-authed';
const NOTE_KEY = 'sentinel-demo-note-seen';

let state = null;

function load() {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* private mode / corrupt — fall through to a fresh world */ }
  return buildFixtures();
}

export function initState() {
  if (!state) state = load();
  return state;
}

export function getState() {
  return state || initState();
}

export function save() {
  try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch { /* ignore quota / private mode */ }
}

/** Mutate a slice and persist in one call. */
export function mutate(fn) {
  fn(getState());
  save();
}

export function nextId(kind) {
  const s = getState();
  s.nextId[kind] = (s.nextId[kind] || 1) + 1;
  return s.nextId[kind];
}

export function resetDemo() {
  try {
    localStorage.removeItem(STATE_KEY);
    localStorage.removeItem(NOTE_KEY);
  } catch { /* ignore */ }
  state = null;
  location.reload();
}

// ─── auth (demo/demo) ────────────────────────────────────────────────────────
export function isDemoAuthed() {
  try { return localStorage.getItem(AUTH_KEY) === '1'; } catch { return false; }
}
export function setDemoAuthed(on) {
  try {
    if (on) localStorage.setItem(AUTH_KEY, '1');
    else localStorage.removeItem(AUTH_KEY);
  } catch { /* ignore */ }
}

// ─── one-time notice ─────────────────────────────────────────────────────────
export function noteSeen() {
  try { return localStorage.getItem(NOTE_KEY) === '1'; } catch { return true; }
}
export function markNoteSeen() {
  try { localStorage.setItem(NOTE_KEY, '1'); } catch { /* ignore */ }
}
