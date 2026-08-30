'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { chat } = require('./openai-compatible');

function fakeFetch(responseBody, status = 200) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => responseBody
  });
}

test('extracts choices[0].message.content and usage', async () => {
  const result = await chat({
    system: 'sys',
    messages: [{ role: 'user', content: 'hi' }],
    responseSchema: { type: 'object' },
    apiKey: 'k',
    baseUrl: 'https://openrouter.ai/api/v1',
    fetchImpl: fakeFetch({
      choices: [{ message: { content: '{"rootCause":"x"}' } }],
      usage: { prompt_tokens: 3, completion_tokens: 4 }
    })
  });
  assert.deepEqual(JSON.parse(result.text), { rootCause: 'x' });
  assert.equal(result.usage.promptTokens, 3);
  assert.equal(result.usage.completionTokens, 4);
});

test('throws with the API error message on a non-2xx response', async () => {
  await assert.rejects(
    chat({
      system: 's', messages: [{ role: 'user', content: 'hi' }], apiKey: 'bad',
      fetchImpl: fakeFetch({ error: { message: 'Incorrect API key' } }, 401)
    }),
    /Incorrect API key/
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
