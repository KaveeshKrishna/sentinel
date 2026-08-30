'use strict';

const { getProvider } = require('./provider');
const {
  listUsableCredentials, recordFailure, recordSuccess,
  shouldNotifyFailure, budgetBlock, recordCall
} = require('../settings/aiCredentials');
const { getAIConfig, getDecryptedAPIKey } = require('../settings/aiConfig');
const { logEvent } = require('../activity/logger');
const { publish } = require('../events/publish');

/**
 * Prioritised, self-healing provider calls.
 *
 * Every AI call in Sentinel — diagnosis, Ask Sentinel, the post-incident
 * report — goes through here rather than picking an adapter itself. The
 * credentials in `ai_credentials` are tried in ascending `priority`; the
 * first one that answers wins, and each failure is recorded against that
 * credential (so Settings can say *why* it is being skipped) before the
 * next is tried. Only when every credential has failed does the caller
 * see an error, and that error names each one's real reason.
 *
 * This exists because a single credential makes one exhausted free-tier
 * quota or one provider outage stop the whole reasoning loop — both of
 * which happened in real use (Gemini's 20/day cap; OpenRouter routing a
 * free model to an unavailable backend).
 *
 * What it deliberately does NOT do: change any safety boundary. Which
 * credential served a response has no bearing on what the model is
 * allowed to ask for — recommended actions are still cross-checked
 * against the agent's live catalog and still gated on approval
 * (Architecture decisions #12/#13), and Ask Sentinel is still refused
 * anything above READ_ONLY twice over.
 */

/**
 * Extra tries against the SAME credential before moving to the next,
 * for statuses that suggest the provider itself is flaky rather than
 * misconfigured. Retrying the same key is much cheaper than failing over
 * to a different provider/model, whose answers may differ in quality —
 * so a transient blip should not silently demote the operator's first
 * choice. 400/401/403 are excluded: those fail identically every time,
 * so the right response is to fail over immediately.
 * (Generalised from ai/chat.js, where this was found live.)
 */
const RETRYABLE_STATUS = new Set([404, 408, 409, 425, 429, 500, 502, 503, 504]);
const RETRY_DELAY_MS = 300;

function statusOf(message) {
  const m = /\((\d{3})\)/.exec(message || '');
  return m ? Number(m[1]) : null;
}

