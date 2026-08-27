'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { chat } = require('./anthropic');

function fakeFetch(responseBody, status = 200) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => responseBody
  });
}

test('parses a forced tool-call into text/toolCalls/usage', async () => {
  const result = await chat({
    system: 'sys',
    messages: [{ role: 'user', content: 'hi' }],
    responseSchema: { type: 'object' },
    apiKey: 'k',
    model: 'claude-sonnet-5',
    fetchImpl: fakeFetch({
      content: [{ type: 'tool_use', name: 'emit_diagnosis', input: { rootCause: 'x' } }],
      usage: { input_tokens: 10, output_tokens: 20 }
    })
  });

  assert.deepEqual(JSON.parse(result.text), { rootCause: 'x' });
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.usage.promptTokens, 10);
  assert.equal(result.usage.completionTokens, 20);
});

test('falls back to a plain text block when no tool_use is present', async () => {
  const result = await chat({
    system: 'sys',
    messages: [{ role: 'user', content: 'hi' }],
    apiKey: 'k',
    fetchImpl: fakeFetch({ content: [{ type: 'text', text: 'plain answer' }], usage: {} })
  });
  assert.equal(result.text, 'plain answer');
  assert.equal(result.toolCalls.length, 0);
});

test('throws with the API error message on a non-2xx response', async () => {
  await assert.rejects(
    chat({
      system: 's', messages: [{ role: 'user', content: 'hi' }], apiKey: 'bad',
      fetchImpl: fakeFetch({ error: { message: 'invalid x-api-key' } }, 401)
    }),
    /invalid x-api-key/
  );
});

test('throws a clear error, not a raw SyntaxError, when the response body is not JSON', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 502,
    json: async () => { throw new SyntaxError("Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON"); }
  });
  await assert.rejects(
    chat({ system: 's', messages: [{ role: 'user', content: 'hi' }], apiKey: 'k', fetchImpl }),
    (err) => {
      assert.match(err.message, /non-JSON response \(HTTP 502\)/);
      assert.doesNotMatch(err.message, /Unexpected token/);
      return true;
    }
  );
});
