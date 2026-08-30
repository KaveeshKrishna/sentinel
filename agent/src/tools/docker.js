'use strict';

const fs = require('fs');
const Dockerode = require('dockerode');

const SOCKET_PATH = process.env.DOCKER_SOCKET || '/var/run/docker.sock';

function getClient() {
  return new Dockerode({ socketPath: SOCKET_PATH });
}

function dockerAvailable() {
  return fs.existsSync(SOCKET_PATH);
}

// Bounded ring buffer of container lifecycle events, watched from inside
// the agent (the only process allowed to touch the Docker socket). The
// server polls get_docker_events instead of connecting to dockerode
// itself — this is what lets activity logging work without server/
// holding any Docker privilege.
const MAX_EVENTS = 200;
let dockerEvents = [];
let eventWatchStarted = false;

function pushEvent(evt) {
  dockerEvents.push(evt);
  if (dockerEvents.length > MAX_EVENTS) dockerEvents.shift();
}

function startEventWatch() {
  if (eventWatchStarted) return;
  eventWatchStarted = true;

  if (!dockerAvailable()) {
    console.log('[agent] Docker socket not found — container event watching disabled');
    return;
  }

  const connect = () => {
    getClient().getEvents({}, (err, stream) => {
      if (err) {
        console.error('[agent] docker events error:', err.message);
        setTimeout(connect, 15000);
        return;
      }
      stream.on('data', (chunk) => {
        try {
          const event = JSON.parse(chunk.toString());
          if (event.Type !== 'container') return;
          const name = event.Actor?.Attributes?.name || event.id?.substring(0, 12) || 'unknown';
          if (event.Action === 'die') {
            pushEvent({ type: 'die', name, exitCode: event.Actor?.Attributes?.exitCode || '?', ts: Date.now() });
          } else if (event.Action === 'oom') {
            pushEvent({ type: 'oom', name, ts: Date.now() });
          } else if (['start', 'stop', 'restart'].includes(event.Action)) {
            pushEvent({ type: event.Action, name, ts: Date.now() });
          }
        } catch { /* malformed event frame */ }
      });
      stream.on('error', () => setTimeout(connect, 10000));
      stream.on('end', () => setTimeout(connect, 5000));
    });
  };
  connect();
}

function getContainerStats(container) {
  return new Promise((resolve, reject) =>
    container.stats({ stream: false }, (err, stats) => (err ? reject(err) : resolve(stats)))
  );
}

/**
 * Parse Docker's multiplexed log format (8-byte framed stream).
 * Each frame: [type(1), 0(3), size(4-BE), data(size)]
 */
function parseMuxedLogs(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  const lines = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const streamType = buffer[offset];
    const size = buffer.readUInt32BE(offset + 4);
    if (size === 0) { offset += 8; continue; }
    if (offset + 8 + size > buffer.length) break;
    const text = buffer.slice(offset + 8, offset + 8 + size).toString('utf8').trimEnd();
    if (text) lines.push({ stream: streamType === 2 ? 'stderr' : 'stdout', text });
    offset += 8 + size;
  }
  return lines;
}

