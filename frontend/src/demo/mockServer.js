/**
 * The demo's fake backend. Replaces window.fetch: every `/api/*` request
 * is served from demo state in the browser; everything else (fonts,
 * assets) falls through to the real fetch. There is no network backend in
 * the demo build, so nothing here can reach a real host.
 */
import { getState, mutate, nextId, isDemoAuthed, setDemoAuthed } from './state.js';
import { analyticsFor, genSamples } from './fixtures.js';
import { broadcast, withMeta } from './liveSim.js';
import { runChatStream } from './chatScript.js';
import { runDeployStream, runRollbackStream } from './deployScript.js';

const realFetch = window.fetch.bind(window);

export function installFetch() {
  window.fetch = demoFetch;
}

async function demoFetch(input, init = {}) {
  const url = typeof input === 'string' ? input : input.url;
  const method = (init.method || (typeof input !== 'string' && input.method) || 'GET').toUpperCase();

  let path;
  try { path = new URL(url, window.location.origin).pathname; }
  catch { return realFetch(input, init); }

  if (!path.startsWith('/api/')) return realFetch(input, init);

  const search = new URL(url, window.location.origin).searchParams;
  let body = {};
  try { if (init.body) body = JSON.parse(init.body); } catch { /* not json */ }

  await tick(); // a touch of latency so spinners flash like the real thing

  try {
    const res = route(method, path, { body, search });
    return res instanceof Response ? res : json(res ?? { ok: true });
  } catch (err) {
    if (err && err.__status) return json({ error: err.message }, err.__status);
    return json({ error: err.message || 'Demo error' }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}
function fail(status, message) { const e = new Error(message); e.__status = status; return e; }
function tick() { return new Promise(r => setTimeout(r, 90 + Math.random() * 120)); }
function jit(v, pct = 0.25) { return Math.max(0, +(v * (1 + (Math.random() - 0.5) * pct)).toFixed(2)); }

// ─── router ──────────────────────────────────────────────────────────────────
function route(method, path, ctx) {
  const s = getState();
  const p = path.replace(/^\/api/, '');
  const seg = p.split('/').filter(Boolean);
  const M = (str) => method === str;

  // auth / setup
  if (p === '/auth/login' && M('POST')) {
    const u = String(ctx.body.username || '').toLowerCase();
    const pw = String(ctx.body.password || '');
    if (u === 'demo' && pw === 'demo') {
      setDemoAuthed(true);
      pushActivity('LOGIN', 'demo signed in');
      return { ok: true, username: 'demo' };
    }
    throw fail(401, 'Invalid credentials');
  }
  if (p === '/auth/logout' && M('POST')) { setDemoAuthed(false); return { ok: true }; }
  if (p === '/auth/check') return { authenticated: isDemoAuthed(), username: 'demo' };
  if (p === '/setup/status') return { needsSetup: false };

  // docker
  if (p === '/docker/containers' && M('GET')) {
    return s.containers.map(c => ({ ...c, cpuPercent: c.state === 'running' ? jit(c.cpuPercent || 0.3) : 0, memUsage: c.state === 'running' ? Math.round(jit(c.memUsage || 1e7, 0.1)) : 0 }));
  }
  if (seg[0] === 'docker' && seg[1] === 'containers' && seg[3] === 'logs' && M('GET')) {
    return containerLogs(seg[2]);
  }
  if (seg[0] === 'docker' && seg[1] === 'containers' && ['start', 'stop', 'restart'].includes(seg[3]) && M('POST')) {
    const c = s.containers.find(x => x.id === seg[2] || x.name === seg[2] || x.shortId === seg[2]);
    if (!c) throw fail(502, 'No such container');
    mutate(() => {
      c.state = seg[3] === 'stop' ? 'exited' : 'running';
      c.status = c.state === 'running' ? 'Up 1 second' : 'Exited (0) 1 second ago';
      if (seg[3] === 'restart') c.restartCount++;
    });
    pushActivity(`DOCKER_${seg[3].toUpperCase()}`, `Container ${c.name} ${seg[3]}${seg[3] === 'stop' ? 'ped' : seg[3] === 'restart' ? 'ed' : 'ed'}`);
    return { ok: true };
  }

  // services
  if (p === '/services' && M('GET')) return { ...s.services };
  if (seg[0] === 'services' && seg[2] && M('POST')) {
    const svc = seg[1], action = seg[2];
    if (!['start', 'stop', 'restart'].includes(action)) throw fail(400, `Action "${action}" is not allowed`);
    mutate(() => {
      s.services[svc] = action === 'stop' ? 'inactive' : 'active';
      if (svc === 'docker') {
        for (const c of s.containers) {
          if (c.name === 'legacy-cron') continue;
          c.state = action === 'stop' ? 'exited' : 'running';
          c.status = c.state === 'running' ? 'Up 2 seconds (healthy)' : 'Exited (0) 1 second ago';
        }
      }
    });
    pushActivity(`SERVICE_${action.toUpperCase()}`, `Service "${svc}" ${action}${action === 'stop' ? 'ped' : action === 'restart' ? 'ed' : 'ed'}`);
    return { ok: true };
  }

  // deployments
  if (p === '/deployments' && M('GET')) return s.repos;
  if (seg[0] === 'deployments' && seg[2] === 'deploy' && M('POST')) return runDeployStream(decodeURIComponent(seg[1]));
  if (seg[0] === 'deployments' && seg[2] === 'rollback' && M('POST')) return runRollbackStream(decodeURIComponent(seg[1]), ctx.body.sha);

  // recordings
  if (p === '/recordings' && M('GET')) return s.recordings.map(stripSamples);
  if (p === '/recordings/state' && M('GET')) return recordingState();
  if (p === '/recordings/start' && M('POST')) return startRecording(ctx.body.name);
  if (p === '/recordings/stop' && M('POST')) return stopRecording();
  if (seg[0] === 'recordings' && seg[1] && M('GET')) {
    const rec = s.recordings.find(r => r.id === Number(seg[1]));
    if (!rec) throw fail(404, 'Session not found');
    const samples = rec._samples || [];
    return { session: { id: rec.id, name: rec.name, start_time: rec.start_time, end_time: rec.end_time, sample_count: samples.length }, samples, containerSamples: [], analytics: analyticsFor(samples) };
  }
  if (seg[0] === 'recordings' && seg[1] && M('DELETE')) {
    mutate(() => { s.recordings = s.recordings.filter(r => r.id !== Number(seg[1])); });
    return { ok: true };
  }

  // websites / network / activity
  if (p === '/websites' && M('GET')) return s.websites.map(w => ({ ...w, responseTime: Math.max(1, Math.round(jit(w.responseTime, 0.5))) }));
  if (p === '/network/stats' && M('GET')) return networkStats();
  if (p === '/activity' && M('GET')) return s.activity.map(withMeta).slice(0, 50);

  // incidents
  if (p === '/incidents' && M('GET')) {
    const st = ctx.search.get('status');
    return s.incidents.filter(i => !st || i.status === st).map(serializeIncident);
  }
  if (p === '/incidents' && M('DELETE')) {
    const st = ctx.search.get('status');
    const before = s.incidents.length;
    mutate(() => { s.incidents = st ? s.incidents.filter(i => i.status !== st) : []; });
    return { deleted: before - s.incidents.length };
  }
  if (seg[0] === 'incidents' && seg[1] && !seg[2] && M('GET')) {
    const inc = findIncident(seg[1]);
    return serializeIncidentDetail(inc);
  }
  if (seg[0] === 'incidents' && seg[1] && !seg[2] && M('DELETE')) {
    mutate(() => { s.incidents = s.incidents.filter(i => i.id !== Number(seg[1])); });
    return { deleted: 1 };
  }
  if (seg[0] === 'incidents' && seg[2] === 'timeline' && M('GET')) return findIncident(seg[1])._timeline;
  if (seg[0] === 'incidents' && seg[2] === 'report' && M('GET')) return reportFor(findIncident(seg[1]));
  if (seg[0] === 'incidents' && seg[2] === 'report' && M('POST')) { generateReport(findIncident(seg[1])); return reportFor(findIncident(seg[1])); }
  if (seg[0] === 'incidents' && seg[2] === 'approve' && M('POST')) return approveAction(findIncident(seg[1]), ctx.body.actionId);
  if (seg[0] === 'incidents' && ['diagnose', 'rediagnose', 'ai-diagnose'].includes(seg[2]) && M('POST')) return diagnose(findIncident(seg[1]));
  if (seg[0] === 'incidents' && seg[2] === 'dismiss' && M('POST')) return dismiss(findIncident(seg[1]));

  // resources / tools
  if (p === '/resources' && M('GET')) return s.resources;
  if (p === '/tools' && M('GET')) return toolCatalog();

  // health
  if (p === '/health/overview' && M('GET')) return healthOverview(ctx.search.get('aiWindow'));

  // settings
  if (p === '/settings/detector' && M('GET')) return s.detector;
  if (p === '/settings/detector' && M('PUT')) { mutate(() => { s.detector.config = { ...s.detector.config, ...numeric(ctx.body) }; }); return s.detector; }
  if (p === '/settings/detector' && M('DELETE')) { mutate(() => { s.detector.config = { ...s.detector.defaults }; }); return s.detector; }

  if (p === '/settings/auto-remediate' && M('GET')) return s.autoRemediate;
  if (p === '/settings/auto-remediate' && M('PUT')) { mutate(() => { s.autoRemediate.resources = ctx.body.resources || []; }); return s.autoRemediate; }

  if (p === '/settings/notify' && M('GET')) return s.notify;
  if (p === '/settings/notify' && M('PUT')) return saveNotify(ctx.body);
  if (p === '/settings/notify' && M('DELETE')) { mutate(() => { for (const k of Object.keys(s.notify.channels)) s.notify.channels[k] = { configured: false, masked: null }; }); return s.notify; }
  if (p === '/settings/notify/test' && M('POST')) return { ok: true, results: { slack: { ok: true, status: 200 } } };

  if (p === '/settings/access' && M('GET')) return s.access;
  if (p === '/settings/access' && M('PUT')) {
    mutate(() => {
      if (ctx.body.ownData !== undefined) s.access.ownData = !!ctx.body.ownData;
      if (ctx.body.paths !== undefined) s.access.paths = ctx.body.paths;
    });
    return s.access;
  }

  if (p === '/settings/ai/credentials' && M('GET')) return { credentials: s.aiCredentials, providers: ['anthropic', 'gemini', 'openai-compatible'] };
  if (p === '/settings/ai/credentials' && M('POST')) return addCredential(ctx.body);
  if (p === '/settings/ai/credentials/order' && M('PUT')) return reorderCredentials(ctx.body.ids);
  if (seg[0] === 'settings' && seg[1] === 'ai' && seg[2] === 'credentials' && seg[4] === 'test' && M('POST')) return testCredential(Number(seg[3]));
  if (seg[0] === 'settings' && seg[1] === 'ai' && seg[2] === 'credentials' && seg[3] && M('PUT')) return updateCredential(Number(seg[3]), ctx.body);
  if (seg[0] === 'settings' && seg[1] === 'ai' && seg[2] === 'credentials' && seg[3] && M('DELETE')) {
    mutate(() => { s.aiCredentials = s.aiCredentials.filter(c => c.id !== Number(seg[3])).map((c, i) => ({ ...c, priority: i })); });
    return { ok: true, credentials: s.aiCredentials };
  }

  // chat
  if (p === '/chat' && M('POST')) return runChatStream({ message: ctx.body.message, sessionId: ctx.body.sessionId });
  if (p === '/chat/sessions' && M('GET')) return s.chatSessions.map(({ messages, ...rest }) => rest);
  if (p === '/chat/running' && M('GET')) return { running: [] };
  if (seg[0] === 'chat' && seg[1] === 'sessions' && seg[2] && !seg[3] && M('GET')) {
    const sess = s.chatSessions.find(x => x.id === Number(seg[2]));
    if (!sess) throw fail(404, 'Session not found');
    return sess;
  }
  if (seg[0] === 'chat' && seg[1] === 'sessions' && seg[2] && !seg[3] && M('DELETE')) {
    mutate(() => { s.chatSessions = s.chatSessions.filter(x => x.id !== Number(seg[2])); });
    return { deleted: 1 };
  }
  if (seg[0] === 'chat' && seg[1] === 'sessions' && seg[3] === 'stop' && M('POST')) return { stopped: true };
  if (p === '/chat/escalate' && M('POST')) return escalate(ctx.body);

  throw fail(404, 'Not found');
}

// ─── helpers ─────────────────────────────────────────────────────────────────
function pushActivity(type, message) {
  const s = getState();
  const e = { id: nextId('activity'), type, message, timestamp: Date.now(), details: null };
  mutate(() => { s.activity = [e, ...s.activity].slice(0, 50); });
  broadcast({ type: 'activity', data: withMeta(e) });
}
function numeric(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = Number(v);
  return out;
}
function stripSamples({ _samples, ...rest }) { return rest; }

function containerLogs(idOrName) {
  const lines = [
    { stream: 'stdout', text: `[${new Date().toISOString()}] ${idOrName} demo log — this is fabricated data` },
    { stream: 'stdout', text: 'GET /health 200 3ms' },
    { stream: 'stdout', text: 'GET /health 200 2ms' },
    { stream: 'stderr', text: 'warn: slow query (128ms) SELECT * FROM orders' },
    { stream: 'stdout', text: 'GET /health 200 2ms' },
  ];
  return lines;
}

function recordingState() {
  const s = getState().recordingState;
  return { ...s, elapsed: s.startTime ? Date.now() - s.startTime : 0 };
}
function startRecording(name) {
  const s = getState();
  if (s.recordingState.recording) throw fail(400, 'Already recording');
  const id = nextId('recording');
  mutate(() => {
    s.recordingState = { recording: true, sessionId: id, sessionName: name || `Session ${new Date().toLocaleString('en-GB', { hour12: false })}`, startTime: Date.now(), elapsed: 0, sampleCount: 0 };
  });
  pushActivity('RECORDING_START', `Recording "${s.recordingState.sessionName}" started`);
  return recordingState();
}
function stopRecording() {
  const s = getState();
  if (!s.recordingState.recording) throw fail(400, 'No recording in progress');
  const { sessionId, sessionName, startTime } = s.recordingState;
  const end = Date.now();
  const samples = genSamples(sessionId, startTime, Math.max(end, startTime + 60_000), 'calm');
  const agg = analyticsFor(samples);
  mutate(() => {
    s.recordings.unshift({
      id: sessionId, name: sessionName, start_time: startTime, end_time: end,
      sample_count: samples.length, avg_cpu: agg.avgCpu, peak_temp: agg.maxTemp, avg_ram: agg.avgRam, max_load: agg.maxLoad, avg_temp: agg.avgTemp,
      _samples: samples,
    });
    s.recordingState = { recording: false, sessionId: null, sessionName: null, startTime: null, elapsed: 0, sampleCount: 0 };
  });
  pushActivity('RECORDING_STOP', `Recording "${sessionName}" stopped`);
  return { ...recordingState(), recording: false };
}

function networkStats() {
  return {
    caddy: {
      requestsPerMinute: Math.round(jit(38, 0.4)), totalRequests: Math.round(jit(2140, 0.1)),
      domains: { 'demo-shop.example.com': 1180, 'sentinel.example.com': 640, 'demo-api.example.com': 210, 'demo-blog.example.com': 110 },
      statusCodes: { 200: 2010, 304: 90, 404: 28, 502: 2 },
      avgResponseTime: Math.round(jit(31, 0.3)), errors4xx: 28, errors5xx: 2, available: true,
    },
    sshSessions: 1, cloudflareTunnel: 'running', publicIp: null, lanIp: null,
  };
}

// incidents -----------------------------------------------------------------
function findIncident(id) {
  const inc = getState().incidents.find(i => i.id === Number(id));
  if (!inc) throw fail(404, 'Incident not found');
  return inc;
}
function resourceOf(resourceId) {
  return getState().resources.find(r => r.id === resourceId) || null;
}
function serializeIncident(inc) {
  const r = resourceOf(inc.resource_id);
  return {
    id: inc.id, resource_id: inc.resource_id, status: inc.status, severity: inc.severity,
    trigger_rule: inc.trigger_rule, trigger_summary: inc.trigger_summary,
    root_cause: inc.root_cause, confidence: inc.confidence,
    diagnosis_raw_text: inc.diagnosis_raw_text || null,
    detected_at: inc.detected_at, updated_at: inc.updated_at, resolved_at: inc.resolved_at,
    report_json: inc.report_json || null, report_generated_at: inc.report_generated_at || null,
    diagnosis: inc.diagnosis_json ? JSON.parse(inc.diagnosis_json) : null,
    resourceName: r?.name ?? null, resourceType: r?.type ?? null,
  };
}
function serializeIncidentDetail(inc) {
  return {
    ...serializeIncident(inc),
    evidence: (inc._evidence || []).map(e => ({ ...e })),
    actions: (inc._actions || []).map(a => ({ ...a })),
  };
}
function diagnose(inc) {
  if (inc.status === 'DISMISSED' || inc.status === 'RESOLVED' || inc.status === 'FAILED') throw fail(409, 'Incident is closed');
  const t = Date.now();
  mutate(() => {
    inc._evidence = [
      { id: nextId('evidence'), incident_id: inc.id, resource_id: inc.resource_id, source_tool: 'get_system_metrics', summary: 'Host CPU sustained 91–96% over 3 polls; RAM 43%, disk 37% — not memory or disk bound.', data: null, collected_at: t - 8000 },
      { id: nextId('evidence'), incident_id: inc.id, resource_id: 6, source_tool: 'inspect_processes', summary: 'node (demo-worker) at 71% CPU running a batch import; postgres 9%.', data: null, collected_at: t - 5000 },
      { id: nextId('evidence'), incident_id: inc.id, resource_id: inc.resource_id, source_tool: 'inspect_git_status', summary: 'demo-web deployed 19h ago, demo-api 5h ago — no deploy correlates with the spike.', data: null, collected_at: t - 3000 },
    ];
    inc.root_cause = 'demo-worker is running an unbounded batch import single-threaded and is CPU-pinned. It is not a leak or a bad deploy — the job is simply larger than usual. Restarting the worker will drop it, or it will clear on its own in a few minutes.';
    inc.confidence = 0.74;
    inc.diagnosis_json = JSON.stringify({
      rootCause: inc.root_cause, confidence: 0.74,
      evidence: inc._evidence.map(e => e.summary),
      affectedComponents: ['demo-worker'],
      recommendedActions: [{ tool: 'restart_container', params: { id: 'demo-worker' }, risk: 'MEDIUM_RISK', rationale: 'Drop the runaway batch job; the queue will retry it' }],
      requiresApproval: true,
    });
    inc._actions = [{
      id: nextId('action'), incident_id: inc.id, tool_name: 'restart_container',
      params: { id: 'demo-worker' }, params_json: JSON.stringify({ id: 'demo-worker' }),
      claimed_risk: 'MEDIUM_RISK', real_risk: 'MEDIUM_RISK',
      rationale: 'Drop the runaway batch job; the queue will retry it',
      status: 'proposed', approved_by: null, approved_at: null, approved_via: null,
      executed_at: null, result_json: null, error: null, created_at: t,
    }];
    inc.status = 'AWAITING_APPROVAL';
    inc.updated_at = t;
    inc._timeline = {
      phases: [ph('OBSERVE', 'done', t - 60000), ph('DIAGNOSE', 'done', t - 4000), ph('PLAN', 'active', t), ph('ACT', 'pending', null), ph('VERIFY', 'pending', null)],
      entries: [
        { kind: 'transition', phase: 'OBSERVE', at: inc.detected_at, from: null, to: 'DETECTED' },
        { kind: 'transition', phase: 'OBSERVE', at: t - 9000, from: 'DETECTED', to: 'INVESTIGATING' },
        { kind: 'tool', phase: 'OBSERVE', at: t - 8000, tool: 'get_system_metrics', status: 'ok', realRisk: 'READ_ONLY', durationMs: 11 },
        { kind: 'tool', phase: 'OBSERVE', at: t - 5000, tool: 'inspect_processes', status: 'ok', realRisk: 'READ_ONLY', durationMs: 190 },
        { kind: 'ai', phase: 'DIAGNOSE', at: t - 4000, purpose: 'diagnosis', provider: 'openai-compatible', model: 'nvidia/nemotron-3-ultra-550b-a55b:free', attempt: 1, ok: true, promptTokens: 1710, completionTokens: 288, latencyMs: 4900 },
        { kind: 'transition', phase: 'DIAGNOSE', at: t - 4000, from: 'INVESTIGATING', to: 'DIAGNOSED' },
        { kind: 'action', phase: 'PLAN', at: t, tool: 'restart_container', realRisk: 'MEDIUM_RISK', status: 'proposed' },
        { kind: 'transition', phase: 'PLAN', at: t, from: 'DIAGNOSED', to: 'AWAITING_APPROVAL' },
      ],
    };
  });
  pushActivity('INCIDENT_DIAGNOSED', `Incident #${inc.id} diagnosed (confidence 74%)`);
  broadcastIncident(inc);
  return serializeIncident(inc);
}
function approveAction(inc, actionId) {
  const action = (inc._actions || []).find(a => a.id === Number(actionId));
  if (!action) throw fail(400, 'actionId is required');
  const readOnly = action.real_risk === 'READ_ONLY';
  const t = Date.now();
  mutate(() => {
    action.status = readOnly ? 'executed' : 'executed';
    action.approved_via = 'ui';
    action.approved_at = t;
    action.executed_at = t + 1500;
    action.result_json = JSON.stringify({ ok: true });
    if (!readOnly) { inc.status = 'REMEDIATING'; inc.updated_at = t; }
  });
  pushActivity('INCIDENT_ACTION_EXECUTED', `Incident #${inc.id}: ran ${action.tool_name}`);
  broadcastIncident(inc);

  if (!readOnly) {
    setTimeout(() => {
      mutate(() => { inc.status = 'VERIFYING'; inc.updated_at = Date.now(); });
      broadcastIncident(inc);
    }, 2600);
    setTimeout(() => {
      const done = Date.now();
      mutate(() => {
        inc.status = 'RESOLVED';
        inc.resolved_at = done;
        inc.updated_at = done;
        inc._timeline = resolvedTimeline(inc, t);
        if (!inc.report_json) generateReport(inc);
      });
      pushActivity('INCIDENT_RESOLVED', `Incident #${inc.id} resolved`);
      broadcastIncident(inc);
    }, 5400);
  }
  return serializeIncident(inc);
}
function dismiss(inc) {
  mutate(() => { inc.status = 'DISMISSED'; inc.resolved_at = Date.now(); inc.updated_at = Date.now(); });
  pushActivity('INCIDENT_DISMISSED', `Incident #${inc.id} dismissed`);
  broadcastIncident(inc);
  return serializeIncident(inc);
}
function escalate(bodyIn) {
  const s = getState();
  const id = nextId('incident');
  const t = Date.now();
  const inc = {
    id, resource_id: 1, status: 'DETECTED', severity: 'medium',
    trigger_rule: 'user_reported',
    trigger_summary: bodyIn.summary || `Reported via Ask Sentinel: ${bodyIn.externalId}`,
    root_cause: null, confidence: null, diagnosis_json: null, diagnosis_raw_text: null,
    detected_at: t, updated_at: t, resolved_at: null, report_json: null, report_generated_at: null,
    _evidence: [], _actions: [],
    _timeline: { phases: [ph('OBSERVE', 'active', t), ph('DIAGNOSE', 'pending', null), ph('PLAN', 'pending', null), ph('ACT', 'pending', null), ph('VERIFY', 'pending', null)], entries: [{ kind: 'transition', phase: 'OBSERVE', at: t, from: null, to: 'DETECTED' }] },
  };
  mutate(() => { s.incidents.unshift(inc); });
  pushActivity('INCIDENT_DETECTED', `Incident #${id} detected: ${inc.trigger_summary}`);
  broadcastIncident(inc);
  return { incidentId: id, existing: false };
}
function broadcastIncident(inc) {
  broadcast({ type: 'incident', data: { id: inc.id, status: inc.status, previousStatus: null, severity: inc.severity, resourceId: inc.resource_id, triggerRule: inc.trigger_rule, triggerSummary: inc.trigger_summary, rootCause: inc.root_cause, updatedAt: inc.updated_at } });
}
function ph(phase, status, at) { return { phase, status, at }; }
function resolvedTimeline(inc, approvedAt) {
  const base = inc._timeline || { entries: [], phases: [] };
  return {
    phases: [ph('OBSERVE', 'done', inc.detected_at), ph('DIAGNOSE', 'done', approvedAt - 4000), ph('PLAN', 'done', approvedAt), ph('ACT', 'done', approvedAt + 1500), ph('VERIFY', 'done', Date.now())],
    entries: [
      ...base.entries.filter(e => e.kind !== 'transition' || e.to !== 'AWAITING_APPROVAL'),
      { kind: 'action', phase: 'PLAN', at: approvedAt, tool: inc._actions?.[0]?.tool_name || 'restart_container', realRisk: 'MEDIUM_RISK', status: 'executed', approvedVia: 'ui', approved: true },
      { kind: 'transition', phase: 'ACT', at: approvedAt + 500, from: 'AWAITING_APPROVAL', to: 'REMEDIATING' },
      { kind: 'tool', phase: 'ACT', at: approvedAt + 1500, tool: inc._actions?.[0]?.tool_name || 'restart_container', status: 'ok', approved: true, realRisk: 'MEDIUM_RISK', durationMs: 1900 },
      { kind: 'transition', phase: 'VERIFY', at: approvedAt + 3000, from: 'REMEDIATING', to: 'VERIFYING' },
      { kind: 'tool', phase: 'VERIFY', at: Date.now() - 500, tool: inc._actions?.[0]?.tool_name || 'restart_container', status: 'ok', approved: true, realRisk: 'MEDIUM_RISK', durationMs: 110 },
      { kind: 'transition', phase: 'VERIFY', at: Date.now(), from: 'VERIFYING', to: 'RESOLVED' },
    ],
  };
}

// reports -----------------------------------------------------------------
function reportFor(inc) {
  if (!inc.report_json) return { report: null, markdown: null, generatedAt: null };
  const report = JSON.parse(inc.report_json);
  return { report, generatedAt: inc.report_generated_at, markdown: reportMarkdown(report, inc) };
}
function generateReport(inc) {
  const report = {
    title: inc.root_cause ? inc.trigger_summary : `Incident #${inc.id}`,
    summary: inc.root_cause || 'Sentinel resolved this incident.',
    impact: 'Brief service disruption on the affected component; no data loss.',
    rootCause: inc.root_cause || 'See diagnosis.',
    resolution: `Sentinel ran ${inc._actions?.[0]?.tool_name || 'a remediation'} and verified the component returned to a healthy state.`,
    timeline: (inc._timeline?.entries || []).slice(0, 8).map(e => `${new Date(e.at).toLocaleTimeString('en-GB', { hour12: false })}  ${e.kind === 'transition' ? `${e.from || 'open'} → ${e.to}` : `${e.tool || e.purpose || e.kind}`}`),
    prevention: ['Add resource limits / alerts for the affected component', 'Review the change that preceded the incident'],
  };
  mutate(() => { inc.report_json = JSON.stringify(report); inc.report_generated_at = Date.now(); });
}
function reportMarkdown(r, inc) {
  const lines = [`# ${r.title}`, '', `**Status:** ${inc.status}`, ''];
  const sec = (h, t) => t && lines.push(`## ${h}`, '', t, '');
  sec('Summary', r.summary); sec('Impact', r.impact); sec('Root cause', r.rootCause); sec('Resolution', r.resolution);
  if (r.timeline?.length) { lines.push('## Timeline', '', ...r.timeline.map(x => `- ${x}`), ''); }
  if (r.prevention?.length) { lines.push('## Prevention', '', ...r.prevention.map(x => `- ${x}`), ''); }
  return lines.join('\n');
}

// health ------------------------------------------------------------------
function healthOverview(win) {
  const s = getState().health;
  const windowMs = { '24h': 86400000, '7d': 604800000, '15d': 1296000000, '30d': 2592000000 }[win] || 604800000;
  return {
    agent: { reachable: true, latencyMs: 4 + Math.round(Math.random() * 8), toolCount: s.toolCount, error: null },
    db: { sizeKb: s.dbSizeKb + Math.round(Math.random() * 8) },
    toolExecutions: s.toolExecutions,
    aiRuns: { ...s.aiRuns, windowMs },
  };
}

// AI credentials --------------------------------------------------------------
function suffix(key) { const k = String(key || ''); return k.length <= 4 ? k || 'xxxx' : k.slice(-4); }
function addCredential(b) {
  const s = getState();
  const cred = {
    id: nextId('incident') + 900, label: b.label || 'New provider', provider: b.provider || 'anthropic',
    model: b.model || null, baseUrl: b.baseUrl || null, keySuffix: suffix(b.apiKey),
    priority: s.aiCredentials.length, enabled: true,
    lastError: null, lastErrorAt: null, lastOkAt: null,
    rpmLimit: b.rpmLimit ? Number(b.rpmLimit) : null, rpdLimit: b.rpdLimit ? Number(b.rpdLimit) : null,
    cooldownUntil: null, usage: { lastMinute: 0, lastDay: 0 },
  };
  mutate(() => { s.aiCredentials.push(cred); });
  return cred;
}
function updateCredential(id, b) {
  const s = getState();
  const c = s.aiCredentials.find(x => x.id === id);
  if (!c) throw fail(404, 'Not found');
  mutate(() => {
    if (b.label !== undefined) c.label = b.label;
    if (b.provider !== undefined) c.provider = b.provider;
    if (b.model !== undefined) c.model = b.model || null;
    if (b.baseUrl !== undefined) c.baseUrl = b.baseUrl || null;
    if (b.apiKey) { c.keySuffix = suffix(b.apiKey); c.lastError = null; c.lastErrorAt = null; }
    if (b.rpmLimit !== undefined) c.rpmLimit = b.rpmLimit ? Number(b.rpmLimit) : null;
    if (b.rpdLimit !== undefined) c.rpdLimit = b.rpdLimit ? Number(b.rpdLimit) : null;
    if (b.enabled !== undefined) c.enabled = !!b.enabled;
  });
  return c;
}
function reorderCredentials(ids) {
  const s = getState();
  mutate(() => {
    const byId = new Map(s.aiCredentials.map(c => [c.id, c]));
    s.aiCredentials = ids.map((id, i) => { const c = byId.get(id); if (c) c.priority = i; return c; }).filter(Boolean);
  });
  return { credentials: s.aiCredentials };
}
function testCredential(id) {
  const s = getState();
  const c = s.aiCredentials.find(x => x.id === id);
  if (!c) throw fail(404, 'Not found');
  // Credential #2 demonstrates the out-of-quota UX.
  if (c.id === 2 || (c.provider === 'gemini' && c.rpdLimit && c.usage?.lastDay >= c.rpdLimit)) {
    mutate(() => { c.lastError = c.lastError || 'Gemini API error (429): quota exceeded for the free tier (limit 20/day).'; c.lastErrorAt = Date.now(); });
    throw fail(502, 'Gemini API error (429): You exceeded your current quota. Quota exceeded for metric: generate_content_free_tier_requests, limit: 20.');
  }
  mutate(() => { c.lastOkAt = Date.now(); c.lastError = null; c.lastErrorAt = null; });
  return { ok: true, sample: 'OK', credential: c };
}
function saveNotify(b) {
  const s = getState();
  mutate(() => {
    for (const ch of ['slack', 'discord', 'webhook']) {
      const key = `${ch}Url`;
      if (b[key] !== undefined) {
        s.notify.channels[ch] = b[key]
          ? { configured: true, masked: maskUrl(b[key]) }
          : { configured: false, masked: null };
      }
    }
    if (b.events !== undefined) s.notify.events = b.events;
    if (b.baseUrl !== undefined) s.notify.baseUrl = b.baseUrl;
    if (b.approveLinks !== undefined) s.notify.approveLinks = !!b.approveLinks;
  });
  return s.notify;
}
function maskUrl(u) {
  try { const url = new URL(u); return `${url.host}…${u.slice(-6)}`; } catch { return `…${String(u).slice(-6)}`; }
}

function toolCatalog() {
  const ro = (name, description, params = {}) => ({ name, description, parameters: { type: 'object', properties: params, additionalProperties: false }, risk: 'READ_ONLY', hasVerify: false });
  const mut = (name, description, risk, params) => ({ name, description, parameters: { type: 'object', properties: params, required: Object.keys(params), additionalProperties: false }, risk, hasVerify: true });
  return [
    ro('get_system_metrics', 'CPU/memory/disk/network snapshot'),
    ro('get_metric_history', 'Rolling 60s metric history'),
    ro('list_containers', 'List Docker containers'),
    ro('get_container_logs', 'Recent container logs', { id: { type: 'string' } }),
    ro('get_docker_events', 'Recent container lifecycle events'),
    ro('list_services', 'List managed systemd services'),
    ro('get_service_logs', 'Recent journal lines for a service', { service: { type: 'string' } }),
    ro('inspect_network', 'Caddy / SSH / tunnel status'),
    ro('get_website_health', 'Reverse-proxy site reachability'),
    ro('inspect_git_status', 'Git status for deploy repos'),
    ro('inspect_processes', 'Top processes by CPU/memory'),
    mut('restart_container', 'Restart a container', 'MEDIUM_RISK', { id: { type: 'string' } }),
    mut('start_container', 'Start a stopped container', 'LOW_RISK', { id: { type: 'string' } }),
    mut('stop_container', 'Stop a running container', 'MEDIUM_RISK', { id: { type: 'string' } }),
    mut('restart_service', 'Restart a managed service', 'MEDIUM_RISK', { service: { type: 'string' } }),
    mut('start_service', 'Start a managed service', 'LOW_RISK', { service: { type: 'string' } }),
    mut('deploy_repository', 'Fetch, pull, build and up a repo', 'MEDIUM_RISK', { repo: { type: 'string' } }),
    mut('rollback_repository', 'git reset --hard then redeploy', 'MEDIUM_RISK', { repo: { type: 'string' }, sha: { type: 'string' } }),
  ];
}
