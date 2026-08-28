'use strict';

const { getAgentClient } = require('../agent/client');
const { upsertResource } = require('../graph/resources');
const { getDependents } = require('../graph/relationships');
const { discoverComposeEdges } = require('../graph/discovery');
const store = require('./store');
const { isSuppressed } = require('./suppression');
const { startInvestigation } = require('./engine');
const { logEvent } = require('../activity/logger');
const { getAIConfig } = require('../settings/aiConfig');
const { getDetectorConfig } = require('../settings/detectorConfig');
const { countDiagnosisAttempts } = require('../ai/orchestrator');

const POLL_MS = 5000; // matches activity/monitor.js's existing docker-event poll cadence
const STUCK_RETRY_BASE_MS = 30000; // minimum time before the first re-investigation attempt
const STUCK_RETRY_MAX_MS = 30 * 60000; // backoff cap — a persistently-failing provider (bad key, exhausted quota) is still retried eventually, just not hammered

// Cooldown, streak windows and CPU/RAM/disk thresholds are no longer
// constants here — they're operator-tunable via Settings and read fresh
// on each use, so a change applies on the next poll without a restart
// (settings/detectorConfig.js).
const HOST_RESOURCE_REF = { type: 'host', externalId: 'localhost', name: 'Host' };

let timer = null;
let lastSeenEventTs = Date.now();
const unhealthyStreaks = new Map(); // container name -> consecutive-unhealthy-poll count
let cpuStreak = 0;
let ramStreak = 0;

/**
 * Suppression (Sentinel itself just acted on this) + dedupe (open
 * incident already exists) + cooldown (resolved too recently), then
 * create + investigate.
 */
async function raiseIncident({ resourceRef, severity, triggerRule, triggerSummary }) {
  // Checked before the upsert: an event that's purely the echo of an
  // action Sentinel just took shouldn't even register the resource.
  if (isSuppressed(resourceRef.type, resourceRef.externalId)) return;

  const resource = upsertResource(resourceRef);

  if (store.findOpenIncidentForResource(resource.id)) return;

  const lastResolvedAt = store.getLastResolvedAt(resource.id);
  if (lastResolvedAt && Date.now() - lastResolvedAt < getDetectorConfig().cooldownMs) return;

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

  // Derive compose `depends_on` edges from the container labels we just
  // fetched anyway. This has to run before the health/exit rules use the
  // graph: whether a clean exit raises an incident depends on the
  // resource having a registered dependent (graph/discovery.js).
  try {
    discoverComposeEdges(containers);
  } catch (err) {
    console.error('[detector] compose edge discovery failed:', err.message);
  }

  const seen = new Set();
  for (const c of containers) {
    seen.add(c.name);
    if (c.health !== 'unhealthy') {
      unhealthyStreaks.delete(c.name);
      continue;
    }
    const streak = (unhealthyStreaks.get(c.name) || 0) + 1;
    unhealthyStreaks.set(c.name, streak);
    if (streak === getDetectorConfig().unhealthyStreak) {
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

  const { cpuThresholdPercent, ramThresholdPercent, diskThresholdPercent, resourceStreak } = getDetectorConfig();

  cpuStreak = metrics.cpu.usage >= cpuThresholdPercent ? cpuStreak + 1 : 0;
  ramStreak = metrics.memory.usedPercent >= ramThresholdPercent ? ramStreak + 1 : 0;

  if (cpuStreak === resourceStreak) {
    await raiseIncident({
      resourceRef: HOST_RESOURCE_REF, severity: 'medium', triggerRule: 'sustained_cpu',
      triggerSummary: `Host CPU has been at or above ${cpuThresholdPercent}% for ${resourceStreak} consecutive checks`
    });
  }
  if (ramStreak === resourceStreak) {
    await raiseIncident({
      resourceRef: HOST_RESOURCE_REF, severity: 'medium', triggerRule: 'sustained_ram',
      triggerSummary: `Host memory has been at or above ${ramThresholdPercent}% for ${resourceStreak} consecutive checks`
    });
  }
  // Disk fills slowly — no sustain window needed, but still deduped/cooled-down like everything else.
  if (disk.usage?.usedPercent >= diskThresholdPercent) {
    await raiseIncident({
      resourceRef: HOST_RESOURCE_REF, severity: 'medium', triggerRule: 'disk_usage',
      triggerSummary: `Host disk usage is at ${disk.usage.usedPercent}%`
    });
  }
}

/**
 * Re-drives diagnosis for an incident that got stuck at INVESTIGATING
 * with no diagnosis yet — the exact gap `states.js`'s comment on the
 * INVESTIGATING self-loop describes ("so the detector's next tick can
 * eventually re-drive it") but that, until now, nothing actually did:
 * raiseIncident's own dedup check means an already-open incident is
 * never re-investigated by anything else. Gated on getAIConfig() first
 * so this is a no-op (no evidence-gathering, no tool calls) on every
 * tick until a provider is actually configured.
 *
 * Once configured, retries back off exponentially per incident
 * (STUCK_RETRY_BASE_MS * 2^attempts, capped at STUCK_RETRY_MAX_MS)
 * rather than at a fixed short interval — a flat 30s retry against a
 * provider that's actually broken (not "not configured yet", but a
 * real bad key, exhausted quota, or access-denied project) doesn't
 * recover any faster for it and just burns through what's left of that
 * quota. `attempts` comes from ai_runs (every diagnosis attempt,
 * success or failure, is recorded there — see orchestrator.js), so
 * this naturally slows down and eventually gives up hammering a
 * provider that's failing for real, while still recovering promptly
 * from the one-time "wasn't configured yet" gap this was built for.
 */
async function checkStuckInvestigations() {
  if (!getAIConfig().configured) return;
  const stuck = store.findStuckInvestigations(STUCK_RETRY_BASE_MS);
  for (const incident of stuck) {
    const attempts = countDiagnosisAttempts(incident.id);
    const backoff = Math.min(STUCK_RETRY_MAX_MS, STUCK_RETRY_BASE_MS * 2 ** attempts);
    if (Date.now() - incident.updated_at < backoff) continue;
    startInvestigation(incident.id).catch(err => console.error('[detector] re-investigation error:', err.message));
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
  try {
    await checkStuckInvestigations();
  } catch (err) {
    console.error('[detector] checkStuckInvestigations failed:', err.message);
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
  checkContainerEvents, checkContainerHealth, checkServices, checkSystemMetrics, checkStuckInvestigations,
  _resetForTesting
};
