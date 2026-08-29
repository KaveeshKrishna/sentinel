'use strict';

const { getAgentClient } = require('../agent/client');
const { upsertResource, getResource } = require('../graph/resources');
const { getDependents } = require('../graph/relationships');
const { discoverComposeEdges } = require('../graph/discovery');
const store = require('./store');
const { isSuppressed } = require('./suppression');
const { startInvestigation, rediagnose, maybeAutoRemediate, applyRunbook } = require('./engine');
const { findRunbookForIncident } = require('./runbooks');
const { logEvent } = require('../activity/logger');
const { notifyIncident } = require('../notify');
const { getAIConfig } = require('../settings/aiConfig');
const { isResourceEnabled } = require('../settings/autoRemediate');
const { getDetectorConfig } = require('../settings/detectorConfig');
const { countDiagnosisAttempts } = require('../ai/orchestrator');

const POLL_MS = 5000; // matches activity/monitor.js's existing docker-event poll cadence
const STUCK_RETRY_BASE_MS = 30000; // minimum time before the first re-investigation attempt
const STUCK_RETRY_MAX_MS = 30 * 60000; // backoff cap — a persistently-failing provider (bad key, exhausted quota) is still retried eventually, just not hammered
const STALE_WAITING_MS = 10 * 60000; // an incident parked at DIAGNOSED/AWAITING_APPROVAL this long gets re-diagnosed against current evidence

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
  notifyIncident('INCIDENT_DETECTED', incident.id);

  // A learned runbook costs nothing to check (a DB read, no agent call,
  // no provider request) and runs unconditionally — regardless of
  // shouldAutoDiagnose's opt-in gate below, which exists specifically to
  // protect provider quota. "For common problems it should not rely on
  // AI anyway": a tool that has already resolved this exact
  // (trigger_rule, resource_type) pair at least twice, with no more
  // recent failure, is proposed directly. Still requires the normal
  // human approval click unless the resource is ALSO opted into
  // auto-remediation — a runbook changes WHAT gets proposed and HOW
  // CHEAPLY, never WHETHER a human approves it.
  const runbook = findRunbookForIncident(incident, resource);
  if (runbook) {
    applyRunbook(incident, resource, runbook).catch(err => console.error('[detector] runbook apply error:', err.message));
    return;
  }

  // Detection is free; diagnosis costs a provider request. Only a
  // resource the operator has explicitly opted into auto-remediation is
  // diagnosed automatically — see shouldAutoDiagnose. Everything else
  // stays at DETECTED until a human clicks Diagnose.
  if (!shouldAutoDiagnose(resource)) return;

  // Fire-and-forget — the detector tick must not block on a full
  // diagnosis round trip; failures are handled inside startInvestigation
  // itself (malformed AI output leaves the incident at INVESTIGATING).
  startInvestigation(incident.id).catch(err => console.error('[detector] investigation error:', err.message));
}

/**
 * Whether an incident should be sent to the AI without a human asking.
 *
 * Deliberately the SAME opt-in list auto-remediation uses, not a second
 * setting: a resource the operator has said Sentinel may fix by itself
 * is exactly the one where an unattended diagnosis is worth a request,
 * and everything else can wait for a person who is already looking at it.
 *
 * Detection is unaffected — every incident is still raised, with full
 * evidence gathering available on demand. What this gates is only the
 * automatic *provider call*, which on a free tier is the scarce resource
 * (the Gemini tier this install uses allows 20 requests/day; a handful of
 * container exits during routine work could previously consume all of
 * them before anyone read the first diagnosis).
 */
function shouldAutoDiagnose(resource) {
  return isResourceEnabled(resource.type, resource.external_id);
}