async function listContainersDetailed(docker) {
  const list = await docker.listContainers({ all: true });
  return Promise.all(list.map(async (c) => {
    let cpuPercent = 0;
    let memUsage = 0;
    if (c.State === 'running') {
      try {
        const stats = await getContainerStats(docker.getContainer(c.Id));
        const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
        const sysDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
        const numCpus = stats.cpu_stats.online_cpus || 1;
        cpuPercent = sysDelta > 0 ? (cpuDelta / sysDelta) * numCpus * 100 : 0;
        memUsage = Math.max(0, (stats.memory_stats.usage || 0) - (stats.memory_stats.stats?.cache || 0));
      } catch { /* stats can race a container that just stopped */ }
    }
    const inspect = await docker.getContainer(c.Id).inspect().catch(() => ({}));
    const ports = (c.Ports || [])
      .filter(p => p.PublicPort)
      .map(p => `${p.PublicPort}→${p.PrivatePort}`)
      .join(', ') || (c.Ports || []).map(p => `${p.PrivatePort}`).join(', ');

    return {
      id: c.Id,
      shortId: c.Id.substring(0, 12),
      name: (c.Names[0] || '').replace(/^\//, ''),
      image: c.Image,
      status: c.Status,
      state: c.State,
      cpuPercent: Math.round(cpuPercent * 100) / 100,
      memUsage: Math.round(memUsage),
      restartCount: inspect.RestartCount || 0,
      ports,
      health: inspect.State?.Health?.Status || 'N/A',
      composeProject: c.Labels?.['com.docker.compose.project'] || null,
      // Compose v2 records the service name and its `depends_on` graph as
      // labels. Exposing them lets server/'s graph auto-discovery derive
      // dependency edges instead of requiring each one to be registered
      // by hand — the agent stays a pure reporter, the graph logic stays
      // unprivileged.
      composeService: c.Labels?.['com.docker.compose.service'] || null,
      composeDependsOn: c.Labels?.['com.docker.compose.depends_on'] || null,
      created: c.Created
    };
  }));
}

module.exports = function registerDockerTools(registry) {
  startEventWatch();

  registry.register({
    name: 'get_docker_events',
    description: 'Get recent Docker container lifecycle events (die, oom, start, stop, restart) observed by the agent.',
    risk: 'READ_ONLY',
    parameters: {
      type: 'object',
      properties: { since: { type: 'integer' } },
      additionalProperties: false
    },
    handler: async ({ since } = {}) => dockerEvents.filter(e => !since || e.ts > since)
  });

  registry.register({
    name: 'list_containers',
    description: 'List all Docker containers (running and stopped) with resource usage, health, and restart counts.',
    risk: 'READ_ONLY',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => listContainersDetailed(getClient())
  });

  registry.register({
    name: 'get_container_status',
    description: 'Get detailed status for a single container by id or name.',
    risk: 'READ_ONLY',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 1 } },
      required: ['id'],
      additionalProperties: false
    },
    handler: async ({ id }) => {
      const inspect = await getClient().getContainer(id).inspect();
      return {
        id: inspect.Id,
        name: (inspect.Name || '').replace(/^\//, ''),
        state: inspect.State,
        restartCount: inspect.RestartCount,
        image: inspect.Config?.Image
      };
    }
  });

  registry.register({
    name: 'get_container_logs',
    description: 'Get the recent stdout/stderr log lines for a container.',
    risk: 'READ_ONLY',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1 },
        tail: { type: 'integer', minimum: 1, maximum: 500 }
      },
      required: ['id'],
      additionalProperties: false
    },
    handler: async ({ id, tail }) => {
      const container = getClient().getContainer(id);
      const buffer = await container.logs({
        stdout: true, stderr: true, tail: Math.min(tail || 200, 500), follow: false, timestamps: true
      });
      return parseMuxedLogs(buffer);
    }
  });

  registry.register({
    name: 'start_container',
    description: 'Start a stopped container.',
    risk: 'MEDIUM_RISK',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 1 } },
      required: ['id'],
      additionalProperties: false
    },
    handler: async ({ id }) => {
      const ct = getClient().getContainer(id);
      const info = await ct.inspect();
      await ct.start();
      return { name: info.Name.replace(/^\//, ''), action: 'start' };
    },
    verify: async ({ id }) => {
      const info = await getClient().getContainer(id).inspect();
      return { ok: info.State?.Running === true, detail: info.State };
    }
  });

  registry.register({
    name: 'stop_container',
    description: 'Stop a running container.',
    risk: 'HIGH_RISK',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 1 } },
      required: ['id'],
      additionalProperties: false
    },
    handler: async ({ id }) => {
      const ct = getClient().getContainer(id);
      const info = await ct.inspect();
      await ct.stop();
      return { name: info.Name.replace(/^\//, ''), action: 'stop' };
    },
    verify: async ({ id }) => {
      const info = await getClient().getContainer(id).inspect();
      return { ok: info.State?.Running === false, detail: info.State };
    }
  });

  registry.register({
    name: 'restart_container',
    description: 'Restart a container.',
    risk: 'MEDIUM_RISK',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 1 } },
      required: ['id'],
      additionalProperties: false
    },
    handler: async ({ id }) => {
      const ct = getClient().getContainer(id);
      const info = await ct.inspect();
      await ct.restart();
      return { name: info.Name.replace(/^\//, ''), action: 'restart' };
    },
    verify: async ({ id }) => {
      const info = await getClient().getContainer(id).inspect();
      return { ok: info.State?.Running === true, detail: info.State };
    }
  });
};
