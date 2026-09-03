/**
 * Seed data for the public demo (frontend/src/demo/). Everything here is
 * fabricated — the demo build has no backend and can never reach a real
 * host. buildFixtures() returns a fresh deep copy each call so "Reset
 * demo" can restore a pristine world.
 *
 * Shapes are matched to the live API contracts (see server/src/routes/*
 * and agent/src/collectors|tools/*). If a real endpoint's shape changes,
 * update the matching slice here.
 */

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const now = () => Date.now();

const CPU_INFO = { model: 'AMD EPYC 7302P 16-Core Processor', threads: 8, frequency: 2999 };
const MEM_TOTAL = 16_724_000_768;      // ~15.6 GiB
const DISK_TOTAL = 171_798_691_840;    // 160 GiB
const DISK_TOTAL_2 = 536_870_912_000;  // 500 GiB data disk

// ─── Containers ──────────────────────────────────────────────────────────────
function containers() {
  const t = now();
  return [
    mkContainer('demo-web',   'demo-vps-demo-web-1',   'demo-vps/web:1.8.2',   'running', 'healthy', 0,  '8080→80',   'demo-vps', 'web',   null,        1.9,  86, t - 6 * DAY),
    mkContainer('demo-api',   'demo-vps-demo-api-1',   'demo-vps/api:1.8.2',   'running', 'healthy', 0,  '8890→3000', 'demo-vps', 'api',   'demo-db',   3.4, 142, t - 6 * DAY),
    mkContainer('demo-db',    'demo-vps-demo-db-1',    'postgres:16-alpine',   'running', 'healthy', 1,  '5432',      'demo-vps', 'db',    null,        0.7, 214, t - 6 * DAY),
    mkContainer('demo-cache', 'demo-vps-demo-cache-1', 'redis:7-alpine',       'running', 'N/A',     2,  '6379',      'demo-vps', 'cache', null,        0.3,  38, t - 6 * DAY),
    mkContainer('demo-worker','demo-vps-demo-worker-1','demo-vps/worker:1.8.2','running', 'N/A',     0,  '',          'demo-vps', 'worker','demo-db,demo-cache', 11.6, 176, t - 6 * DAY),
    mkContainer('legacy-cron','demo-vps-legacy-cron-1','busybox:1.36',         'exited',  'N/A',     0,  '',          null,       null,    null,        0,     0, t - 20 * DAY, 'Exited (0) 40 minutes ago'),
  ];
}
function mkContainer(name, id, image, state, health, restarts, ports, project, service, dependsOn, cpu, memMiB, created, statusOverride) {
  return {
    id: id + '-' + hash(id), shortId: hash(id).slice(0, 12), name, image,
    status: statusOverride || (state === 'running' ? `Up ${2 + (name.length % 9)} hours${health === 'healthy' ? ' (healthy)' : ''}` : 'Exited (0) 40 minutes ago'),
    state,
    cpuPercent: state === 'running' ? cpu : 0,
    memUsage: state === 'running' ? memMiB * 1024 * 1024 : 0,
    restartCount: restarts, ports,
    health,
    composeProject: project, composeService: service, composeDependsOn: dependsOn,
    created: Math.round(created / 1000),
  };
}
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return (h.toString(16) + '0000000000000000').slice(0, 16);
}

// ─── Services ────────────────────────────────────────────────────────────────
function services() {
  return { docker: 'active', caddy: 'active', cloudflared: 'active', ssh: 'active', ufw: 'inactive' };
}

// ─── Websites ────────────────────────────────────────────────────────────────
function websites() {
  return [
    { domain: 'sentinel.example.com', localPort: 8889, proxyTarget: '127.0.0.1:8889', status: 'running', upstream: 'host',      dockerStatus: 'unknown', containerName: null,       responseTime: 6,  httpStatus: 200, httpsStatus: 'valid' },
    { domain: 'demo-shop.example.com',          localPort: 8080, proxyTarget: '127.0.0.1:8080', status: 'running', upstream: 'container', dockerStatus: 'running', containerName: 'demo-web', responseTime: 34, httpStatus: 200, httpsStatus: 'valid' },
    { domain: 'demo-blog.example.com',          localPort: 8081, proxyTarget: '127.0.0.1:8081', status: 'running', upstream: 'container', dockerStatus: 'running', containerName: 'demo-web', responseTime: 41, httpStatus: 200, httpsStatus: 'valid' },
    { domain: 'demo-api.example.com',           localPort: 8890, proxyTarget: '127.0.0.1:8890', status: 'running', upstream: 'container', dockerStatus: 'running', containerName: 'demo-api', responseTime: 22, httpStatus: 200, httpsStatus: 'valid' },
  ];
}

