'use strict';

const { toGeminiSchema } = require('./geminiSchema');

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';

/**
 * Google Gemini adapter. Uses generationConfig.responseMimeType +
 * responseSchema for structured output — `text` comes back as a JSON
 * string, so it's returned as-is; no separate tool-call concept is used.
 */
async function chat({ system, messages, responseSchema, apiKey, model, baseUrl, fetchImpl = fetch }) {
  // Gemini's responseSchema dialect is an OpenAPI-3 subset that can't
  // express every JSON Schema (see geminiSchema.js). Where it can, send
  // it and get real provider-side enforcement; where it can't — notably
  // DIAGNOSIS_SCHEMA, whose per-action `params` is deliberately
  // free-form — fall back to responseMimeType alone rather than sending
  // a lossy conversion that would constrain the model's output shape
  // incorrectly. Either way the orchestrator's own ajv validation is
  // what actually gates whether a response is trusted.
  const geminiSchema = responseSchema ? toGeminiSchema(responseSchema) : null;

  const body = {
    systemInstruction: system ? { parts: [{ text: system }] } : undefined,
    contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    generationConfig: responseSchema
      ? {
        responseMimeType: 'application/json',
        ...(geminiSchema && { responseSchema: geminiSchema })
      }
      : undefined
  };

  const url = `${baseUrl || DEFAULT_BASE_URL}/v1beta/models/${model || 'gemini-2.0-flash'}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  let json;
  try {
    json = await res.json();
  } catch {
    // A non-JSON body (most often an HTML login/consent or block page)
    // means something failed before Gemini's own API layer ever ran —
    // account/project restrictions surface this way as often as a
    // normal JSON error does. Surface that plainly instead of letting
    // the raw JSON.parse SyntaxError ("Unexpected token '<' ...") leak
    // through, which reads like Sentinel is broken rather than upstream.
    throw new Error(`Gemini API returned a non-JSON response (HTTP ${res.status}) — likely an account/project access issue rather than a normal API error`);
  }
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