/** shouldAutoDiagnose for an incident row, whose resource must be looked up. */
function autoDiagnosable(incident) {
  const resource = getResource(incident.resource_id);
  return !!resource && shouldAutoDiagnose(resource);
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

    // Opportunistic sync of compose project/service labels, reusing the
    // container list already fetched for the edge discovery above — no
    // extra agent call. This is what lets an incident on this container
    // later be correlated with a deploy to its repo (deploy correlation
    // matches on `resources.metadata_json->composeProject` against
    // `deployments.repo_name`). Passing `metadata: undefined` here would
    // silently disable the correlation for any container with no compose
    // labels, so only pass it when at least one label is actually present.
    if (c.composeProject || c.composeService) {
      upsertResource({
        type: 'container', externalId: c.name, name: c.name,
        metadata: { composeProject: c.composeProject || null, composeService: c.composeService || null }
      });
    }
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
    // Same gate as raiseIncident: an unattended retry is still an
    // unattended provider call. A non-opted-in incident that failed to
    // diagnose waits for a human to press Diagnose rather than retrying
    // against a quota nobody asked it to spend.
    if (!autoDiagnosable(incident)) continue;
    const attempts = countDiagnosisAttempts(incident.id);
    const backoff = Math.min(STUCK_RETRY_MAX_MS, STUCK_RETRY_BASE_MS * 2 ** attempts);
    if (Date.now() - incident.updated_at < backoff) continue;
    startInvestigation(incident.id).catch(err => console.error('[detector] re-investigation error:', err.message));
  }
}


/**
 * Re-check opt-in auto-remediation for incidents already parked at
 * AWAITING_APPROVAL. The diagnosis and its proposed actions already
 * exist — this covers the case where the operator ticks a resource in
 * Settings *after* its incident was raised (or where a rate-limit
 * window that had been exceeded has since rolled over). No AI call:
 * maybeAutoRemediate just re-evaluates the existing proposed actions.
 */
async function checkAutoRemediation() {
  for (const incident of store.findWaitingIncidents()) {
    // Both DIAGNOSED (zero AI actions) and AWAITING_APPROVAL are worth a
    // re-check — an opted-in resource with a deterministic trigger gets
    // its canonical remediation from either state.
    try {
      await maybeAutoRemediate(incident.id);
    } catch (err) {
      console.error(`[detector] auto-remediation re-check for #${incident.id} failed:`, err.message);
    }
  }
}

/**
 * Re-diagnose an incident that has sat at DIAGNOSED / AWAITING_APPROVAL,
 * untouched, past STALE_WAITING_MS.
 *
 * This is the escape hatch for the dedupe rule (one open incident per
 * resource): without it, a diagnosis written for a problem that has
 * since changed — or a stale incident nobody ever actioned — blocks any
 * fresh incident for that resource *forever*, because raiseIncident
 * bails the moment it finds an open one. Re-diagnosis refreshes the
 * evidence and the recommended actions against the resource's current
 * state, and (via diagnoseWithEvidence) re-runs auto-remediation.
 *
 * Same per-incident exponential backoff as checkStuckInvestigations, so
 * a genuinely wedged incident isn't re-diagnosed every 10 minutes
 * indefinitely.
 */
async function checkStaleWaitingIncidents() {
  if (!getAIConfig().configured) return;
  for (const incident of store.findWaitingIncidents(STALE_WAITING_MS)) {
    if (!autoDiagnosable(incident)) continue;
    const attempts = countDiagnosisAttempts(incident.id);
    const backoff = Math.min(STUCK_RETRY_MAX_MS, STALE_WAITING_MS * 2 ** Math.max(0, attempts - 1));
    if (Date.now() - incident.updated_at < backoff) continue;
    logEvent('INCIDENT_STALE_REDIAGNOSE', `Incident #${incident.id}: parked ${Math.round((Date.now() - incident.updated_at) / 60000)}m — re-diagnosing`);
    rediagnose(incident.id).catch(err => console.error(`[detector] stale re-diagnose for #${incident.id} failed:`, err.message));
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
  try {
    await checkAutoRemediation();
  } catch (err) {
    console.error('[detector] checkAutoRemediation failed:', err.message);
  }
  try {
    await checkStaleWaitingIncidents();
  } catch (err) {
    console.error('[detector] checkStaleWaitingIncidents failed:', err.message);
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
  startIncidentDetection, stopIncidentDetection, tick, raiseIncident, shouldAutoDiagnose,
  checkContainerEvents, checkContainerHealth, checkServices, checkSystemMetrics, checkStuckInvestigations,
  checkAutoRemediation, checkStaleWaitingIncidents,
  _resetForTesting
};