// ─── Deployments (git repos) ─────────────────────────────────────────────────
function repos() {
  const t = now();
  return [
    {
      name: 'demo-web', path: '/srv/apps/demo-web', branch: 'main',
      commit: { hash: '4a91c2e', fullHash: '4a91c2e6d5b3f8a1c0e2d4b6a8f9c1e3d5b7a9c1', author: 'Kaveesh Krishna Pandey', date: new Date(t - 2 * DAY).toISOString(), message: 'feat: dark-mode toggle on the storefront' },
      clean: true, uncommittedFiles: 0, ahead: 0, behind: 2, composeFile: 'compose.yml',
    },
    {
      name: 'demo-api', path: '/srv/apps/demo-api', branch: 'main',
      commit: { hash: 'b7d0f43', fullHash: 'b7d0f4312a9c8e7d6b5a4c3e2f1d0b9a8c7e6d5f', author: 'Kaveesh Krishna Pandey', date: new Date(t - 5 * HOUR).toISOString(), message: 'fix: connection pool exhaustion under load' },
      clean: true, uncommittedFiles: 0, ahead: 0, behind: 0, composeFile: 'compose.yml',
    },
    {
      name: 'sentinel', path: '/srv/apps/sentinel', branch: 'main',
      commit: { hash: 'c0ba23b', fullHash: 'c0ba23b1e4d7a0c3f6b9e2d5a8c1f4b7e0d3a6c9', author: 'Kaveesh Krishna Pandey', date: new Date(t - 18 * HOUR).toISOString(), message: 'test: prove per-chat memory and cascade-delete for Ask Sentinel' },
      clean: true, uncommittedFiles: 0, ahead: 0, behind: 0, composeFile: null,
    },
  ];
}

// ─── Resources (dependency graph nodes) ──────────────────────────────────────
function resources() {
  const t = now();
  const mk = (id, type, ext, name, meta) => ({
    id, type, external_id: ext, name,
    metadata_json: meta ? JSON.stringify(meta) : null, metadata: meta || null,
    first_seen_at: t - 6 * DAY, last_seen_at: t,
  });
  return [
    mk(1, 'host', 'localhost', 'demo-vps', null),
    mk(2, 'container', 'demo-vps-demo-web-1', 'demo-web', { composeProject: 'demo-vps', composeService: 'web' }),
    mk(3, 'container', 'demo-vps-demo-api-1', 'demo-api', { composeProject: 'demo-vps', composeService: 'api' }),
    mk(4, 'container', 'demo-vps-demo-db-1', 'demo-db', { composeProject: 'demo-vps', composeService: 'db' }),
    mk(5, 'container', 'demo-vps-demo-cache-1', 'demo-cache', { composeProject: 'demo-vps', composeService: 'cache' }),
    mk(6, 'container', 'demo-vps-demo-worker-1', 'demo-worker', { composeProject: 'demo-vps', composeService: 'worker' }),
    mk(7, 'service', 'caddy', 'caddy', null),
    mk(8, 'service', 'docker', 'docker', null),
  ];
}

