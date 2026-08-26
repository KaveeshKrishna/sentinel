'use strict';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';

/**
 * Google Gemini adapter. Uses generationConfig.responseMimeType +
 * responseSchema for structured output — `text` comes back as a JSON
 * string, so it's returned as-is; no separate tool-call concept is used.
 */
async function chat({ system, messages, responseSchema, apiKey, model, baseUrl, fetchImpl = fetch }) {
  const body = {
    systemInstruction: system ? { parts: [{ text: system }] } : undefined,
    contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    // Gemini's responseSchema dialect is an OpenAPI-3 subset — it doesn't
    // accept every JSON Schema keyword (e.g. additionalProperties).
    // responseMimeType alone (json output, unconstrained shape) is what's
    // actually relied on here; the orchestrator's own ajv validation is
    // still the real gate before anything is trusted.
    generationConfig: responseSchema ? { responseMimeType: 'application/json' } : undefined
  };

  const url = `${baseUrl || DEFAULT_BASE_URL}/v1beta/models/${model || 'gemini-2.0-flash'}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const json = await res.json();
  if (!res.ok) throw new Error(`Gemini API error (${res.status}): ${json?.error?.message || JSON.stringify(json)}`);

  const text = json.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';

  return {
    text,
    toolCalls: [],
    usage: {
      promptTokens: json.usageMetadata?.promptTokenCount ?? null,
      completionTokens: json.usageMetadata?.candidatesTokenCount ?? null
    }
  };
}

module.exports = { chat };
