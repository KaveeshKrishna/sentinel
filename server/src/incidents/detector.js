'use strict';

const { getAgentClient } = require('../agent/client');
const { upsertResource } = require('../graph/resources');
const { getDependents } = require('../graph/relationships');
const store = require('./store');
const { startInvestigation } = require('./engine');
const { logEvent } = require('../activity/logger');

const POLL_MS = 5000; // matches activity/monitor.js's existing docker-event poll cadence
const COOLDOWN_MS = 60000; // after a resource's incident resolves, wait this long before raising another
const UNHEALTHY_STREAK_THRESHOLD = 2; // consecutive polls a container must report `unhealthy`
const RESOURCE_STREAK_THRESHOLD = 3; // consecutive polls CPU/RAM must stay over threshold
const CPU_THRESHOLD_PERCENT = 90;
const RAM_THRESHOLD_PERCENT = 90;
const DISK_THRESHOLD_PERCENT = 90;
const HOST_RESOURCE_REF = { type: 'host', externalId: 'localhost', name: 'Host' };

let timer = null;
let lastSeenEventTs = Date.now();
const unhealthyStreaks = new Map(); // container name -> consecutive-unhealthy-poll count
let cpuStreak = 0;
let ramStreak = 0;

/** Dedupe (open incident already exists) + cooldown (resolved too recently), then create + investigate. */
async function raiseIncident({ resourceRef, severity, triggerRule, triggerSummary }) {
  const resource = upsertResource(resourceRef);

  if (store.findOpenIncidentForResource(resource.id)) return;

  const lastResolvedAt = store.getLastResolvedAt(resource.id);
  if (lastResolvedAt && Date.now() - lastResolvedAt < COOLDOWN_MS) return;

  const incident = store.createIncident({ resourceId: resource.id, severity, triggerRule, triggerSummary });
  logEvent('INCIDENT_DETECTED', `Incident #${incident.id}: ${triggerSummary}`);

  // Fire-and-forget — the detector tick must not block on a full
  // diagnosis round trip; failures are handled inside startInvestigation
  // itself (malformed AI output leaves the incident at INVESTIGATING).
  startInvestigation(incident.id).catch(err => console.error('[detector] investigation error:', err.message));
}

async function checkContainerEvents(agent) {
  const events = await agent.callTool('get_docker_events', { since: lastSeenEventTs });
  for (const evt of events) {
    lastSeenEventTs = Math.max(lastSeenEventTs, evt.ts);
    const resourceRef = { type: 'container', externalId: evt.name, name: evt.name };

    if (evt.type === 'die') {
      const resource = upsertResource(resourceRef);
      const hasDependents = getDependents(resource.id).length > 0;
      // A clean `docker stop` exits 0 — that alone shouldn't page anyone.
      // But if something else depends on this container, its own exit
      // (clean or not) is exactly the signal that matters.
      if (evt.exitCode !== '0' || hasDependents) {
        await raiseIncident({
          resourceRef, severity: 'high', triggerRule: 'container_exit',
          triggerSummary: `Container ${evt.name} exited (code ${evt.exitCode})`
        });
      }
    } else if (evt.type === 'oom') {
      await raiseIncident({
        resourceRef, severity: 'high', triggerRule: 'container_oom',
        triggerSummary: `Container ${evt.name} was killed by the OOM killer`
      });
    }
  }
}

async function checkContainerHealth(agent) {
  const containers = await agent.callTool('list_containers');
  const seen = new Set();
  for (const c of containers) {
    seen.add(c.name);
    if (c.health !== 'unhealthy') {
      unhealthyStreaks.delete(c.name);
      continue;
    }
    const streak = (unhealthyStreaks.get(c.name) || 0) + 1;
    unhealthyStreaks.set(c.name, streak);
    if (streak === UNHEALTHY_STREAK_THRESHOLD) {
      await raiseIncident({
        resourceRef: { type: 'container', externalId: c.name, name: c.name },
        severity: 'high', triggerRule: 'container_unhealthy',
        triggerSummary: `Container ${c.name} has reported unhealthy for ${streak} consecutive checks`
      });
    }
  }
  for (const name of [...unhealthyStreaks.keys()]) {
    if (!seen.has(name)) unhealthyStreaks.delete(name); // container no longer exists
  }
}

async function checkServices(agent) {
  const services = await agent.callTool('list_services');
  for (const s of services) {
    if (s.status === 'active') continue;
    await raiseIncident({
      resourceRef: { type: 'service', externalId: s.name, name: s.name },
      severity: 'high', triggerRule: 'service_inactive',
      triggerSummary: `Service ${s.name} is ${s.status}`
    });
  }
}

async function checkSystemMetrics(agent) {
  const [metrics, disk] = await Promise.all([
    agent.callTool('get_system_metrics'),
    agent.callTool('inspect_disk')
  ]);

  cpuStreak = metrics.cpu.usage >= CPU_THRESHOLD_PERCENT ? cpuStreak + 1 : 0;
  ramStreak = metrics.memory.usedPercent >= RAM_THRESHOLD_PERCENT ? ramStreak + 1 : 0;

  if (cpuStreak === RESOURCE_STREAK_THRESHOLD) {
    await raiseIncident({
      resourceRef: HOST_RESOURCE_REF, severity: 'medium', triggerRule: 'sustained_cpu',
      triggerSummary: `Host CPU has been at or above ${CPU_THRESHOLD_PERCENT}% for ${RESOURCE_STREAK_THRESHOLD} consecutive checks`
    });
  }
  if (ramStreak === RESOURCE_STREAK_THRESHOLD) {
    await raiseIncident({
      resourceRef: HOST_RESOURCE_REF, severity: 'medium', triggerRule: 'sustained_ram',
      triggerSummary: `Host memory has been at or above ${RAM_THRESHOLD_PERCENT}% for ${RESOURCE_STREAK_THRESHOLD} consecutive checks`
    });
  }
  // Disk fills slowly — no sustain window needed, but still deduped/cooled-down like everything else.
  if (disk.usage?.usedPercent >= DISK_THRESHOLD_PERCENT) {
    await raiseIncident({
      resourceRef: HOST_RESOURCE_REF, severity: 'medium', triggerRule: 'disk_usage',
      triggerSummary: `Host disk usage is at ${disk.usage.usedPercent}%`
    });
  }
}

async function tick() {
  const agent = getAgentClient();
  const checks = [checkContainerEvents, checkContainerHealth, checkServices, checkSystemMetrics];
  for (const check of checks) {
    try {
      await check(agent);
    } catch (err) {
      console.error(`[detector] ${check.name} failed:`, err.message);
    }
  }
}

function startIncidentDetection() {
  if (timer) return;
  timer = setInterval(tick, POLL_MS);
  timer.unref?.();
}

function stopIncidentDetection() {
  if (timer) clearInterval(timer);
  timer = null;
}

function _resetForTesting() {
  lastSeenEventTs = Date.now();
  unhealthyStreaks.clear();
  cpuStreak = 0;
  ramStreak = 0;
}

module.exports = {
  startIncidentDetection, stopIncidentDetection, tick,
  checkContainerEvents, checkContainerHealth, checkServices, checkSystemMetrics,
  _resetForTesting
};
