'use strict';

const { getSetting, setSetting, deleteSetting } = require('../db/settings');
const { encrypt, decrypt } = require('../crypto/aesGcm');

const PROVIDERS = ['anthropic', 'gemini', 'openai-compatible'];

const KEY_PROVIDER = 'ai.provider';
const KEY_MODEL = 'ai.model';
const KEY_BASE_URL = 'ai.baseUrl';
const KEY_API_KEY_ENC = 'ai.apiKeyEnc';

function keySuffix(rawKey) {
  if (!rawKey) return null;
  return rawKey.length <= 4 ? rawKey : rawKey.slice(-4);
}

/**
 * Read-only view for the frontend/routes: never the raw key, only a
 * suffix. Falls back to env vars (AI_PROVIDER/AI_MODEL/AI_API_KEY/
 * AI_BASE_URL) when nothing has been saved yet, per the original plan's
 * bootstrap fallback — the env key's suffix is computed without ever
 * persisting the env value itself.
 */
function getAIConfig() {
  const provider = getSetting(KEY_PROVIDER) || process.env.AI_PROVIDER || null;
  const model = getSetting(KEY_MODEL) || process.env.AI_MODEL || null;
  const baseUrl = getSetting(KEY_BASE_URL) || process.env.AI_BASE_URL || null;
  const encKey = getSetting(KEY_API_KEY_ENC);

  const hasSavedKey = !!encKey;
  const hasEnvKey = !hasSavedKey && !!process.env.AI_API_KEY;

  return {
    configured: !!provider && (hasSavedKey || hasEnvKey),
    provider,
    model,
    baseUrl,
    keySuffix: hasSavedKey ? keySuffix(decrypt(encKey)) : (hasEnvKey ? keySuffix(process.env.AI_API_KEY) : null)
  };
}

function setAIConfig({ provider, model, baseUrl, apiKey }) {
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`Unknown AI provider "${provider}" — must be one of ${PROVIDERS.join(', ')}`);
  }
  setSetting(KEY_PROVIDER, provider);
  setSetting(KEY_MODEL, model || '');
  setSetting(KEY_BASE_URL, baseUrl || '');
  if (apiKey) setSetting(KEY_API_KEY_ENC, encrypt(apiKey));
}

function clearAIConfig() {
  for (const key of [KEY_PROVIDER, KEY_MODEL, KEY_BASE_URL, KEY_API_KEY_ENC]) deleteSetting(key);
}

/**
 * Internal-only: the plaintext API key, for the orchestrator and the
 * settings "test connection" route. Never import this from a route
 * handler that returns its result directly to the client.
 */
function getDecryptedAPIKey() {
  const encKey = getSetting(KEY_API_KEY_ENC);
  if (encKey) return decrypt(encKey);
  return process.env.AI_API_KEY || null;
}

module.exports = { PROVIDERS, getAIConfig, setAIConfig, clearAIConfig, getDecryptedAPIKey };
