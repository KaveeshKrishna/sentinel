'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withBcryptSlot } = require('./bcryptLimiter');

test('withBcryptSlot resolves with the wrapped function\'s result', async () => {
  const result = await withBcryptSlot(async () => 42);
  assert.equal(result, 42);
});

test('withBcryptSlot propagates a rejection', async () => {
  await assert.rejects(() => withBcryptSlot(async () => { throw new Error('boom'); }), /boom/);
});

test('withBcryptSlot caps concurrency at MAX_CONCURRENT', async () => {
  const MAX = parseInt(process.env.BCRYPT_MAX_CONCURRENT, 10) || 4;
  let concurrent = 0;
  let maxObserved = 0;

  const jobs = Array.from({ length: MAX * 3 }, () => withBcryptSlot(async () => {
    concurrent++;
    maxObserved = Math.max(maxObserved, concurrent);
    await new Promise(resolve => setTimeout(resolve, 20));
    concurrent--;
    return true;
  }));

  await Promise.all(jobs);
  assert.ok(maxObserved <= MAX, `observed ${maxObserved} concurrent jobs, expected <= ${MAX}`);
});
