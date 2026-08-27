'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { chat } = require('./gemini');

function fakeFetch(responseBody, status = 200) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => responseBody
  });
}

test('extracts text from candidates[0].content.parts', async () => {
  const result = await chat({
    system: 'sys',
    messages: [{ role: 'user', content: 'hi' }],
    responseSchema: { type: 'object' },
    apiKey: 'k',
    fetchImpl: fakeFetch({
      candidates: [{ content: { parts: [{ text: '{"rootCause":"x"}' }] } }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7 }
    })
  });
  assert.deepEqual(JSON.parse(result.text), { rootCause: 'x' });
  assert.equal(result.usage.promptTokens, 5);
  assert.equal(result.usage.completionTokens, 7);
});

test('throws with the API error message on a non-2xx response', async () => {
  await assert.rejects(
    chat({
      system: 's', messages: [{ role: 'user', content: 'hi' }], apiKey: 'bad',
      fetchImpl: fakeFetch({ error: { message: 'API key not valid' } }, 400)
    }),
    /API key not valid/
  );
});

test('throws a clear error, not a raw SyntaxError, when the response body is not JSON', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 403,
    json: async () => { throw new SyntaxError("Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON"); }
  });
  await assert.rejects(
    chat({ system: 's', messages: [{ role: 'user', content: 'hi' }], apiKey: 'k', fetchImpl }),
    (err) => {
      assert.match(err.message, /non-JSON response \(HTTP 403\)/);
      assert.doesNotMatch(err.message, /Unexpected token/);
      return true;
    }
  );
});
