'use strict';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/**
 * Serves OpenAI, OpenRouter, Groq, and local (Ollama/LM Studio/vLLM)
 * servers through one base-URL field — all speak the same
 * /chat/completions shape. Uses response_format:{type:'json_object'} for
 * structured output where the server supports it; harmless to send
 * otherwise (most OpenAI-compatible servers either honor it or ignore
 * unknown fields).
 */
async function chat({ system, messages, responseSchema, apiKey, model, baseUrl, fetchImpl = fetch }) {
  const body = {
    model: model || 'gpt-4o-mini',
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      ...messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))
    ],
    ...(responseSchema ? { response_format: { type: 'json_object' } } : {})
  };

  const res = await fetchImpl(`${baseUrl || DEFAULT_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify(body)
  });

  let json;
  try {
    json = await res.json();
  } catch {
    // A non-JSON body means something failed before the target server's
    // own API layer ran — a wrong base URL, a gateway/proxy error page
    // (common on OpenRouter/Groq under load), a local server that isn't
    // actually OpenAI-compatible at that path. Surface that plainly
    // instead of letting the raw JSON.parse SyntaxError leak through as
    // if Sentinel itself were broken.
    throw new Error(`OpenAI-compatible API returned a non-JSON response (HTTP ${res.status}) — check the base URL is correct`);
  }
  if (!res.ok) throw new Error(`OpenAI-compatible API error (${res.status}): ${json?.error?.message || JSON.stringify(json)}`);

  const choice = json.choices?.[0];

  return {
    text: choice?.message?.content || '',
    toolCalls: choice?.message?.tool_calls || [],
    usage: {
      promptTokens: json.usage?.prompt_tokens ?? null,
      completionTokens: json.usage?.completion_tokens ?? null
    }
  };
}

module.exports = { chat };
