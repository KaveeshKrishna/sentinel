'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { _parseCaddyfile: parseCaddyfile } = require('./network');

test('parses a simple site block with no nested directives', () => {
  const sites = parseCaddyfile(`
    http://sentinel.example.com {
        reverse_proxy 127.0.0.1:8888
    }
  `);
  assert.deepEqual(sites, [
    { domain: 'sentinel.example.com', proxyTarget: '127.0.0.1:8888', port: 8888 }
  ]);
});

test('does not drop reverse_proxy behind a nested log block', () => {
  const sites = parseCaddyfile(`
    http://app.example.com {
        log {
            output file /var/log/caddy/access.log {
                roll_size 100mb
                roll_keep 10
            }
            format json
        }
        reverse_proxy 127.0.0.1:8081
    }
  `);
  assert.deepEqual(sites, [
    { domain: 'app.example.com', proxyTarget: '127.0.0.1:8081', port: 8081 }
  ]);
});

test('parses every site correctly when multiple sites each have a nested log block', () => {
  const sites = parseCaddyfile(`
    http://app.example.com {
        log {
            output file /var/log/caddy/access.log {
                roll_size 100mb
                roll_keep 10
            }
            format json
        }
        reverse_proxy 127.0.0.1:8081
    }

    http://admin.example.com {
        log {
            output file /var/log/caddy/access.log {
                roll_size 100mb
                roll_keep 10
            }
            format json
        }
        reverse_proxy 127.0.0.1:8082
    }

    http://sentinel.example.com {
        reverse_proxy 127.0.0.1:8888
    }
  `);
  assert.deepEqual(sites, [
    { domain: 'app.example.com', proxyTarget: '127.0.0.1:8081', port: 8081 },
    { domain: 'admin.example.com', proxyTarget: '127.0.0.1:8082', port: 8082 },
    { domain: 'sentinel.example.com', proxyTarget: '127.0.0.1:8888', port: 8888 }
  ]);
});

test('skips a site block with no reverse_proxy directive', () => {
  const sites = parseCaddyfile(`
    http://static.example.com {
        root * /var/www/static
        file_server
    }
    http://app.example.com {
        reverse_proxy 127.0.0.1:8081
    }
  `);
  assert.deepEqual(sites, [
    { domain: 'app.example.com', proxyTarget: '127.0.0.1:8081', port: 8081 }
  ]);
});

// ── tail-seek log reader ────────────────────────────────────────────
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { _readTailLines } = require('./network');

function writeLog(entries) {
  const p = path.join(os.tmpdir(), `caddy-tail-${crypto.randomUUID()}.log`);
  fs.writeFileSync(p, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  return p;
}

test('readTailLines returns every line when the whole file is within the cutoff', async () => {
  const now = Date.now() / 1000;
  const p = writeLog([
    { ts: now - 10, status: 200 },
    { ts: now - 5, status: 200 },
    { ts: now - 1, status: 500 }
  ]);
  const lines = (await _readTailLines(p, Date.now() - 60000)).filter(Boolean);
  assert.equal(lines.length, 3);
  fs.rmSync(p);
});

test('readTailLines stops reading backwards once it passes the cutoff, but still covers it', async () => {
  const now = Date.now() / 1000;
  // 20k old entries then 5 recent ones — comfortably more than one chunk.
  const old = Array.from({ length: 20000 }, (_, i) => ({ ts: now - 86400 - i, status: 200, pad: 'x'.repeat(100) }));
  const recent = Array.from({ length: 5 }, (_, i) => ({ ts: now - i, status: 500 }));
  const p = writeLog([...old.reverse(), ...recent]);

  const cutoff = Date.now() - 60000;
  const lines = (await _readTailLines(p, cutoff)).filter(Boolean);

  // Must not have read the entire file back...
  assert.ok(lines.length < 20005, 'should not return every line in the file');
  // ...but must still contain every entry newer than the cutoff.
  const recentFound = lines.map(l => JSON.parse(l)).filter(e => e.ts * 1000 >= cutoff);
  assert.equal(recentFound.length, 5);
  fs.rmSync(p);
});

test('readTailLines never returns a truncated partial line', async () => {
  const now = Date.now() / 1000;
  const entries = Array.from({ length: 5000 }, (_, i) => ({ ts: now - i, status: 200, pad: 'y'.repeat(200) }));
  const p = writeLog(entries.reverse());
  const lines = (await _readTailLines(p, Date.now() - 60000)).filter(Boolean);
  for (const line of lines) {
    assert.doesNotThrow(() => JSON.parse(line), `line should be complete JSON: ${line.slice(0, 40)}…`);
  }
  fs.rmSync(p);
});

test('readTailLines handles an empty file without throwing', async () => {
  const p = path.join(os.tmpdir(), `caddy-empty-${crypto.randomUUID()}.log`);
  fs.writeFileSync(p, '');
  const lines = (await _readTailLines(p, Date.now() - 60000)).filter(Boolean);
  assert.equal(lines.length, 0);
  fs.rmSync(p);
});

// ── website status is the HTTP probe, not container matching ─────────
const { _deriveWebsiteStatus: deriveWebsiteStatus } = require('./network');

test('a reachable non-container upstream is Running, not Unknown (Sentinel proxies to a systemd service)', () => {
  assert.deepEqual(
    deriveWebsiteStatus({ port: 8889, httpStatus: 200, containerName: null }),
    { status: 'running', upstream: 'host' }
  );
});

test('a reachable containerised upstream is Running and tagged as a container', () => {
  assert.deepEqual(
    deriveWebsiteStatus({ port: 8082, httpStatus: 200, containerName: 'other-public' }),
    { status: 'running', upstream: 'container' }
  );
});

test('a 3xx from the upstream still counts as Running', () => {
  assert.equal(deriveWebsiteStatus({ port: 8085, httpStatus: 307, containerName: 'app-web' }).status, 'running');
});

test('nothing listening on the port is Stopped', () => {
  assert.deepEqual(
    deriveWebsiteStatus({ port: 9999, httpStatus: 0, containerName: null }),
    { status: 'stopped', upstream: 'down' }
  );
});

test('a 5xx from the upstream is Unhealthy (reachable but erroring), not Stopped', () => {
  assert.equal(deriveWebsiteStatus({ port: 8082, httpStatus: 502, containerName: null }).status, 'unhealthy');
});

test('a site with no reverse_proxy port stays Unknown', () => {
  assert.deepEqual(
    deriveWebsiteStatus({ port: null, httpStatus: 0, containerName: null }),
    { status: 'unknown', upstream: 'unknown' }
  );
});