// ─── Incidents ───────────────────────────────────────────────────────────────
function incidents() {
  const t = now();

  // 1 — AWAITING_APPROVAL: demo-db unhealthy, dependency of demo-api
  const awaiting = {
    id: 1, resource_id: 4, status: 'AWAITING_APPROVAL', severity: 'high',
    trigger_rule: 'container_unhealthy',
    trigger_summary: 'demo-db reported unhealthy for 2 consecutive polls',
    root_cause: 'demo-db is refusing connections: PostgreSQL hit max_connections (100) and new health-check probes time out. demo-api depends on it and is now serving 503s.',
    confidence: 0.83,
    diagnosis_json: JSON.stringify({
      rootCause: 'demo-db is refusing connections: PostgreSQL hit max_connections (100) and new health-check probes time out. demo-api depends on it and is now serving 503s.',
      confidence: 0.83,
      evidence: ['demo-db logs: "FATAL: sorry, too many clients already" x37 in the last 2 minutes', 'demo-api logs: ECONNREFUSED to demo-db:5432', 'demo-db healthcheck exit code 1 for 2 polls'],
      affectedComponents: ['demo-db', 'demo-api'],
      recommendedActions: [{ tool: 'restart_container', params: { id: 'demo-db' }, risk: 'MEDIUM_RISK', rationale: 'Clear the leaked connections and let dependents reconnect' }],
      requiresApproval: true,
    }),
    diagnosis_raw_text: null,
    detected_at: t - 7 * 60 * 1000, updated_at: t - 90 * 1000, resolved_at: null,
    report_json: null, report_generated_at: null,
    _evidence: [
      ev(1, 1, 4, 'get_docker_events', 'demo-db: 2 health_status:unhealthy events in the last 2 minutes', { events: [{ type: 'health_status', status: 'unhealthy', ts: t - 120000 }] }, t - 6 * 60 * 1000),
      ev(2, 1, 4, 'get_container_logs', 'demo-db: 37× "FATAL: sorry, too many clients already"', { lines: 100 }, t - 5.5 * 60 * 1000),
      ev(3, 1, 3, 'get_container_logs', 'demo-api: repeated "ECONNREFUSED 172.19.0.4:5432"', { lines: 100 }, t - 5 * 60 * 1000),
      ev(4, 1, 1, 'get_system_metrics', 'Host CPU 14%, RAM 41% — the host itself is healthy; this is scoped to demo-db', null, t - 4.5 * 60 * 1000),
    ],
    _actions: [
      act(1, 1, 'restart_container', { id: 'demo-db' }, 'MEDIUM_RISK', 'MEDIUM_RISK', 'Clear the leaked connections and let dependents reconnect', 'proposed', t - 80 * 1000),
    ],
    _timeline: timelineAwaiting(t),
  };

  // 2 — RESOLVED: historic demo-api OOM, auto-remediated
  const resolved = {
    id: 2, resource_id: 3, status: 'RESOLVED', severity: 'high',
    trigger_rule: 'container_oom',
    trigger_summary: 'demo-api was OOM-killed (exit 137)',
    root_cause: 'A malformed CSV upload caused demo-api to buffer the entire file in memory, exceeding its 256 MB cgroup limit. The container was OOM-killed and restarted by Sentinel.',
    confidence: 0.91,
    diagnosis_json: JSON.stringify({
      rootCause: 'A malformed CSV upload caused demo-api to buffer the entire file in memory, exceeding its 256 MB cgroup limit. The container was OOM-killed and restarted by Sentinel.',
      confidence: 0.91,
      evidence: ['dmesg: "Memory cgroup out of memory: Killed process ... (node)"', 'demo-api restart_count went 0 → 1', 'Access log shows a 90 MB POST to /import right before the kill'],
      affectedComponents: ['demo-api'],
      recommendedActions: [{ tool: 'restart_container', params: { id: 'demo-api' }, risk: 'MEDIUM_RISK', rationale: 'Restore service' }],
      requiresApproval: false,
    }),
    diagnosis_raw_text: null,
    detected_at: t - 2 * DAY - 3 * HOUR, updated_at: t - 2 * DAY - 3 * HOUR + 5 * 60 * 1000, resolved_at: t - 2 * DAY - 3 * HOUR + 5 * 60 * 1000,
    report_json: JSON.stringify({
      title: 'demo-api OOM-killed by an unbounded CSV import',
      summary: 'demo-api exceeded its 256 MB memory limit while buffering a 90 MB CSV upload entirely in memory, was OOM-killed (exit 137), and was automatically restarted by Sentinel. Total downtime was roughly 70 seconds.',
      impact: 'demo-api returned 502s for ~70 seconds. demo-shop and demo-api.example.com were briefly unavailable. No data loss.',
      rootCause: 'The /import endpoint reads the uploaded file into a single Buffer before parsing. A 90 MB upload pushed RSS past the cgroup limit and the kernel OOM-killer terminated the Node process.',
      resolution: 'Sentinel detected the OOM within one 5-second poll, confirmed the exit code and restart count, and (demo-api being opted into auto-remediation) ran restart_container. The verify step confirmed demo-api healthy and demo-shop back to HTTP 200.',
      timeline: [
        '02:58:12  demo-api OOM-killed (exit 137), restart_count 0 → 1',
        '02:58:15  Sentinel raised incident #2 (container_oom, HIGH)',
        '02:58:41  AI diagnosis returned (confidence 0.91)',
        '02:58:44  Auto-remediation: restart_container demo-api',
        '02:59:19  Verify passed — demo-api healthy, demo-shop HTTP 200',
        '02:59:20  Incident resolved',
      ],
      prevention: [
        'Stream the upload to disk (or parse it as a stream) instead of buffering it in memory',
        'Add an explicit request-size limit to /import (e.g. 10 MB)',
        'Raise the demo-api memory limit to 512 MB as a short-term buffer',
      ],
    }),
    report_generated_at: t - 2 * DAY - 3 * HOUR + 6 * 60 * 1000,
    _evidence: [
      ev(10, 2, 3, 'get_docker_events', 'demo-api: die (exitCode 137) then start — OOM kill', { exitCode: '137' }, t - 2 * DAY - 3 * HOUR + 30 * 1000),
      ev(11, 2, 3, 'get_container_logs', 'demo-api: last line before kill was "importing rows: 812443..."', null, t - 2 * DAY - 3 * HOUR + 60 * 1000),
      ev(12, 2, 1, 'inspect_processes', 'node (demo-api) RSS peaked at 268 MB against a 256 MB limit', null, t - 2 * DAY - 3 * HOUR + 90 * 1000),
    ],
    _actions: [
      { ...act(10, 2, 'restart_container', { id: 'demo-api' }, 'MEDIUM_RISK', 'MEDIUM_RISK', 'Restore service after the OOM kill', 'executed', t - 2 * DAY - 3 * HOUR + 3 * 60 * 1000), approved_by: null, approved_via: 'auto', approved_at: t - 2 * DAY - 3 * HOUR + 3 * 60 * 1000, executed_at: t - 2 * DAY - 3 * HOUR + 3 * 60 * 1000 + 2000, result_json: JSON.stringify({ ok: true }) },
    ],
    _timeline: timelineResolved(t - 2 * DAY - 3 * HOUR),
  };

  // 3 — DETECTED: sustained CPU on the host, not yet diagnosed
  const detected = {
    id: 3, resource_id: 1, status: 'DETECTED', severity: 'medium',
    trigger_rule: 'sustained_cpu',
    trigger_summary: 'Host CPU stayed above 90% for 3 consecutive polls',
    root_cause: null, confidence: null, diagnosis_json: null, diagnosis_raw_text: null,
    detected_at: t - 3 * 60 * 1000, updated_at: t - 3 * 60 * 1000, resolved_at: null,
    report_json: null, report_generated_at: null,
    _evidence: [],
    _actions: [],
    _timeline: timelineDetected(t - 3 * 60 * 1000),
  };

  // 4 — DISMISSED: a flapping container the operator judged noise
  const dismissed = {
    id: 4, resource_id: 5, status: 'DISMISSED', severity: 'medium',
    trigger_rule: 'container_exit',
    trigger_summary: 'demo-cache restarted twice in 10 minutes',
    root_cause: null, confidence: null, diagnosis_json: null, diagnosis_raw_text: null,
    detected_at: t - 4 * HOUR, updated_at: t - 4 * HOUR + 8 * 60 * 1000, resolved_at: t - 4 * HOUR + 8 * 60 * 1000,
    report_json: null, report_generated_at: null,
    _evidence: [
      ev(20, 4, 5, 'get_docker_events', 'demo-cache: 2× restart in 10 minutes, both exit 0', null, t - 4 * HOUR + 60 * 1000),
    ],
    _actions: [],
    _timeline: timelineDismissed(t - 4 * HOUR),
  };

  return [awaiting, resolved, detected, dismissed];
}

