'use strict';

const { getSetting, deleteSetting } = require('../db/settings');
const {
  PROVIDERS, listCredentials, listUsableCredentials,
  addCredential, updateCredential, deleteCredential
} = require('./aiCredentials');

/**
 * Single-provider facade over the credential pool (`ai_credentials`).
 *
 * Phase 3 stored exactly one provider here, in the `settings` table.
 * Sentinel now keeps an ordered list of them with automatic failover
 * (settings/aiCredentials.js, ai/failover.js), but a lot of code only
 * ever needed the questions this module already answered — "is an AI
 * provider configured at all?" (the detector's and engine's gate) and
 * "which provider/model should I name in this ai_runs row?". Those
 * callers keep working unchanged; they now read the *primary*
 * (highest-priority) credential rather than a lone one.
 *
 * The pool is the single source of truth. `settings`' old `ai.*` keys
 * are migrated into it by migration 013 and are only deleted here, never
 * written again — leaving two places that both claim to hold the
 * configured provider is exactly how they drift apart.
 */

const LEGACY_KEYS = ['ai.provider', 'ai.model', 'ai.baseUrl', 'ai.apiKeyEnc'];

function keySuffix(rawKey) {
  if (!rawKey) return null;
  return rawKey.length <= 4 ? rawKey : rawKey.slice(-4);
}

/** The first credential the failover chain would try, or null. */
function primaryCredential() {
  return listCredentials()[0] || null;
}

/**
 * Read-only view for routes and for ai_runs bookkeeping: never the raw
 * key, only a suffix. Falls back to the env-var bootstrap
 * (AI_PROVIDER/AI_MODEL/AI_API_KEY/AI_BASE_URL) when no credential has
 * been saved, computing the env key's suffix without persisting it.
 */
function getAIConfig() {
  const primary = primaryCredential();
  const usableCount = listUsableCredentials().length;

  if (primary) {
    return {
      configured: usableCount > 0,
      provider: primary.provider,
      model: primary.model,
      baseUrl: primary.baseUrl,
      keySuffix: primary.keySuffix,
      credentialCount: listCredentials().length,
      usableCount
    };
  }

  const provider = process.env.AI_PROVIDER || null;
  const hasEnvKey = !!process.env.AI_API_KEY;
  return {
    configured: !!provider && hasEnvKey,
    provider,
    model: process.env.AI_MODEL || null,
    baseUrl: process.env.AI_BASE_URL || null,
    keySuffix: hasEnvKey ? keySuffix(process.env.AI_API_KEY) : null,
    credentialCount: 0,
    usableCount: 0
  };
}

/**
 * Create or update the primary credential. Preserves the old
 * "blank apiKey keeps the saved key" semantics, which the Settings form
 * relies on.
 */
function setAIConfig({ provider, model, baseUrl, apiKey }) {
  const primary = primaryCredential();
  if (primary) {
    return updateCredential(primary.id, { provider, model: model || null, baseUrl: baseUrl || null, apiKey });
  }
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`Unknown AI provider "${provider}" — must be one of ${PROVIDERS.join(', ')}`);
  }
  return addCredential({ label: 'Primary', provider, model, baseUrl, apiKey });
}

/** Remove every saved credential (and any leftover pre-013 settings rows). */
function clearAIConfig() {
  for (const credential of listCredentials()) deleteCredential(credential.id);
  for (const key of LEGACY_KEYS) if (getSetting(key) !== null) deleteSetting(key);
}

/**
 * Internal-only: the primary credential's plaintext API key. Never
 * import this from a route handler that returns its result to the
 * client. Failover uses listUsableCredentials() instead — this is only
 * for the callers that genuinely mean "the primary one".
 */
function getDecryptedAPIKey() {
  const usable = listUsableCredentials();
  if (usable.length > 0) return usable[0].apiKey;
  return process.env.AI_API_KEY || null;
}

module.exports = { PROVIDERS, getAIConfig, setAIConfig, clearAIConfig, getDecryptedAPIKey };
