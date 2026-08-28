'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = path.join(os.tmpdir(), `sentinel-test-detectorcfg-${crypto.randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { migrate } = require('../db/migrate');
const { DEFAULTS, getDetectorConfig, setDetectorConfig, resetDetectorConfig } = require('./detectorConfig');

before(() => migrate());
beforeEach(() => resetDetectorConfig());
after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(DB_PATH + suffix); } catch { /* already gone */ }
  }
});

test('an unconfigured detector falls back to the shipped defaults', () => {
  assert.deepEqual(getDetectorConfig(), { ...DEFAULTS });
});

test('a partial update changes only the fields given', () => {
  const updated = setDetectorConfig({ cpuThresholdPercent: 75 });
  assert.equal(updated.cpuThresholdPercent, 75);
  assert.equal(updated.ramThresholdPercent, DEFAULTS.ramThresholdPercent);
  assert.equal(getDetectorConfig().cpuThresholdPercent, 75, 'must persist');
});

test('an out-of-range value is rejected rather than silently clamped', () => {
  assert.throws(() => setDetectorConfig({ cpuThresholdPercent: 0 }), /between 1 and 100/);
  assert.throws(() => setDetectorConfig({ cpuThresholdPercent: 101 }), /between 1 and 100/);
  // A 0ms cooldown would turn the detector into a firehose.
  assert.throws(() => setDetectorConfig({ cooldownMs: 0 }), /between/);
  assert.equal(getDetectorConfig().cpuThresholdPercent, DEFAULTS.cpuThresholdPercent, 'nothing persisted');
});

test('a non-numeric value is rejected', () => {
  assert.throws(() => setDetectorConfig({ resourceStreak: 'lots' }), /must be a number/);
});

test('an unknown field is rejected rather than silently stored', () => {
  assert.throws(() => setDetectorConfig({ nonsenseKnob: 5 }), /Unknown detector setting/);
});

test('null reverts one field to its default without touching the others', () => {
  setDetectorConfig({ cpuThresholdPercent: 50, ramThresholdPercent: 55 });
  const updated = setDetectorConfig({ cpuThresholdPercent: null });
  assert.equal(updated.cpuThresholdPercent, DEFAULTS.cpuThresholdPercent);
  assert.equal(updated.ramThresholdPercent, 55);
});

test('resetDetectorConfig clears everything back to defaults', () => {
  setDetectorConfig({ cpuThresholdPercent: 50, cooldownMs: 120000 });
  assert.deepEqual(resetDetectorConfig(), { ...DEFAULTS });
});