function ev(id, incidentId, resourceId, tool, summary, data, at) {
  return { id, incident_id: incidentId, resource_id: resourceId, source_tool: tool, summary, data, collected_at: at };
}
function act(id, incidentId, tool, params, claimed, real, rationale, status, createdAt) {
  return {
    id, incident_id: incidentId, tool_name: tool, params, params_json: JSON.stringify(params),
    claimed_risk: claimed, real_risk: real, rationale, status,
    approved_by: null, approved_at: null, approved_via: null, executed_at: null,
    result_json: null, error: null, created_at: createdAt,
  };
}

// timelines ------------------------------------------------------------------
function phase(p, status, at) { return { phase: p, status, at }; }
function timelineAwaiting(t) {
  return {
    phases: [
      phase('OBSERVE', 'done', t - 7 * 60 * 1000),
      phase('DIAGNOSE', 'done', t - 4 * 60 * 1000),
      phase('PLAN', 'active', t - 80 * 1000),
      phase('ACT', 'pending', null),
      phase('VERIFY', 'pending', null),
    ],
    entries: [
      { kind: 'transition', phase: 'OBSERVE', at: t - 7 * 60 * 1000, from: null, to: 'DETECTED', synthesized: false },
      { kind: 'transition', phase: 'OBSERVE', at: t - 6.5 * 60 * 1000, from: 'DETECTED', to: 'INVESTIGATING', synthesized: false },
      { kind: 'tool', phase: 'OBSERVE', at: t - 6 * 60 * 1000, tool: 'get_docker_events', status: 'ok', approved: false, realRisk: 'READ_ONLY', durationMs: 88 },
      { kind: 'tool', phase: 'OBSERVE', at: t - 5.5 * 60 * 1000, tool: 'get_container_logs', status: 'ok', approved: false, realRisk: 'READ_ONLY', durationMs: 141 },
      { kind: 'tool', phase: 'OBSERVE', at: t - 5 * 60 * 1000, tool: 'get_container_logs', status: 'ok', approved: false, realRisk: 'READ_ONLY', durationMs: 133 },
      { kind: 'ai', phase: 'DIAGNOSE', at: t - 4 * 60 * 1000, purpose: 'diagnosis', provider: 'openai-compatible', model: 'nvidia/nemotron-3-ultra-550b-a55b:free', attempt: 1, ok: true, promptTokens: 1840, completionTokens: 372, latencyMs: 5210 },
      { kind: 'transition', phase: 'DIAGNOSE', at: t - 4 * 60 * 1000, from: 'INVESTIGATING', to: 'DIAGNOSED', synthesized: false },
      { kind: 'action', phase: 'PLAN', at: t - 80 * 1000, tool: 'restart_container', realRisk: 'MEDIUM_RISK', status: 'proposed', approvedVia: null },
      { kind: 'transition', phase: 'PLAN', at: t - 80 * 1000, from: 'DIAGNOSED', to: 'AWAITING_APPROVAL', synthesized: false },
    ],
  };
}
function timelineResolved(t0) {
  return {
    phases: [
      phase('OBSERVE', 'done', t0), phase('DIAGNOSE', 'done', t0 + 30000),
      phase('PLAN', 'done', t0 + 40000), phase('ACT', 'done', t0 + 45000), phase('VERIFY', 'done', t0 + 65000),
    ],
    entries: [
      { kind: 'transition', phase: 'OBSERVE', at: t0, from: null, to: 'DETECTED', synthesized: false },
      { kind: 'tool', phase: 'OBSERVE', at: t0 + 5000, tool: 'get_docker_events', status: 'ok', approved: false, realRisk: 'READ_ONLY', durationMs: 74 },
      { kind: 'tool', phase: 'OBSERVE', at: t0 + 12000, tool: 'inspect_processes', status: 'ok', approved: false, realRisk: 'READ_ONLY', durationMs: 205 },
      { kind: 'ai', phase: 'DIAGNOSE', at: t0 + 29000, purpose: 'diagnosis', provider: 'openai-compatible', model: 'nvidia/nemotron-3-ultra-550b-a55b:free', attempt: 1, ok: true, promptTokens: 1620, completionTokens: 301, latencyMs: 4400 },
      { kind: 'transition', phase: 'DIAGNOSE', at: t0 + 30000, from: 'INVESTIGATING', to: 'DIAGNOSED', synthesized: false },
      { kind: 'action', phase: 'PLAN', at: t0 + 40000, tool: 'restart_container', realRisk: 'MEDIUM_RISK', status: 'executed', approvedVia: 'auto', approved: true },
      { kind: 'transition', phase: 'ACT', at: t0 + 44000, from: 'AWAITING_APPROVAL', to: 'REMEDIATING', synthesized: false },
      { kind: 'tool', phase: 'ACT', at: t0 + 45000, tool: 'restart_container', status: 'ok', approved: true, realRisk: 'MEDIUM_RISK', durationMs: 1980 },
      { kind: 'transition', phase: 'VERIFY', at: t0 + 47000, from: 'REMEDIATING', to: 'VERIFYING', synthesized: false },
      { kind: 'tool', phase: 'VERIFY', at: t0 + 64000, tool: 'restart_container', status: 'ok', approved: true, realRisk: 'MEDIUM_RISK', durationMs: 120 },
      { kind: 'transition', phase: 'VERIFY', at: t0 + 65000, from: 'VERIFYING', to: 'RESOLVED', synthesized: false },
    ],
  };
}
function timelineDetected(t0) {
  return {
    phases: [
      phase('OBSERVE', 'active', t0), phase('DIAGNOSE', 'pending', null),
      phase('PLAN', 'pending', null), phase('ACT', 'pending', null), phase('VERIFY', 'pending', null),
    ],
    entries: [
      { kind: 'transition', phase: 'OBSERVE', at: t0, from: null, to: 'DETECTED', synthesized: false },
    ],
  };
}
function timelineDismissed(t0) {
  return {
    phases: [
      phase('OBSERVE', 'done', t0), phase('DIAGNOSE', 'skipped', null),
      phase('PLAN', 'skipped', null), phase('ACT', 'skipped', null), phase('VERIFY', 'skipped', null),
    ],
    entries: [
      { kind: 'transition', phase: 'OBSERVE', at: t0, from: null, to: 'DETECTED', synthesized: false },
      { kind: 'tool', phase: 'OBSERVE', at: t0 + 60000, tool: 'get_docker_events', status: 'ok', approved: false, realRisk: 'READ_ONLY', durationMs: 63 },
      { kind: 'transition', phase: 'OBSERVE', at: t0 + 8 * 60 * 1000, from: 'DETECTED', to: 'DISMISSED', synthesized: false },
    ],
  };
}