function isRetryable(message) {
  const status = statusOf(message);
  if (status !== null) return RETRYABLE_STATUS.has(status);
  // A network-level failure (DNS, refused connection, socket hang-up)
  // carries no HTTP status but is exactly the transient case.
  return /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network/i.test(message || '');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Thrown only when every configured credential has been tried and failed. */
class AllProvidersFailedError extends Error {
  constructor(failures) {
    const detail = failures.length
      ? failures.map(f => `${f.label} (${f.provider}): ${f.error}`).join(' | ')
      : 'no AI provider configured';
    super(
      failures.length === 1
        ? failures[0].error
        : `All ${failures.length} AI providers failed — ${detail}`
    );
    this.name = 'AllProvidersFailedError';
    this.failures = failures;
  }
}

/**
 * The credentials to try, in order. Falls back to the legacy
 * single-provider env-var bootstrap (AI_PROVIDER/AI_API_KEY/...) when
 * the table is empty, so an install configured only that way keeps
 * working — the migration only backfills a *saved* key.
 */
function resolveCredentials() {
  const stored = listUsableCredentials();
  if (stored.length > 0) return stored;

  const config = getAIConfig();
  const apiKey = getDecryptedAPIKey();
  if (!config.provider || !apiKey) return [];
  return [{
    id: null,
    label: 'Environment fallback',
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl,
    apiKey
  }];
}

/** True when at least one credential could be tried right now. */
function hasUsableProvider() {
  return resolveCredentials().length > 0;
}

/**
 * Tell the operator, in both places they might be looking: the Activity
 * timeline (persisted) and a live toast. The per-credential `last_error`
 * on the Settings page is written separately by recordFailure, since
 * that one must survive a page reload.
 */
function announce(type, message, details) {
  try {
    logEvent(type, message, details);
  } catch (err) {
    console.error('[ai/failover] failed to log event:', err.message);
  }
  publish('ai_provider', { type, message, ...details });
}

/**
 * The last "everything is down" state already announced.
 *
 * A totally stalled reasoning loop is worth telling the operator about,
 * but not once per background poll — the detector alone would produce
 * one every few seconds. Keyed by the set of failure reasons, so the
 * message repeats only when the *situation* changes (a different key
 * fails, or one recovers and then everything breaks again).
 *
 * In memory on purpose: after a restart, saying it once more is correct
 * — the operator may well be a different person, or have forgotten.
 */
let lastExhaustedSignature = null;

function exhaustedSignature(failures) {
  return failures.map(f => `${f.id ?? f.label}:${f.error}`).sort().join('|');
}

/**
 * One notification per credential, per distinct failure — not one per
 * request.
 *
 * Found in real use: with a primary key out of daily quota, every
 * background diagnosis, every chat turn and every detector re-drive
 * produced another identical "primary is rate limited" toast, so the
 * genuinely new information (the second key has now failed too) was
 * buried in repeats of the first. `shouldNotifyFailure` marks the
 * announced error on the row and returns false for every repeat until
 * the credential either succeeds again or fails with something
 * different — both of which are new information worth surfacing.
 */
function announceCredentialFailure(credential, errorMessage) {
  if (!shouldNotifyFailure(credential.id, errorMessage)) return;
  announce(
    'AI_PROVIDER_FAILOVER',
    `AI provider "${credential.label}" is failing — ${errorMessage}`,
    {
      credentialId: credential.id,
      label: credential.label,
      provider: credential.provider,
      failures: [{ id: credential.id, label: credential.label, provider: credential.provider, error: errorMessage }]
    }
  );
}

/**
 * Run one provider call, falling over through the credential chain.
 *
 * @param {object} chatArgs - passed to the adapter's chat(): { system,
 *   messages, responseSchema, fetchImpl }. apiKey/model/baseUrl are
 *   supplied per credential and must NOT be set here.
 * @param {object} [opts]
 * @param {string} [opts.purpose] - 'diagnosis' | 'chat' | 'report' |
 *   'test'; used only in the operator-facing message.
 * @param {boolean} [opts.retryTransient] - retry a flaky status against
 *   the same credential before failing over (see RETRYABLE_STATUS).
 * @param {(ctx: {credential, error, latencyMs, attempt}) => void} [opts.onAttemptError]
 *   - called for every failed attempt, so the caller can write its own
 *   ai_runs row in whatever shape that purpose uses. Must not throw.
 * @returns {Promise<{text, toolCalls, usage, credential}>}
 * @throws {AllProvidersFailedError}
 */
async function chatWithFailover(chatArgs, {
  purpose = 'request',
  retryTransient = false,
  onAttemptError = () => {}
} = {}) {
  const credentials = resolveCredentials();
  if (credentials.length === 0) throw new AllProvidersFailedError([]);

  const failures = [];

  for (const credential of credentials) {
    // Skipped before a request is spent: an over-budget or
    // provider-rate-limited key would fail anyway, and being told 429
    // costs the same quota as a real call on some providers.
    const blocked = budgetBlock(credential);
    if (blocked) {
      failures.push({
        id: credential.id, label: credential.label, provider: credential.provider,
        error: blocked, skipped: true
      });
      continue;
    }

    let adapter;
    try {
      adapter = getProvider(credential.provider);
    } catch (err) {
      failures.push({ id: credential.id, label: credential.label, provider: credential.provider, error: err.message });
      if (credential.id) {
        recordFailure(credential.id, err.message);
        announceCredentialFailure(credential, err.message);
      }
      continue;
    }

    const maxTries = retryTransient ? 3 : 1;
    let lastError = null;

    for (let attempt = 1; attempt <= maxTries; attempt++) {
      const startedAt = Date.now();
      // Counted before the call, not after: a request that fails still
      // consumed the provider's allowance, and a crash mid-call must not
      // leave the budget under-counting.
      recordCall(credential.id);
      try {
        const result = await adapter.chat({
          ...chatArgs,
          apiKey: credential.apiKey,
          model: credential.model,
          baseUrl: credential.baseUrl
        });
        if (credential.id) recordSuccess(credential.id);
        // Something works again, so a future total outage is new information.
        lastExhaustedSignature = null;
        return { ...result, credential, failures };
      } catch (err) {
        lastError = err;
        try {
          onAttemptError({ credential, error: err, latencyMs: Date.now() - startedAt, attempt });
        } catch (hookErr) {
          console.error('[ai/failover] onAttemptError threw:', hookErr.message);
        }
        if (attempt < maxTries && isRetryable(err.message)) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        break;
      }
    }

    failures.push({
      id: credential.id,
      label: credential.label,
      provider: credential.provider,
      error: lastError.message
    });
    if (credential.id) {
      recordFailure(credential.id, lastError.message);
      // Per credential, once per distinct failure — see
      // announceCredentialFailure. A key that has already been reported
      // as out of quota does not re-announce on every later request.
      announceCredentialFailure(credential, lastError.message);
    }
  }

  // Only when there is nothing left to fall through to — and only when
  // this is a change from the last such state, so a stalled loop under a
  // 5s detector poll doesn't produce a notification every 5 seconds.
  const signature = exhaustedSignature(failures);
  if (signature !== lastExhaustedSignature) {
    lastExhaustedSignature = signature;
    announce(
      'AI_PROVIDER_EXHAUSTED',
      failures.length === 1
        ? `AI ${purpose} failed — "${failures[0].label}": ${failures[0].error}`
        : `AI ${purpose} failed — all ${failures.length} configured providers are unavailable`,
      { purpose, failures }
    );
  }
  throw new AllProvidersFailedError(failures);
}

function _resetNotificationStateForTesting() {
  lastExhaustedSignature = null;
}

module.exports = {
  chatWithFailover, hasUsableProvider, resolveCredentials, _resetNotificationStateForTesting,
  AllProvidersFailedError, isRetryable, RETRYABLE_STATUS
};
