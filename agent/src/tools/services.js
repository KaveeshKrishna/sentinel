'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

// Services Sentinel is allowed to observe/control. This is the safety
// boundary for the service tools — even if the AI or a compromised server
// asks about an arbitrary unit, only these names ever reach systemctl.
// Phase-1 baseline; becomes a configurable allowlist seeded from
// discovery in a later phase.
const DEFAULT_MANAGED_SERVICES = ['docker', 'caddy', 'cloudflared', 'ssh', 'ufw'];

function getManagedServices() {
  const fromEnv = process.env.SENTINEL_MANAGED_SERVICES;
  if (fromEnv) return fromEnv.split(',').map(s => s.trim()).filter(Boolean);
  return DEFAULT_MANAGED_SERVICES;
}

function assertManaged(service) {
  if (!getManagedServices().includes(service)) {
    throw new Error(`Service "${service}" is not in the managed services allowlist`);
  }
}

/**
 * Run systemctl directly — no shell, no nsenter. The agent already runs
 * as root on the host (native systemd install), so unlike the previous
 * Docker-container deployment it never needs to escape a namespace to
 * reach the host's systemd.
 */
async function systemctl(args) {
  try {
    const { stdout } = await execFileAsync('systemctl', args, { timeout: 8000 });
    return stdout.trim();
  } catch (err) {
    // `is-active` exits non-zero for an inactive unit — stdout still
    // carries the real answer in that case.
    if (err.stdout) return err.stdout.trim();
    throw err;
  }
}

async function getStatus(service) {
  assertManaged(service);
  const status = await systemctl(['is-active', service]);
  return status || 'unknown';
}

/**
 * Is this unit socket-activated (a companion `<name>.socket` that's
 * active)? If so, stopping the service does not keep it stopped —
 * systemd restarts it the moment anything touches the socket, and
 * Sentinel's own agent polls the Docker socket every few seconds, so
 * `stop_service docker` reliably "fails" within one poll.
 *
 * Reported rather than prevented: stopping the unit is still exactly
 * what was asked for, and the socket is a legitimate part of how the
 * unit is configured. Surfacing it in the result (and so in the
 * incident's evidence) is what stops it looking like a bug in Sentinel.
 */
async function isSocketActivated(service) {
  try {
    return (await systemctl(['is-active', `${service}.socket`])) === 'active';
  } catch {
    return false; // no such .socket unit
  }
}

module.exports = function registerServiceTools(registry) {
  registry.register({
    name: 'list_services',
    description: 'List the managed system services and their current status (active/inactive/failed).',
    risk: 'READ_ONLY',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const services = getManagedServices();
      return Promise.all(services.map(async (name) => ({
        name, status: await getStatus(name).catch(() => 'unknown')
      })));
    }
  });

  registry.register({
    name: 'get_service_status',
    description: 'Get the current status of one managed service.',
    risk: 'READ_ONLY',
    parameters: {
      type: 'object',
      properties: { service: { type: 'string', minLength: 1 } },
      required: ['service'],
      additionalProperties: false
    },
    handler: async ({ service }) => ({ service, status: await getStatus(service) })
  });

  registry.register({
    name: 'get_service_logs',
    description: 'Get the recent journal log lines for a managed service.',
    risk: 'READ_ONLY',
    parameters: {
      type: 'object',
      properties: {
        service: { type: 'string', minLength: 1 },
        lines: { type: 'integer', minimum: 1, maximum: 500 }
      },
      required: ['service'],
      additionalProperties: false
    },
    handler: async ({ service, lines }) => {
      assertManaged(service);
      const { stdout } = await execFileAsync(
        'journalctl',
        ['-u', service, '-n', String(Math.min(lines || 100, 500)), '--no-pager', '-o', 'short-iso'],
        { timeout: 8000 }
      );
      return stdout.split('\n').filter(Boolean);
    }
  });

  registry.register({
    name: 'start_service',
    description: 'Start a stopped managed service.',
    risk: 'MEDIUM_RISK',
    parameters: {
      type: 'object',
      properties: { service: { type: 'string', minLength: 1 } },
      required: ['service'],
      additionalProperties: false
    },
    handler: async ({ service }) => {
      assertManaged(service);
      await systemctl(['start', service]);
      return { service, action: 'start' };
    },
    verify: async ({ service }) => ({ ok: (await getStatus(service)) === 'active' })
  });

  registry.register({
    name: 'stop_service',
    description: 'Stop a running managed service. Note: a socket-activated unit (e.g. docker, which has docker.socket) will be restarted by systemd on the next access, so stopping it does not keep it stopped.',
    risk: 'HIGH_RISK',
    parameters: {
      type: 'object',
      properties: { service: { type: 'string', minLength: 1 } },
      required: ['service'],
      additionalProperties: false
    },
    handler: async ({ service }) => {
      assertManaged(service);
      await systemctl(['stop', service]);

      const socketActivated = await isSocketActivated(service);
      return {
        service,
        action: 'stop',
        socketActivated,
        ...(socketActivated && {
          warning: `${service} is socket-activated (${service}.socket is still active) — systemd will restart it on the next access. Stop ${service}.socket too if you need it to stay down.`
        })
      };
    },
    verify: async ({ service }) => ({ ok: (await getStatus(service)) !== 'active' })
  });

  registry.register({
    name: 'restart_service',
    description: 'Restart a managed service.',
    risk: 'MEDIUM_RISK',
    parameters: {
      type: 'object',
      properties: { service: { type: 'string', minLength: 1 } },
      required: ['service'],
      additionalProperties: false
    },
    handler: async ({ service }) => {
      assertManaged(service);
      await systemctl(['restart', service]);
      return { service, action: 'restart' };
    },
    verify: async ({ service }) => ({ ok: (await getStatus(service)) === 'active' })
  });
};

module.exports.getManagedServices = getManagedServices;
