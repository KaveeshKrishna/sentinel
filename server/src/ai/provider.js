'use strict';

const anthropic = require('./providers/anthropic');
const gemini = require('./providers/gemini');
const openaiCompatible = require('./providers/openai-compatible');

/**
 * AIProvider interface (all adapters implement this):
 *
 *   chat({ system, messages, responseSchema, apiKey, model, baseUrl, fetchImpl })
 *     -> Promise<{ text: string, toolCalls: array, usage: { promptTokens, completionTokens } }>
 *
 * `responseSchema`, when provided, asks the provider to constrain its
 * output to that JSON Schema using whichever structured-output mechanism
 * the provider natively supports (see each adapter). `fetchImpl` defaults
 * to the global `fetch` and exists so tests can inject a fixture without
 * a live network call.
 */
const ADAPTERS = {
  anthropic,
  gemini,
  'openai-compatible': openaiCompatible
};

let testAdapter = null;

function getProvider(providerName) {
  if (testAdapter) return testAdapter;
  const adapter = ADAPTERS[providerName];
  if (!adapter) throw new Error(`Unknown AI provider "${providerName}"`);
  return adapter;
}

/** Test-only seam: inject a fake `{ chat }` adapter regardless of provider name. */
function _setProviderForTesting(adapter) {
  testAdapter = adapter;
}

function _resetProviderForTesting() {
  testAdapter = null;
}

module.exports = { getProvider, ADAPTERS, _setProviderForTesting, _resetProviderForTesting };