// ─── Recordings ──────────────────────────────────────────────────────────────
function recordings() {
  const t = now();
  const list = [
    { id: 3, name: 'Post-deploy watch — demo-api 1.8.2', start_time: t - 6 * HOUR, end_time: t - 6 * HOUR + 32 * 60 * 1000 },
    { id: 2, name: 'Nightly baseline', start_time: t - 30 * HOUR, end_time: t - 30 * HOUR + 60 * 60 * 1000 },
    { id: 1, name: 'Load test — 500 rps', start_time: t - 3 * DAY, end_time: t - 3 * DAY + 25 * 60 * 1000 },
  ];
  return list.map(s => {
    const samples = genSamples(s.id, s.start_time, s.end_time, s.id === 1 ? 'load' : 'calm');
    const agg = summarize(samples);
    return {
      ...s,
      sample_count: samples.length,
      avg_cpu: round(agg.avgCpu, 1), peak_temp: round(agg.maxTemp, 1),
      avg_ram: round(agg.avgRam, 1), max_load: round(agg.maxLoad, 2), avg_temp: round(agg.avgTemp, 1),
      _samples: samples,
    };
  });
}
export function genSamples(sessionId, start, end, mode = 'calm') {
  const out = [];
  const step = 30 * 1000;
  let i = 0;
  for (let ts = start; ts <= end; ts += step, i++) {
    const wave = Math.sin(i / 6);
    const load = mode === 'load' ? 62 + wave * 20 + rand(-6, 6) : 12 + wave * 6 + rand(-3, 3);
    const cpu = clamp(load, 1, 99);
    const ram = clamp((mode === 'load' ? 61 : 40) + wave * 5 + rand(-2, 2), 5, 95);
    const temp = clamp((mode === 'load' ? 63 : 49) + wave * 4 + rand(-1.5, 1.5), 30, 88);
    out.push({
      id: sessionId * 1000 + i, session_id: sessionId, timestamp: ts,
      cpu_usage: round(cpu, 1),
      load_1: round(cpu / 100 * 6 + rand(-0.2, 0.2), 2), load_5: round(cpu / 100 * 5, 2), load_15: round(cpu / 100 * 4, 2),
      cpu_temp: round(temp, 1),
      ram_used: Math.round(MEM_TOTAL * ram / 100), ram_total: MEM_TOTAL, ram_percent: round(ram, 1),
      swap_used: 0, swap_total: 2_147_479_552,
      disk_used: Math.round(DISK_TOTAL * 0.37) + i * 4096, disk_total: DISK_TOTAL,
      disk_read_speed: Math.round(rand(0, mode === 'load' ? 6e6 : 4e5)), disk_write_speed: Math.round(rand(2e4, mode === 'load' ? 9e6 : 8e5)),
      net_up_speed: Math.round(rand(1e4, mode === 'load' ? 4e6 : 3e5)), net_down_speed: Math.round(rand(2e4, mode === 'load' ? 9e6 : 6e5)),
      net_bytes_sent: 112233445566 + i * 5e5, net_bytes_recv: 998877665544 + i * 9e5,
    });
  }
  return out;
}
function summarize(samples) {
  const avg = (k) => samples.reduce((a, s) => a + (s[k] || 0), 0) / samples.length;
  const max = (k) => Math.max(...samples.map(s => s[k] || 0));
  return {
    avgCpu: avg('cpu_usage'), avgRam: avg('ram_percent'), avgTemp: avg('cpu_temp'), avgLoad: avg('load_1'),
    maxTemp: max('cpu_temp'), maxRam: max('ram_percent'), maxLoad: max('load_1'), maxSwap: max('swap_used'),
    diskGrowth: samples.length > 1 ? samples[samples.length - 1].disk_used - samples[0].disk_used : 0,
  };
}
export function analyticsFor(samples) {
  if (!samples.length) return {};
  const a = summarize(samples);
  let score = 100; const issues = []; const positives = [];
  if (a.avgCpu > 80) { score -= 20; issues.push(`High avg CPU (${a.avgCpu.toFixed(1)}%)`); }
  else if (a.avgCpu > 60) { score -= 8; issues.push(`Elevated avg CPU (${a.avgCpu.toFixed(1)}%)`); }
  else if (a.avgCpu < 40) positives.push(`CPU averaged ${a.avgCpu.toFixed(1)}% (healthy)`);
  if (a.maxTemp > 75) { score -= 12; issues.push(`High temperature (${a.maxTemp.toFixed(1)}°C)`); }
  else if (a.maxTemp > 65) { score -= 5; issues.push(`Elevated temperature (${a.maxTemp.toFixed(1)}°C)`); }
  else if (a.maxTemp > 0) positives.push('Temperature stayed below 65°C');
  if (a.avgRam > 85) { score -= 15; issues.push(`Critical avg RAM (${a.avgRam.toFixed(1)}%)`); }
  else if (a.avgRam > 70) { score -= 8; issues.push(`High avg RAM (${a.avgRam.toFixed(1)}%)`); }
  else if (a.avgRam < 50) positives.push(`RAM averaged ${a.avgRam.toFixed(1)}% (comfortable)`);
  if (a.maxLoad > 4) { score -= 15; issues.push(`System overloaded (max load ${a.maxLoad.toFixed(2)})`); }
  else if (a.maxLoad > 2) { score -= 5; issues.push(`High system load (max ${a.maxLoad.toFixed(2)})`); }
  const label = score >= 90 ? 'Excellent' : score >= 75 ? 'Good' : score >= 60 ? 'Fair' : score >= 40 ? 'Poor' : 'Critical';
  return {
    avgCpu: round(a.avgCpu, 1), avgRam: round(a.avgRam, 1), avgTemp: round(a.avgTemp, 1), avgLoad: round(a.avgLoad, 2),
    maxTemp: round(a.maxTemp, 1), maxRam: round(a.maxRam, 1), maxLoad: round(a.maxLoad, 2), maxSwap: a.maxSwap,
    diskGrowth: a.diskGrowth,
    healthScore: Math.max(0, Math.round(score)), healthLabel: label,
    issues, positives,
    containerStats: [
      { name: 'demo-api', avgCpu: 3.1, avgRam: 148 * 1024 * 1024, restarts: 0, downtime: 0 },
      { name: 'demo-db', avgCpu: 0.8, avgRam: 214 * 1024 * 1024, restarts: 0, downtime: 0 },
    ],
  };
}

