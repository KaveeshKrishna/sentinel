'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = path.join(os.tmpdir(), `sentinel-test-notifycfg-${crypto.randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;
process.env.SENTINEL_SECRET_KEY = crypto.randomBytes(32).toString('hex');

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { migrate } = require('../db/migrate');
const { getDb } = require('../db/connection');
const {
  getNotifyConfig, setNotifyConfig, clearNotifyConfig, getDecryptedUrls, DEFAULT_EVENTS
} = require('./notifyConfig');

const SLACK_URL = 'https://hooks.slack.com/services/T000/B000/abcdef123456';

before(() => migrate());
beforeEach(() => clearNotifyConfig());
after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(DB_PATH + suffix); } catch { /* already gone */ }
  }
});

test('nothing is configured by default, with a sensible default event set', () => {
  const config = getNotifyConfig();
  assert.equal(config.channels.slack.configured, false);
  assert.equal(config.approveLinks, false, 'one-click approval must be opt-in');
  assert.deepEqual(config.events, DEFAULT_EVENTS);
});

test('a webhook URL round-trips but is never returned in full', () => {
  setNotifyConfig({ slackUrl: SLACK_URL });

  const config = getNotifyConfig();
  assert.equal(config.channels.slack.configured, true);
  assert.equal(config.channels.slack.masked, 'hooks.slack.com…123456');
  assert.ok(!JSON.stringify(config).includes(SLACK_URL), 'the raw URL must never reach a client');

  assert.equal(getDecryptedUrls().slack, SLACK_URL);
});

test('the URL is encrypted at rest, not stored in plaintext', () => {
  // Anyone holding a Slack webhook URL can post to that channel as
  // Sentinel, so it gets the same treatment as the AI provider key.
  setNotifyConfig({ slackUrl: SLACK_URL });
  const raw = getDb().prepare("SELECT value FROM settings WHERE key = 'notify.slackUrlEnc'").get();
  assert.ok(raw.value.length > 0);
  assert.ok(!raw.value.includes('hooks.slack.com'));
});

test('an omitted URL is preserved; an empty string clears it', () => {
  setNotifyConfig({ slackUrl: SLACK_URL });
  setNotifyConfig({ events: ['INCIDENT_RESOLVED'] });
  assert.equal(getDecryptedUrls().slack, SLACK_URL, 'a save without the URL keeps it');

  setNotifyConfig({ slackUrl: '' });
  assert.equal(getNotifyConfig().channels.slack.configured, false);
  assert.equal(getDecryptedUrls().slack, undefined);
});

test('a non-https webhook URL is rejected', () => {
  assert.throws(() => setNotifyConfig({ slackUrl: 'http://insecure.example.com/hook' }), /https/);
  assert.throws(() => setNotifyConfig({ discordUrl: 'javascript:alert(1)' }), /https/);
});

test('unknown events are rejected rather than silently dropped', () => {
  assert.throws(() => setNotifyConfig({ events: ['NOT_A_REAL_EVENT'] }), /Unknown event/);
  assert.throws(() => setNotifyConfig({ events: 'INCIDENT_RESOLVED' }), /must be an array/);
});

test('events are de-duplicated and persisted', () => {
  setNotifyConfig({ events: ['INCIDENT_RESOLVED', 'INCIDENT_RESOLVED', 'INCIDENT_FAILED'] });
  assert.deepEqual(getNotifyConfig().events, ['INCIDENT_RESOLVED', 'INCIDENT_FAILED']);
});

test('a malformed events row falls back to the defaults instead of throwing', () => {
  getDb().prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('notify.events', '{not json', ?)")
    .run(Date.now());
  assert.deepEqual(getNotifyConfig().events, DEFAULT_EVENTS);
});

test('baseUrl is normalised and validated', () => {
  setNotifyConfig({ baseUrl: 'https://sentinel.example.com/' });
  assert.equal(getNotifyConfig().baseUrl, 'https://sentinel.example.com');
  assert.throws(() => setNotifyConfig({ baseUrl: 'sentinel.example.com' }), /must start with/);
});

test('approve links cannot be enabled without a public base URL to build them from', () => {
  assert.throws(() => setNotifyConfig({ approveLinks: true }), /base URL/);

  setNotifyConfig({ baseUrl: 'https://sentinel.example.com' });
  setNotifyConfig({ approveLinks: true });
  assert.equal(getNotifyConfig().approveLinks, true);

  setNotifyConfig({ approveLinks: false });
  assert.equal(getNotifyConfig().approveLinks, false);
});

test('clearNotifyConfig removes every channel and setting', () => {
  setNotifyConfig({ slackUrl: SLACK_URL, discordUrl: 'https://discord.com/api/webhooks/1/xyz', baseUrl: 'https://x.example.com' });
  setNotifyConfig({ approveLinks: true });

  const config = clearNotifyConfig();
  assert.equal(config.channels.slack.configured, false);
  assert.equal(config.channels.discord.configured, false);
  assert.equal(config.approveLinks, false);
  assert.equal(config.baseUrl, '');
  assert.deepEqual(getDecryptedUrls(), {});
});
