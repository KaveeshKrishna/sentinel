'use strict';

const fs = require('fs');
const { UnixSocketTransport } = require('./transport');

const SOCKET_PATH = process.env.SENTINEL_AGENT_SOCKET || '/run/sentinel/agent.sock';
const TOKEN_PATH = process.env.SENTINEL_AGENT_TOKEN_PATH || '/etc/sentinel/agent.token';

let cachedToken = null;
function loadToken() {
  if (cachedToken) return cachedToken;
  if (process.env.SENTINEL_AGENT_TOKEN) {
    cachedToken = process.env.SENTINEL_AGENT_TOKEN;
    return cachedToken;
  }
  cachedToken = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
  return cachedToken;
}

class AgentError extends Error {
  constructor(message, status, details) {
    super(message);
    this.name = 'AgentError';
    this.status = status;
    this.details = details;
  }
}

/**
 * Thin client for the agent's tool-call API. This is the *only* way
 * server/ code should ever reach host state — no route in server/ should
 * import dockerode, call execFile, or read /proc directly. That invariant
 * is what keeps the AI-hosting process free of host privilege.
 */
class AgentClient {
  constructor(transport) {
    this.transport = transport;
  }

  async listTools() {
    const { status, body } = await this.transport.request('GET', '/tools');
    if (status !== 200) throw new AgentError('Failed to list agent tools', status, body);
    return body;
  }

  /**
   * @param {string} name - registered tool name
   * @param {object} [params] - tool parameters (validated agent-side)
   * @param {object} [opts]
   * @param {boolean} [opts.approved] - set true only when this call has
   *   real authorization behind it: either a directly-authenticated user
   *   triggered it themselves via the UI, or an incident's approval step
   *   (Phase 3) was explicitly completed by a human. READ_ONLY tools
   *   ignore this flag entirely (they auto-approve on the agent side).
   */
  async callTool(name, params = {}, { approved = false } = {}) {
    const { status, body } = await this.transport.request(
      'POST',
      `/tools/${encodeURIComponent(name)}`,
      params,
      approved ? { 'X-Sentinel-Approved': 'true' } : {}
    );
    if (status !== 200 || !body?.ok) {
      throw new AgentError(body?.error || `Agent tool "${name}" failed`, status, body);
    }
    return body.result;
  }
}

let sharedClient = null;

/** Lazily-constructed singleton client, wired to the Unix socket transport. */
function getAgentClient() {
  if (!sharedClient) {
    const transport = new UnixSocketTransport({ socketPath: SOCKET_PATH, token: loadToken() });
    sharedClient = new AgentClient(transport);
  }
  return sharedClient;
}

module.exports = { AgentClient, AgentError, getAgentClient };
