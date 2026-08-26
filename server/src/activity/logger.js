'use strict';

const MAX_EVENTS = 500;
let events = [];
let nextId = 1;

const EVENT_META = {
  SSH_LOGIN:       { icon: '🔐', color: '#3b82f6' },
  DEPLOYMENT:      { icon: '🚀', color: '#22c55e' },
  DOCKER_START:    { icon: '▶',  color: '#22c55e' },
  DOCKER_STOP:     { icon: '■',  color: '#f59e0b' },
  DOCKER_RESTART:  { icon: '↺',  color: '#3b82f6' },
  CONTAINER_CRASH: { icon: '💥', color: '#ef4444' },
  SERVICE_START:   { icon: '✓',  color: '#22c55e' },
  SERVICE_STOP:    { icon: '✗',  color: '#f59e0b' },
  SERVICE_RESTART: { icon: '↺',  color: '#3b82f6' },
  RECORDING_START: { icon: '⏺',  color: '#ef4444' },
  RECORDING_STOP:  { icon: '⏹',  color: '#7d8590' },
  SYSTEM_START:    { icon: '⬆',  color: '#a855f7' },
  CADDY_RELOAD:    { icon: '🌐', color: '#06b6d4' }
};

/**
 * Log an event into the in-memory ring buffer.
 * @param {string} type - One of EVENT_META keys
 * @param {string} message - Human-readable description
 * @param {object|null} details - Optional extra data
 */
function logEvent(type, message, details = null) {
  const meta = EVENT_META[type] || { icon: '•', color: '#7d8590' };
  const event = {
    id: nextId++,
    timestamp: Date.now(),
    type,
    message,
    details,
    ...meta
  };
  events.unshift(event);
  if (events.length > MAX_EVENTS) events.pop();
  console.log(`[${type}] ${message}`);
}

function getEvents(limit = 100) {
  return events.slice(0, Math.min(limit, MAX_EVENTS));
}

// Record server start
logEvent('SYSTEM_START', 'Sentinel server started');

module.exports = { logEvent, getEvents };
