'use strict';

const MAX_CONCURRENT = parseInt(process.env.BCRYPT_MAX_CONCURRENT, 10) || 4;

let active = 0;
const queue = [];

function next() {
  if (active >= MAX_CONCURRENT || queue.length === 0) return;
  active++;
  const { fn, resolve, reject } = queue.shift();
  fn().then(
    (result) => { active--; resolve(result); next(); },
    (err) => { active--; reject(err); next(); }
  );
}

/**
 * Run an async bcrypt.compare/hash call through a small global
 * concurrency limit. bcrypt's native binding runs on libuv's shared
 * threadpool — without a cap, a burst of concurrent login attempts
 * (even spread across many IPs, which per-IP rate limiting doesn't stop)
 * can saturate that threadpool and stall unrelated async I/O across the
 * whole process, not just auth.
 */
function withBcryptSlot(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
}

module.exports = { withBcryptSlot };
