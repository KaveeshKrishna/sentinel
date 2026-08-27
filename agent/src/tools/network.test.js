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