// ─── Activity ────────────────────────────────────────────────────────────────
function activity() {
  const t = now();
  const raw = [
    ['SYSTEM_START', 'Sentinel server started', t - 2 * DAY],
    ['SSH_LOGIN', 'SSH login from 10.0.0.14 (kaveesh)', t - 2 * DAY + 20 * 60 * 1000],
    ['DEPLOYMENT', 'demo-api: deployed b7d0f43 successfully', t - 2 * DAY + 40 * 60 * 1000],
    ['INCIDENT_DETECTED', 'Incident #2 detected: demo-api OOM-killed', t - 2 * DAY - 3 * HOUR + 3000],
    ['INCIDENT_DIAGNOSED', 'Incident #2 diagnosed (confidence 91%)', t - 2 * DAY - 3 * HOUR + 30000],
    ['INCIDENT_AUTO_REMEDIATE', 'Incident #2: auto-remediation ran restart_container demo-api', t - 2 * DAY - 3 * HOUR + 44000],
    ['INCIDENT_RESOLVED', 'Incident #2 resolved', t - 2 * DAY - 3 * HOUR + 65000],
    ['CADDY_RELOAD', 'Caddy configuration reloaded', t - 30 * HOUR],
    ['DOCKER_RESTART', 'Container demo-cache restarted', t - 26 * HOUR],
    ['SERVICE_RESTART', 'Service "cloudflared" restarted', t - 20 * HOUR],
    ['DEPLOYMENT', 'demo-web: deployed 3f1aa20 successfully', t - 19 * HOUR],
    ['DOCKER_RESTART', 'Container demo-cache restarted', t - 4 * HOUR - 30 * 60 * 1000],
    ['DOCKER_RESTART', 'Container demo-cache restarted', t - 4 * HOUR - 20 * 60 * 1000],
    ['INCIDENT_DETECTED', 'Incident #4 detected: demo-cache flapping', t - 4 * HOUR],
    ['INCIDENT_DISMISSED', 'Incident #4 dismissed', t - 4 * HOUR + 8 * 60 * 1000],
    ['SSH_LOGIN', 'SSH login from 10.0.0.14 (kaveesh)', t - 3 * HOUR],
    ['LOGIN', 'demo signed in', t - 45 * 60 * 1000],
    ['INCIDENT_DETECTED', 'Incident #3 detected: sustained host CPU', t - 3 * 60 * 1000],
    ['INCIDENT_DETECTED', 'Incident #1 detected: demo-db unhealthy', t - 7 * 60 * 1000],
    ['INCIDENT_DIAGNOSED', 'Incident #1 diagnosed (confidence 83%)', t - 4 * 60 * 1000],
  ];
  return raw
    .map(([type, message, timestamp], i) => ({ id: 1000 + i, type, message, timestamp, details: null }))
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 50);
}

