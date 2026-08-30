'use strict';

const { getAgentClient } = require('../agent/client');
const { createSession, endSession, saveSample } = require('./db');
const { logEvent } = require('../activity/logger');

let state = {
  recording: false,
  sessionId: null,
  sessionName: null,
  startTime: null,
  sampleCount: 0,
  intervalId: null
};

function getRecordingState() {
  return {
    recording: state.recording,
    sessionId: state.sessionId,
    sessionName: state.sessionName,
    startTime: state.startTime,
    elapsed: state.startTime ? Date.now() - state.startTime : 0,
    sampleCount: state.sampleCount
  };
}

async function takeSample() {
  try {
    const agent = getAgentClient();
    const [metrics, containers, services] = await Promise.all([
      agent.callTool('get_system_metrics'),
      agent.callTool('list_containers').catch(() => []),
      agent.callTool('list_services').catch(() => [])
    ]);
    const serviceMap = Object.fromEntries(services.map(s => [s.name, s.status]));
    saveSample(state.sessionId, metrics, containers, serviceMap);
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
  state.sessionId = createSession(sessionName);
  state.sessionName = sessionName;
  state.recording = true;
  state.startTime = Date.now();
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
