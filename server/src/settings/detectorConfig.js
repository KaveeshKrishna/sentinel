'use strict';

const { getSetting, setSetting, deleteSetting } = require('../db/settings');

/**
 * Detector tuning, promoted out of hardcoded module constants in
 * incidents/detector.js so an operator can adapt Sentinel to their own
 * host without editing source.
 *
 * These were fine as constants for one box, but they're exactly the
 * knobs that need to differ per deployment: a build server legitimately
 * sits at 95% CPU for minutes at a time, and a host with a flapping
 * service wants a much longer cooldown than 60s.
 *
 * Read through `getDetectorConfig()` on every detector tick rather than
 * cached at import: a settings change then takes effect on the next
 * poll, with no restart. The read is one indexed SQLite lookup per key
 * against a table with a handful of rows.
 */

const DEFAULTS = Object.freeze({
  cooldownMs: 60000,             // after a resource's incident resolves, wait this long before raising another
  unhealthyStreak: 2,            // consecutive polls a container must report `unhealthy`
  resourceStreak: 3,             // consecutive polls CPU/RAM must stay over threshold
  cpuThresholdPercent: 90,
  ramThresholdPercent: 90,
  diskThresholdPercent: 90,
  // How far back to look for a deploy to the same repo when gathering
  // evidence for an incident (context/deployCorrelation.js). Too short
  // and a deploy that broke something slowly (a bad migration, a cache
  // warm-up) won't be found; too long and unrelated deploys start
  // looking causally relevant.
  deployCorrelationWindowMs: 15 * 60 * 1000
});

/** Per-field bounds. A 0ms cooldown or a 1-poll streak turns the detector into a firehose. */
const LIMITS = Object.freeze({
  cooldownMs: { min: 5000, max: 24 * 60 * 60 * 1000 },
  unhealthyStreak: { min: 1, max: 60 },
  resourceStreak: { min: 1, max: 60 },
  cpuThresholdPercent: { min: 1, max: 100 },
  ramThresholdPercent: { min: 1, max: 100 },
  diskThresholdPercent: { min: 1, max: 100 },
  deployCorrelationWindowMs: { min: 60000, max: 24 * 60 * 60 * 1000 }
});

const settingKey = (field) => `detector.${field}`;

function getDetectorConfig() {
  const config = {};
  for (const [field, fallback] of Object.entries(DEFAULTS)) {
    const raw = getSetting(settingKey(field));
    const parsed = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
    config[field] = Number.isFinite(parsed) ? parsed : fallback;
  }
  return config;
}

/**
 * Persist a partial update. Unknown fields and out-of-range values are
 * rejected rather than silently clamped — a typo'd threshold that
 * quietly becomes 100 is worse than an error message.
 */
function setDetectorConfig(patch = {}) {
  const unknown = Object.keys(patch).filter(f => !(f in DEFAULTS));
  if (unknown.length) throw new Error(`Unknown detector setting(s): ${unknown.join(', ')}`);

  for (const [field, value] of Object.entries(patch)) {
    if (value === null) { deleteSetting(settingKey(field)); continue; } // null = revert to default
    const num = Number(value);
    const { min, max } = LIMITS[field];
    if (!Number.isFinite(num) || num < min || num > max) {
      throw new Error(`detector.${field} must be a number between ${min} and ${max}`);
    }
    setSetting(settingKey(field), String(num));
  }
  return getDetectorConfig();
}

function resetDetectorConfig() {
  for (const field of Object.keys(DEFAULTS)) deleteSetting(settingKey(field));
  return getDetectorConfig();
}

module.exports = { DEFAULTS, LIMITS, getDetectorConfig, setDetectorConfig, resetDetectorConfig };
