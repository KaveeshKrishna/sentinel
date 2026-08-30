'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = path.join(os.tmpdir(), `sentinel-test-aiconfig-${crypto.randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;
process.env.SENTINEL_SECRET_KEY = crypto.randomBytes(32).toString('hex');

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { migrate } = require('../db/migrate');
const { getAIConfig, setAIConfig, clearAIConfig, getDecryptedAPIKey } = require('./aiConfig');

before(() => migrate());
after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(DB_PATH + suffix); } catch { /* already gone */ }
  }
});
beforeEach(() => {
  clearAIConfig();
  delete process.env.AI_PROVIDER;
  delete process.env.AI_MODEL;
  delete process.env.AI_API_KEY;
  delete process.env.AI_BASE_URL;
});

test('getAIConfig reports unconfigured when nothing is set', () => {
  assert.equal(getAIConfig().configured, false);
});

test('setAIConfig rejects an unknown provider', () => {
  assert.throws(() => setAIConfig({ provider: 'not-a-real-provider', apiKey: 'x' }), /Unknown AI provider/);
});

test('setAIConfig + getAIConfig round-trips provider/model/baseUrl and never leaks the raw key', () => {
  setAIConfig({ provider: 'anthropic', model: 'claude-sonnet-5', baseUrl: '', apiKey: 'sk-ant-abc123456789' });
  const cfg = getAIConfig();
  assert.equal(cfg.configured, true);
  assert.equal(cfg.provider, 'anthropic');
  assert.equal(cfg.model, 'claude-sonnet-5');
  assert.equal(cfg.keySuffix, '6789');
  assert.ok(!JSON.stringify(cfg).includes('sk-ant-abc123456789'));
});

test('getDecryptedAPIKey returns the real key for internal use', () => {
  setAIConfig({ provider: 'openai-compatible', model: 'gpt-x', baseUrl: 'https://api.example.com', apiKey: 'real-key-value' });
  assert.equal(getDecryptedAPIKey(), 'real-key-value');
});

test('falls back to env vars when nothing has been saved', () => {
  process.env.AI_PROVIDER = 'gemini';
  process.env.AI_MODEL = 'gemini-pro';
  process.env.AI_API_KEY = 'env-key-9999';
  const cfg = getAIConfig();
  assert.equal(cfg.configured, true);
  assert.equal(cfg.provider, 'gemini');
  assert.equal(cfg.keySuffix, '9999');
  assert.equal(getDecryptedAPIKey(), 'env-key-9999');
});

test('clearAIConfig removes a saved configuration', () => {
  setAIConfig({ provider: 'anthropic', model: 'x', baseUrl: '', apiKey: 'k' });
  clearAIConfig();
  assert.equal(getAIConfig().configured, false);
});