// ─── Chat sessions ───────────────────────────────────────────────────────────
function chatSessions() {
  const t = now();
  const msg = (id, sid, role, content, toolCalls) => ({
    id, session_id: sid, role, content,
    tool_calls_json: toolCalls ? JSON.stringify(toolCalls) : null,
    created_at: t, toolCalls: toolCalls || null,
  });
  return [
    {
      id: 3, title: 'Is anything unhealthy at the moment?', created_at: t - 20 * 60 * 1000, updated_at: t - 19 * 60 * 1000,
      messages: [
        msg(30, 3, 'user', 'Is anything unhealthy at the moment?'),
        msg(31, 3, 'assistant',
          'Yes — **demo-db** has been failing its health check for the last two polls. Its logs are full of "FATAL: sorry, too many clients already", and **demo-api** (which depends on it) is now logging ECONNREFUSED and serving 503s. The host itself is fine (CPU 14%, RAM 41%). This looks like a connection-pool leak in demo-db.',
          { calls: [
            { tool: 'list_containers', params: {}, ok: true, summary: '6 containers — demo-db health=unhealthy, others healthy/running' },
            { tool: 'get_docker_events', params: {}, ok: true, summary: 'demo-db: 2× health_status:unhealthy in the last 2 min' },
          ], suggestedIncident: { resourceType: 'container', externalId: 'demo-db', summary: 'demo-db failing health checks; demo-api dependent is serving 503s' } }),
      ],
    },
    {
      id: 2, title: 'Which containers restarted recently?', created_at: t - 90 * 60 * 1000, updated_at: t - 89 * 60 * 1000,
      messages: [
        msg(20, 2, 'user', 'Which containers restarted recently?'),
        msg(21, 2, 'assistant',
          'Two in the last day:\n• **demo-cache** — restarted twice about 4 hours ago (exit 0 both times), which raised and then-dismissed incident #4.\n• **legacy-cron** — ran and exited 0 roughly 40 minutes ago; that one is a scheduled job, not a crash.\nNothing else has a restart in its recent event history.',
          { calls: [
            { tool: 'get_docker_events', params: {}, ok: true, summary: 'demo-cache: restart ×2 (~4h ago); legacy-cron: die exit 0 (~40m ago)' },
          ], suggestedIncident: null }),
      ],
    },
    {
      id: 1, title: 'Summarise the state of this host in three lines.', created_at: t - 5 * HOUR, updated_at: t - 5 * HOUR + 60 * 1000,
      messages: [
        msg(10, 1, 'user', 'Summarise the state of this host in three lines.'),
        msg(11, 1, 'assistant',
          '1. Host healthy — CPU ~13%, RAM ~41%, disk 37%, load 0.4, uptime 11 days.\n2. All 5 managed services active except UFW (inactive by design here); Caddy is serving 4 sites, all HTTP 200.\n3. 6 containers up; demo-db is currently unhealthy (open incident #1), everything else is green.',
          { calls: [
            { tool: 'get_system_metrics', params: {}, ok: true, summary: 'CPU 12.8%, RAM 41.2%, disk 37%, load1 0.41, uptime 11d' },
            { tool: 'list_services', params: {}, ok: true, summary: 'docker/caddy/cloudflared/ssh active; ufw inactive' },
            { tool: 'list_containers', params: {}, ok: true, summary: '6 containers, demo-db unhealthy' },
          ], suggestedIncident: null }),
      ],
    },
  ];
}

// ─── AI credentials ──────────────────────────────────────────────────────────
function aiCredentials() {
  const t = now();
  const gemini = (id, model, extra = {}) => ({
    id, label: 'Google', provider: 'gemini', model, baseUrl: null,
    keySuffix: 'k1cQ', priority: id - 1, enabled: true,
    lastError: null, lastErrorAt: null, lastOkAt: null,
    rpmLimit: null, rpdLimit: null, cooldownUntil: null,
    usage: { lastMinute: 0, lastDay: 0 }, ...extra,
  });
  return [
    {
      id: 1, label: 'Primary', provider: 'openai-compatible',
      model: 'nvidia/nemotron-3-ultra-550b-a55b:free', baseUrl: 'https://openrouter.ai/api/v1',
      keySuffix: 'd9d9', priority: 0, enabled: true,
      lastError: null, lastErrorAt: null, lastOkAt: t - 30 * 60 * 1000,
      rpmLimit: null, rpdLimit: null, cooldownUntil: null,
      usage: { lastMinute: 0, lastDay: 7 },
    },
    gemini(2, 'gemini-3.7-flash', {
      lastError: 'Gemini API error (429): You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit. * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.7-flash Please retry in 46.088726495s.',
      lastErrorAt: t - 5 * HOUR,
      rpdLimit: 20, usage: { lastMinute: 0, lastDay: 20 },
    }),
    gemini(3, 'gemini-3.6-flash', { lastOkAt: t - 5 * HOUR }),
    gemini(4, 'gemini-3.5-flash'),
    gemini(5, 'gemini-3.5-flash-lite'),
    gemini(6, 'gemini-3.1-flash-lite'),
  ];
}

