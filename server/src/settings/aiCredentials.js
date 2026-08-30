'use strict';

const { getDb } = require('../db/connection');
const { encrypt, decrypt } = require('../crypto/aesGcm');

const PROVIDERS = ['anthropic', 'gemini', 'openai-compatible'];

/** Guard against a paste-the-whole-file accident, not a security control. */
const MAX_KEY_LEN = 4096;
const MAX_LABEL_LEN = 60;

function keySuffix(rawKey) {
  if (!rawKey) return null;
  return rawKey.length <= 4 ? rawKey : rawKey.slice(-4);
}

/**
 * The browser-safe shape. Never includes the key — only its last 4
 * characters, the same contract `GET /api/settings/ai` has always had.
 */
function toPublic(row) {
  let suffix = null;
  try {
    suffix = keySuffix(decrypt(row.api_key_enc));
  } catch {
    // A row encrypted under a secret.key that has since been replaced.
    // Surface it as unusable rather than throwing the whole list away.
    suffix = null;
  }
  return {
    id: row.id,
    label: row.label,
    provider: row.provider,
    model: row.model || null,
    baseUrl: row.base_url || null,
    keySuffix: suffix,
    priority: row.priority,
    enabled: !!row.enabled,
    lastError: row.last_error || null,
    lastErrorAt: row.last_error_at || null,
    lastOkAt: row.last_ok_at || null,
    rpmLimit: row.rpm_limit ?? null,
    rpdLimit: row.rpd_limit ?? null,
    cooldownUntil: row.cooldown_until || null,
    // Live counters so the Settings page can show "3 of 20 today used"
    // rather than the operator discovering a limit by hitting it.
    usage: usageFor(row.id)
  };
}

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Requests actually spent on this credential, counted from `ai_runs` so
 * the budget survives a restart. A provider's own window is a rolling
 * one, so this is too — a fixed calendar day would let a burst at
 * midnight double the real allowance.
 */
function usageFor(credentialId) {
  if (!credentialId) return { lastMinute: 0, lastDay: 0 };
  const now = Date.now();
  const row = getDb().prepare(`
    SELECT
      SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS minute,
      SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS day
    FROM ai_credential_calls WHERE credential_id = ?
  `).get(now - MINUTE_MS, now - DAY_MS, credentialId);
  return { lastMinute: row.minute || 0, lastDay: row.day || 0 };
}

/**
 * Count one request against a credential's budget. Called by
 * ai/failover.js for every attempt it makes — including a failed one,
 * because a rejected request still consumes most providers' quota.
 * Rows older than the widest window are dropped on write, so this table
 * stays small without needing a separate sweep.
 */
function recordCall(credentialId) {
  if (!credentialId) return;
  const db = getDb();
  const now = Date.now();
  db.prepare('INSERT INTO ai_credential_calls (credential_id, created_at) VALUES (?, ?)').run(credentialId, now);
  db.prepare('DELETE FROM ai_credential_calls WHERE created_at < ?').run(now - DAY_MS);
}

/**
 * Why this credential can't be used right now, or null if it can.
 *
 * Checked BEFORE a request is made. Spending a call to be told 429 costs
 * the quota and fails the call; skipping straight to the next credential
 * costs neither.
 */
function budgetBlock(credential) {
  const now = Date.now();
  if (credential.cooldownUntil && credential.cooldownUntil > now) {
    const secs = Math.ceil((credential.cooldownUntil - now) / 1000);
    return `rate-limited by the provider — retrying in ${secs}s`;
  }
  const usage = credential.usage || usageFor(credential.id);
  if (credential.rpmLimit && usage.lastMinute >= credential.rpmLimit) {
    return `local limit reached (${credential.rpmLimit}/min)`;
  }
  if (credential.rpdLimit && usage.lastDay >= credential.rpdLimit) {
    return `local limit reached (${credential.rpdLimit}/day)`;
  }
  return null;
}

function allRows() {
  return getDb()
    .prepare('SELECT * FROM ai_credentials ORDER BY priority ASC, id ASC')
    .all();
}

/** Every credential, in failover order, browser-safe. */
function listCredentials() {
  return allRows().map(toPublic);
}

function getCredential(id) {
  const row = getDb().prepare('SELECT * FROM ai_credentials WHERE id = ?').get(id);
  return row ? toPublic(row) : null;
}

/**
 * Internal-only: the enabled credentials in failover order, each with its
 * plaintext API key. Never return one of these from a route handler.
 * A row whose ciphertext no longer decrypts is skipped rather than
 * throwing — one unusable key must not take the whole chain down.
 */
