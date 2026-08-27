'use strict';

const API_VERSION = '2023-06-01';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DIAGNOSIS_TOOL_NAME = 'emit_diagnosis';

/**
 * Anthropic Messages API adapter. When a responseSchema is given, forces
 * a single tool-call whose input_schema *is* that schema — the most
 * reliable way to get schema-shaped JSON out of Claude, rather than
 * asking for JSON in prose and hoping. Normalizes to the shared
 * {text, toolCalls, usage} shape: `text` is the JSON-stringified tool
 * input, so the orchestrator can JSON.parse(result.text) the same way
 * for every provider.
 */
async function chat({ system, messages, responseSchema, apiKey, model, baseUrl, fetchImpl = fetch }) {
  const body = {
    model: model || 'claude-sonnet-5',
    max_tokens: 4096,
    system,
    messages: messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))
  };

  if (responseSchema) {
    body.tools = [{ name: DIAGNOSIS_TOOL_NAME, description: 'Emit the structured diagnosis.', input_schema: responseSchema }];
    body.tool_choice = { type: 'tool', name: DIAGNOSIS_TOOL_NAME };
  }

  const res = await fetchImpl(`${baseUrl || DEFAULT_BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION
    },
    body: JSON.stringify(body)
  });

  let json;
  try {
    json = await res.json();
  } catch {
    // A non-JSON body means something failed before Anthropic's own API
    // layer ran (a proxy/gateway error page, a dead base URL for a
    // self-hosted setup, etc). Surface that plainly instead of letting
    // the raw JSON.parse SyntaxError leak through as if Sentinel itself
    // were broken.
    throw new Error(`Anthropic API returned a non-JSON response (HTTP ${res.status})`);
  }
  if (!res.ok) throw new Error(`Anthropic API error (${res.status}): ${json?.error?.message || JSON.stringify(json)}`);

  const toolUse = (json.content || []).find(b => b.type === 'tool_use');
  const textBlock = (json.content || []).find(b => b.type === 'text');

  return {
    text: toolUse ? JSON.stringify(toolUse.input) : (textBlock?.text || ''),
    toolCalls: toolUse ? [{ name: toolUse.name, input: toolUse.input }] : [],
    usage: {
      promptTokens: json.usage?.input_tokens ?? null,
      completionTokens: json.usage?.output_tokens ?? null
    }
  };
}

module.exports = { chat };