// ─── Settings ────────────────────────────────────────────────────────────────
const DETECTOR_DEFAULTS = {
  cooldownMs: 60000, unhealthyStreak: 2, resourceStreak: 3,
  cpuThresholdPercent: 90, ramThresholdPercent: 90, diskThresholdPercent: 90,
  deployCorrelationWindowMs: 900000,
};
const DETECTOR_LIMITS = {
  cooldownMs: { min: 5000, max: 86400000 },
  unhealthyStreak: { min: 1, max: 60 }, resourceStreak: { min: 1, max: 60 },
  cpuThresholdPercent: { min: 1, max: 100 }, ramThresholdPercent: { min: 1, max: 100 }, diskThresholdPercent: { min: 1, max: 100 },
  deployCorrelationWindowMs: { min: 60000, max: 86400000 },
};

function detector() {
  return { config: { ...DETECTOR_DEFAULTS }, defaults: { ...DETECTOR_DEFAULTS }, limits: DETECTOR_LIMITS };
}
function autoRemediate() {
  return {
    resources: ['container:demo-vps-demo-api-1'],
    allowedTools: ['start_service', 'restart_service', 'start_container', 'restart_container'],
    maxRisk: 'MEDIUM_RISK', maxPerHour: 3,
  };
}
function notify() {
  return {
    channels: {
      slack: { configured: false, masked: null },
      discord: { configured: false, masked: null },
      webhook: { configured: false, masked: null },
    },
    events: ['INCIDENT_AWAITING_APPROVAL', 'INCIDENT_RESOLVED', 'INCIDENT_FAILED'],
    baseUrl: '', approveLinks: false,
    availableEvents: ['INCIDENT_DETECTED', 'INCIDENT_AWAITING_APPROVAL', 'INCIDENT_AUTO_REMEDIATE', 'INCIDENT_RESOLVED', 'INCIDENT_FAILED'],
    availableChannels: ['slack', 'discord', 'webhook'],
  };
}
function access() {
  return { ownData: true, paths: [{ path: '/var/log', label: 'System & service logs' }], maxPaths: 25 };
}

// ─── Health overview ─────────────────────────────────────────────────────────
function healthSeed() {
  return {
    toolExecutions: {
      byTool: [
        { toolName: 'restart_container', count: 2, errorRate: 0, avgDurationMs: 1980, p95DurationMs: 2210 },
        { toolName: 'deploy_repository', count: 3, errorRate: 0, avgDurationMs: 41200, p95DurationMs: 52300 },
        { toolName: 'get_container_logs', count: 24, errorRate: 0, avgDurationMs: 132, p95DurationMs: 210 },
        { toolName: 'get_docker_events', count: 31, errorRate: 0, avgDurationMs: 71, p95DurationMs: 120 },
        { toolName: 'get_system_metrics', count: 48, errorRate: 0, avgDurationMs: 9, p95DurationMs: 18 },
      ],
      totalCalls: 108, totalErrors: 0,
    },
    aiRuns: {
      byCredential: [
        { credentialId: 1, label: 'Primary', requests: 9, promptTokens: 14820, completionTokens: 3110, avgLatencyMs: 4900, errorCount: 0 },
        { credentialId: 2, label: 'Google', requests: 20, promptTokens: 0, completionTokens: 0, avgLatencyMs: null, errorCount: 20 },
      ],
      byPurpose: [
        { purpose: 'diagnosis', requests: 6, promptTokens: 10200, completionTokens: 1980, avgLatencyMs: 5100 },
        { purpose: 'chat', requests: 21, promptTokens: 3900, completionTokens: 980, avgLatencyMs: 3200 },
        { purpose: 'report', requests: 2, promptTokens: 720, completionTokens: 150, avgLatencyMs: 6100 },
      ],
    },
    toolCount: 24,
    dbSizeKb: 1636,
  };
}

// ─── helpers ─────────────────────────────────────────────────────────────────
function rand(a, b) { return a + Math.random() * (b - a); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function round(v, dp) { const f = 10 ** dp; return Math.round(v * f) / f; }

export const CPU_MODEL = CPU_INFO;
export const MEM_TOTAL_BYTES = MEM_TOTAL;
export const DISK_TOTAL_BYTES = DISK_TOTAL;
export const DISK2_TOTAL_BYTES = DISK_TOTAL_2;

export function buildFixtures() {
  const inc = incidents();
  return {
    containers: containers(),
    services: services(),
    websites: websites(),
    repos: repos(),
    resources: resources(),
    incidents: inc,
    recordings: recordings(),
    activity: activity(),
    chatSessions: chatSessions(),
    aiCredentials: aiCredentials(),
    detector: detector(),
    autoRemediate: autoRemediate(),
    notify: notify(),
    access: access(),
    health: healthSeed(),
    recordingState: { recording: false, sessionId: null, sessionName: null, startTime: null, elapsed: 0, sampleCount: 0 },
    nextId: { incident: 100, action: 100, evidence: 100, session: 100, message: 1000, activity: 5000, recording: 100 },
  };
}