function listUsableCredentials() {
  const usable = [];
  for (const row of allRows()) {
    if (!row.enabled) continue;
    let apiKey;
    try {
      apiKey = decrypt(row.api_key_enc);
    } catch {
      continue;
    }
    if (!apiKey) continue;
    usable.push({
      id: row.id,
      label: row.label,
      provider: row.provider,
      model: row.model || null,
      baseUrl: row.base_url || null,
      priority: row.priority,
      rpmLimit: row.rpm_limit ?? null,
      rpdLimit: row.rpd_limit ?? null,
      cooldownUntil: row.cooldown_until || null,
      usage: usageFor(row.id),
      apiKey
    });
  }
  return usable;
}

/**
 * Internal-only: one credential with its plaintext key, regardless of
 * whether it is enabled — a disabled row is still testable, which is how
 * an operator checks a replacement key before putting it back in the
 * chain. Returns null when the row is missing or no longer decrypts.
 */
function getCredentialSecret(id) {
  const row = getDb().prepare('SELECT * FROM ai_credentials WHERE id = ?').get(id);
  if (!row) return null;
  let apiKey;
  try {
    apiKey = decrypt(row.api_key_enc);
  } catch {
    return null;
  }
  if (!apiKey) return null;
  return {
    id: row.id, label: row.label, provider: row.provider,
    model: row.model || null, baseUrl: row.base_url || null, apiKey
  };
}

function validate({ label, provider, model, baseUrl, apiKey }, { requireKey }) {
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`Unknown AI provider "${provider}" — must be one of ${PROVIDERS.join(', ')}`);
  }
  if (label != null && String(label).length > MAX_LABEL_LEN) {
    throw new Error(`Label must be ${MAX_LABEL_LEN} characters or fewer`);
  }
  if (requireKey && !apiKey) throw new Error('apiKey is required');
  if (apiKey && String(apiKey).length > MAX_KEY_LEN) throw new Error('API key is implausibly long');
  if (model != null && String(model).length > 200) throw new Error('Model name is too long');
  if (baseUrl) {
    let parsed;
    try {
      parsed = new URL(String(baseUrl));
    } catch {
      throw new Error('Base URL must be a valid URL');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Base URL must be http or https');
    }
  }
}

function nextPriority() {
  const row = getDb().prepare('SELECT MAX(priority) AS p FROM ai_credentials').get();
  return row.p === null ? 0 : row.p + 1;
}

