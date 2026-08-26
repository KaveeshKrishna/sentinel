'use strict';

const http = require('http');

/**
 * Transport abstraction for talking to the Sentinel agent. UnixSocketTransport
 * is the only implementation today (single-server, local agent); a future
 * MtlsHttpsTransport for remote agents can implement the same interface
 * without the client or the incident/tool-call code changing at all.
 */
class UnixSocketTransport {
  constructor({ socketPath, token, timeoutMs = 15000 }) {
    this.socketPath = socketPath;
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {object} [body]
   * @param {object} [headers]
   * @returns {Promise<{status: number, body: any}>}
   */
  request(method, path, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const payload = body !== undefined ? JSON.stringify(body) : undefined;

      const req = http.request({
        socketPath: this.socketPath,
        path,
        method,
        timeout: this.timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers
        }
      }, (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = { raw }; }
          resolve({ status: res.statusCode, body: parsed });
        });
      });

      req.on('timeout', () => req.destroy(new Error('Agent request timed out')));
      req.on('error', reject);

      if (payload) req.write(payload);
      req.end();
    });
  }
}

module.exports = { UnixSocketTransport };
