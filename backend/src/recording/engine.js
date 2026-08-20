'use strict';

const Dockerode = require('dockerode');
const { execSync } = require('child_process');
const { collectAll } = require('../collectors');
const { createSession, endSession, saveSample } = require('./db');
const { logEvent } = require('../activity/logger');

const docker = new Dockerode({ socketPath: '/var/run/docker.sock' });
const SERVICES = ['docker', 'caddy', 'cloudflared', 'ssh', 'ufw'];

let state = {
  recording:    false,
  sessionId:    null,
  sessionName:  null,
  startTime:    null,
  sampleCount:  0,
  intervalId:   null
};

function getRecordingState() {
  return {
    recording:    state.recording,
    sessionId:    state.sessionId,
    sessionName:  state.sessionName,
    startTime:    state.startTime,
    elapsed:      state.startTime ? Date.now() - state.startTime : 0,
    sampleCount:  state.sampleCount
  };
}

async function collectDockerStats() {
  try {
    const containers = await docker.listContainers({ all: false });
    return await Promise.all(containers.map(async (c) => {
      let cpuPercent = 0, memUsage = 0;
      try {
        const ct = docker.getContainer(c.Id);
        const stats = await new Promise((res, rej) =>
          ct.stats({ stream: false }, (err, s) => err ? rej(err) : res(s))
        );
        const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
        const sysDelta  = stats.cpu_stats.system_cpu_usage    - stats.precpu_stats.system_cpu_usage;
        const numCpus   = stats.cpu_stats.online_cpus || 1;
        cpuPercent = sysDelta > 0 ? (cpuDelta / sysDelta) * numCpus * 100 : 0;
        memUsage   = (stats.memory_stats.usage || 0) - (stats.memory_stats.stats?.cache || 0);
      } catch {}
      const inspect = await docker.getContainer(c.Id).inspect().catch(() => ({}));
      return {
        name:         (c.Names[0] || '').replace(/^\//, ''),
        cpuPercent:   Math.round(cpuPercent * 100) / 100,
        memUsage:     Math.max(0, memUsage),
        restartCount: inspect.RestartCount || 0,
        health:       inspect.State?.Health?.Status || 'N/A'
      };
    }));
  } catch {
    return [];
  }
}

function collectServiceStatuses() {
  const statuses = {};
  for (const svc of SERVICES) {
    try {
      statuses[svc] = execSync(
        `nsenter -t 1 -m -u -i -n -p -- systemctl is-active ${svc}`,
        { encoding: 'utf8', timeout: 4000 }
      ).trim();
    } catch {
      statuses[svc] = 'inactive';
    }
  }
  return statuses;
}

async function takeSample() {
  try {
    const metrics    = collectAll();
    const containers = await collectDockerStats();
    const services   = collectServiceStatuses();
    saveSample(state.sessionId, metrics, containers, services);
    state.sampleCount++;
  } catch (err) {
    console.error('[recording] sample error:', err.message);
  }
}

/**
 * Start a recording session. Throws if already recording.
 * Never starts automatically — only via explicit API call.
 */
function startRecording(name) {
  if (state.recording) throw new Error('A recording is already in progress');

  const sessionName = (name || '').trim() || `Session #${new Date().toISOString().slice(0, 16)}`;
  state.sessionId   = createSession(sessionName);
  state.sessionName = sessionName;
  state.recording   = true;
  state.startTime   = Date.now();
  state.sampleCount = 0;

  // First sample immediately, then every 60 s
  takeSample();
  state.intervalId = setInterval(takeSample, 60 * 1000);

  logEvent('RECORDING_START', `Recording started: ${sessionName}`);
  return getRecordingState();
}

/**
 * Stop the active recording and finalize the session in SQLite.
 */
function stopRecording() {
  if (!state.recording) throw new Error('No recording in progress');

  clearInterval(state.intervalId);
  endSession(state.sessionId, state.sampleCount);

  logEvent('RECORDING_STOP', `Recording stopped — ${state.sampleCount} sample(s) saved`);

  const finalState = {
    ...getRecordingState(),
    recording: false
  };

  state = { recording: false, sessionId: null, sessionName: null, startTime: null, sampleCount: 0, intervalId: null };
  return finalState;
}

module.exports = { startRecording, stopRecording, getRecordingState };