function addCredential({ label, provider, model, baseUrl, apiKey, enabled = true, rpmLimit, rpdLimit }) {
  validate({ label, provider, model, baseUrl, apiKey }, { requireKey: true });
  const now = Date.now();
  const id = getDb().prepare(`
    INSERT INTO ai_credentials (label, provider, model, base_url, api_key_enc, priority, enabled,
                                rpm_limit, rpd_limit, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    label || defaultLabel(provider), provider, model || null, baseUrl || null,
    encrypt(apiKey), nextPriority(), enabled ? 1 : 0,
    normalizeLimit(rpmLimit), normalizeLimit(rpdLimit), now, now
  ).lastInsertRowid;
  return getCredential(id);
}

/** A limit is a positive integer or "no limit"; 0 and junk both mean none. */
function normalizeLimit(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function defaultLabel(provider) {
  const n = getDb().prepare('SELECT COUNT(*) c FROM ai_credentials WHERE provider = ?').get(provider).c;
  return n === 0 ? provider : `${provider} #${n + 1}`;
}

/**
 * Partial update. An omitted (or blank) `apiKey` keeps the stored one —
 * matching the "leave blank to keep the saved key" semantics the single
 * -provider form already had.
 */
function updateCredential(id, { label, provider, model, baseUrl, apiKey, enabled, rpmLimit, rpdLimit }) {
  const existing = getDb().prepare('SELECT * FROM ai_credentials WHERE id = ?').get(id);
  if (!existing) throw new Error(`No AI credential with id ${id}`);

  const next = {
    label: label !== undefined ? label : existing.label,
    provider: provider !== undefined ? provider : existing.provider,
    model: model !== undefined ? model : existing.model,
    baseUrl: baseUrl !== undefined ? baseUrl : existing.base_url,
    enabled: enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
    rpmLimit: rpmLimit !== undefined ? normalizeLimit(rpmLimit) : existing.rpm_limit,
    rpdLimit: rpdLimit !== undefined ? normalizeLimit(rpdLimit) : existing.rpd_limit
  };
  validate({ ...next, apiKey }, { requireKey: false });

  getDb().prepare(`
    UPDATE ai_credentials
       SET label = ?, provider = ?, model = ?, base_url = ?, enabled = ?,
           rpm_limit = ?, rpd_limit = ?,
           api_key_enc = COALESCE(?, api_key_enc), updated_at = ?
     WHERE id = ?
  `).run(
    next.label, next.provider, next.model || null, next.baseUrl || null, next.enabled,
    next.rpmLimit, next.rpdLimit,
    apiKey ? encrypt(apiKey) : null, Date.now(), id
  );

  // A key or endpoint change invalidates whatever the last failure said.
  if (apiKey || provider !== undefined || baseUrl !== undefined || model !== undefined) {
    clearHealth(id);
  }
  return getCredential(id);
}

function deleteCredential(id) {
  return getDb().prepare('DELETE FROM ai_credentials WHERE id = ?').run(id).changes > 0;
}

/**
 * Set the failover order from an explicit list of ids, first = tried
 * first. Ids not mentioned keep their relative order after the listed
 * ones, so a partial list (a single row moved up in the UI) can't
 * silently drop a credential out of the chain.
 */
function reorderCredentials(ids) {
  if (!Array.isArray(ids)) throw new Error('ids must be an array');
  const db = getDb();
  const known = allRows().map(r => r.id);
  const seen = new Set();
  const ordered = [];
  for (const raw of ids) {
    const id = Number(raw);
    if (!known.includes(id)) throw new Error(`No AI credential with id ${raw}`);
    if (seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }
  for (const id of known) if (!seen.has(id)) ordered.push(id);

  const update = db.prepare('UPDATE ai_credentials SET priority = ?, updated_at = ? WHERE id = ?');
  const now = Date.now();
  db.transaction(() => {
    ordered.forEach((id, index) => update.run(index, now, id));
  })();
  return listCredentials();
}

/**
 * How long to stop using a credential the provider has rate-limited.
 * A 429 means "you are over your allowance"; asking again immediately is
 * guaranteed to fail and, on some providers, extends the penalty. Daily
 * caps are the painful case (Gemini's free tier is 20/day), so the
 * backoff climbs to a length that outlives a per-minute window without
 * writing off the whole day.
 */
const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;

/** Record why this credential was skipped, for the Settings page. */
function recordFailure(id, message) {
  const text = String(message || 'Unknown error').slice(0, 500);
  const rateLimited = /\(429\)|rate.?limit|quota|resource.?exhausted|too many requests/i.test(text);
  getDb().prepare(`
    UPDATE ai_credentials
       SET last_error = ?, last_error_at = ?,
           cooldown_until = CASE WHEN ? THEN ? ELSE cooldown_until END
     WHERE id = ?
  `).run(text, Date.now(), rateLimited ? 1 : 0, Date.now() + RATE_LIMIT_COOLDOWN_MS, id);
}

/**
 * A success clears the stale failure AND the "already told the operator"
 * marker, so if this credential fails again later that IS worth a fresh
 * notification — it's new information, not the same outage repeating.
 */
function recordSuccess(id) {
  getDb().prepare(`
    UPDATE ai_credentials
       SET last_ok_at = ?, last_error = NULL, last_error_at = NULL,
           cooldown_until = NULL, notified_error = NULL
     WHERE id = ?
  `).run(Date.now(), id);
}

/**
 * Has the operator already been told about this exact failure on this
 * credential? Returns true the FIRST time a given error is seen and
 * marks it; false every repeat. This is what stops a key that is out of
 * quota producing an identical notification on every subsequent request
 * — the operator needs to be told once, not once per background poll.
 */
function shouldNotifyFailure(id, message) {
  if (!id) return true;
  const text = String(message || 'Unknown error').slice(0, 500);
  const row = getDb().prepare('SELECT notified_error FROM ai_credentials WHERE id = ?').get(id);
  if (row && row.notified_error === text) return false;
  getDb().prepare('UPDATE ai_credentials SET notified_error = ? WHERE id = ?').run(text, id);
  return true;
}

function clearHealth(id) {
  getDb().prepare(
    'UPDATE ai_credentials SET last_error = NULL, last_error_at = NULL, cooldown_until = NULL, notified_error = NULL WHERE id = ?'
  ).run(id);
}

function countUsable() {
  return listUsableCredentials().length;
}

module.exports = {
  PROVIDERS,
  listCredentials, getCredential, getCredentialSecret, listUsableCredentials, countUsable,
  addCredential, updateCredential, deleteCredential, reorderCredentials,
  recordFailure, recordSuccess, clearHealth, shouldNotifyFailure,
  budgetBlock, usageFor, recordCall, RATE_LIMIT_COOLDOWN_MS
};
