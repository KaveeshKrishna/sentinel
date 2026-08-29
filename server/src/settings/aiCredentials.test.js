'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = path.join(os.tmpdir(), `sentinel-test-aicreds-${crypto.randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;
process.env.SENTINEL_SECRET_KEY = crypto.randomBytes(32).toString('hex');

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { migrate } = require('../db/migrate');
const { getDb } = require('../db/connection');
const {
  listCredentials, getCredential, getCredentialSecret, listUsableCredentials,
  addCredential, updateCredential, deleteCredential, reorderCredentials,
  recordFailure, recordSuccess
} = require('./aiCredentials');

before(() => migrate());
beforeEach(() => getDb().prepare('DELETE FROM ai_credentials').run());
after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(DB_PATH + suffix); } catch { /* already gone */ }
  }
});

function seed(overrides = {}) {
  return addCredential({
    label: 'Key A', provider: 'anthropic', model: 'claude-sonnet-5',
    apiKey: 'sk-ant-aaaaaaaa1111', ...overrides
  });
}

test('a stored credential never exposes its raw key, only the last 4 characters', () => {
  const created = seed();
  assert.equal(created.keySuffix, '1111');
  assert.ok(!JSON.stringify(listCredentials()).includes('sk-ant-aaaaaaaa1111'));
  // ...but it is retrievable internally, or nothing could ever call the API.
  assert.equal(getCredentialSecret(created.id).apiKey, 'sk-ant-aaaaaaaa1111');
});

test('credentials are listed in failover order, newest appended last', () => {
  seed({ label: 'first' });
  seed({ label: 'second', apiKey: 'k2' });
  seed({ label: 'third', apiKey: 'k3' });
  assert.deepEqual(listCredentials().map(c => c.label), ['first', 'second', 'third']);
  assert.deepEqual(listCredentials().map(c => c.priority), [0, 1, 2]);
});

test('reorder moves a credential to the front of the chain', () => {
  const a = seed({ label: 'a' });
  const b = seed({ label: 'b', apiKey: 'k2' });
  const c = seed({ label: 'c', apiKey: 'k3' });
  reorderCredentials([c.id, a.id, b.id]);
  assert.deepEqual(listCredentials().map(x => x.label), ['c', 'a', 'b']);
  assert.deepEqual(listUsableCredentials().map(x => x.label), ['c', 'a', 'b']);
});

test('a partial reorder keeps unlisted credentials in the chain rather than dropping them', () => {
  const a = seed({ label: 'a' });
  const b = seed({ label: 'b', apiKey: 'k2' });
  const c = seed({ label: 'c', apiKey: 'k3' });
  // The UI's "move up" only ever names the rows it moved.
  reorderCredentials([c.id]);
  assert.deepEqual(listCredentials().map(x => x.label), ['c', 'a', 'b']);
  assert.equal(listCredentials().length, 3, 'nothing silently fell out of the failover chain');
  assert.ok(getCredential(a.id) && getCredential(b.id));
});

test('reorder rejects an unknown id instead of silently reindexing', () => {
  seed();
  assert.throws(() => reorderCredentials([9999]), /No AI credential/);
  assert.throws(() => reorderCredentials('not-an-array'), /must be an array/);
});

test('a disabled credential is excluded from the failover chain but still readable', () => {
  const a = seed({ label: 'a' });
  const b = seed({ label: 'b', apiKey: 'k2' });
  updateCredential(a.id, { enabled: false });
  assert.deepEqual(listUsableCredentials().map(x => x.label), ['b']);
  assert.equal(getCredential(a.id).enabled, false);
  // Still testable — that is how a replacement key gets validated.
  assert.equal(getCredentialSecret(a.id).apiKey, 'sk-ant-aaaaaaaa1111');
});

test('updating with a blank apiKey keeps the stored key', () => {
  const a = seed();
  updateCredential(a.id, { model: 'claude-opus-5' });
  assert.equal(getCredential(a.id).model, 'claude-opus-5');
  assert.equal(getCredentialSecret(a.id).apiKey, 'sk-ant-aaaaaaaa1111');
});

test('updating the key replaces it and clears the stale failure reason', () => {
  const a = seed();
  recordFailure(a.id, 'API error (401): Invalid API key');
  assert.match(getCredential(a.id).lastError, /401/);

  updateCredential(a.id, { apiKey: 'sk-ant-newkey9999' });
  assert.equal(getCredential(a.id).keySuffix, '9999');
  assert.equal(getCredential(a.id).lastError, null, 'a new key is not still blamed for the old one failing');
});

test('recordFailure/recordSuccess track why a credential is being skipped', () => {
  const a = seed();
  assert.equal(getCredential(a.id).lastError, null);

  recordFailure(a.id, 'Gemini API error (429): quota exhausted');
  const failed = getCredential(a.id);
  assert.match(failed.lastError, /quota exhausted/);
  assert.ok(failed.lastErrorAt > 0);

  recordSuccess(a.id);
  const ok = getCredential(a.id);
  assert.equal(ok.lastError, null, 'a working key stops showing a stale error');
  assert.ok(ok.lastOkAt > 0);
});

test('validation rejects a bad provider, a non-http base URL and a missing key', () => {
  assert.throws(() => addCredential({ provider: 'not-real', apiKey: 'k' }), /Unknown AI provider/);
  assert.throws(() => addCredential({ provider: 'anthropic' }), /apiKey is required/);
  assert.throws(
    () => addCredential({ provider: 'openai-compatible', apiKey: 'k', baseUrl: 'file:///etc/passwd' }),
    /must be http or https/
  );
  assert.throws(
    () => addCredential({ provider: 'openai-compatible', apiKey: 'k', baseUrl: 'not a url' }),
    /valid URL/
  );
});

test('a credential whose ciphertext no longer decrypts is skipped, not fatal to the whole chain', () => {
  const broken = seed({ label: 'broken' });
  const good = seed({ label: 'good', apiKey: 'k2' });
  getDb().prepare('UPDATE ai_credentials SET api_key_enc = ? WHERE id = ?').run('garbage-not-ciphertext', broken.id);

  const usable = listUsableCredentials();
  assert.deepEqual(usable.map(c => c.label), ['good'], 'one unreadable key does not take the chain down');
  // It still lists, so the operator can see and fix it.
  assert.equal(listCredentials().length, 2);
  assert.equal(getCredential(broken.id).keySuffix, null);
  assert.equal(getCredentialSecret(broken.id), null);
});

test('deleting a credential removes it from the chain', () => {
  const a = seed({ label: 'a' });
  seed({ label: 'b', apiKey: 'k2' });
  assert.equal(deleteCredential(a.id), true);
  assert.equal(deleteCredential(a.id), false, 'deleting a missing row reports it rather than throwing');
  assert.deepEqual(listCredentials().map(c => c.label), ['b']);
});
