/**
 * Scripted "Ask Sentinel" turns for the demo. No model is called — each
 * of the four suggestion questions has a hand-written sequence of tool
 * calls + an answer, streamed over SSE in the real wire format. Any other
 * question hits a generic fallback.
 *
 * A finished turn is persisted to state.chatSessions and announced via a
 * `chat` WS event, so history + the "answered elsewhere" toast work just
 * like the real thing.
 */
import { sseResponse } from './sse.js';
import { getState, mutate, nextId } from './state.js';
import { broadcast } from './liveSim.js';

const THINK = 700;
const TOOL = 1100;

function tc(tool, params = {}) { return { type: 'tool_call', tool, params }; }
function tr(tool, summary, ok = true) { return { type: 'tool_result', tool, ok, summary }; }
const thought = (text) => ({ type: 'thought', text });
const answer = (text) => ({ type: 'answer', text });

const SCRIPTS = {
  'Why is CPU high right now?': {
    steps: [
      { after: THINK, event: thought('Checking the live host metrics first.') },
      { after: 400, event: tc('get_system_metrics') },
      { after: TOOL, event: tr('get_system_metrics', 'CPU 41.2% (1m load 1.9), RAM 41%, temp 55°C — CPU is elevated but the host is not swapping.') },
      { after: THINK, event: thought('CPU is up but memory is fine — looking at what is actually running.') },
      { after: 300, event: tc('inspect_processes', { sort: 'cpu', limit: 5 }) },
      { after: TOOL, event: tr('inspect_processes', 'Top process: node (demo-worker) at 33% CPU, then postgres 6%, redis 3%. demo-worker started a batch job ~2 min ago.') },
      { after: 500, event: answer('CPU is elevated (~41%, 1-minute load 1.9) because **demo-worker** kicked off a batch job about two minutes ago and is sitting at ~33% CPU on its own. Memory, swap and temperature are all normal, and the spike is already trending down. Nothing is wrong — this is demo-worker doing scheduled work. If it does not settle within a few minutes it would be worth checking the job queue depth.') },
      { after: 200, event: 'done' },
    ],
  },
  'Is anything unhealthy at the moment?': {
    steps: [
      { after: THINK, event: thought('Listing every container and its health status.') },
      { after: 400, event: tc('list_containers') },
      { after: TOOL, event: tr('list_containers', '6 containers — demo-db health=unhealthy, demo-web/demo-api healthy, demo-cache/demo-worker running, legacy-cron exited(0).') },
      { after: THINK, event: thought('demo-db is unhealthy — checking recent events and whether anything depends on it.') },
      { after: 300, event: tc('get_docker_events') },
      { after: TOOL, event: tr('get_docker_events', 'demo-db: 2× health_status:unhealthy in the last 2 minutes. demo-api logs show ECONNREFUSED to demo-db:5432.') },
      { after: 400, event: { type: 'suggest_incident', resourceType: 'container', externalId: 'demo-db', summary: 'demo-db failing health checks; demo-api dependent is serving 503s' } },
      { after: 500, event: answer('Yes — **demo-db** has been failing its health check for the last two polls. Its logs are full of `FATAL: sorry, too many clients already`, which points to a connection-pool leak, and **demo-api** (which depends on it) is now logging `ECONNREFUSED` and returning 503s. The host itself is healthy. I can open an incident so this goes through the normal diagnose-and-approve flow.') },
      { after: 200, event: 'done' },
    ],
  },
  'Which containers restarted recently?': {
    steps: [
      { after: THINK, event: thought('Pulling the container lifecycle events the agent has observed.') },
      { after: 400, event: tc('get_docker_events') },
      { after: TOOL, event: tr('get_docker_events', 'demo-cache: restart ×2 (~4h ago, exit 0 both). legacy-cron: die exit 0 (~40m ago). No other restarts in the window.') },
      { after: 500, event: answer('Two things restarted recently:\n\n• **demo-cache** — restarted twice about four hours ago, exit code 0 both times. That flapping raised incident #4, which was then dismissed as noise.\n• **legacy-cron** — ran and exited 0 roughly 40 minutes ago. That is a scheduled job finishing normally, not a crash.\n\nEverything else has been up continuously.') },
      { after: 200, event: 'done' },
    ],
  },
  'Summarise the state of this host in three lines.': {
    steps: [
      { after: THINK, event: thought('Gathering metrics, services and containers.') },
      { after: 300, event: tc('get_system_metrics') },
      { after: 900, event: tr('get_system_metrics', 'CPU 13%, RAM 41%, disk 37%, load 0.4, uptime 11 days.') },
      { after: 200, event: tc('list_services') },
      { after: 800, event: tr('list_services', 'docker, caddy, cloudflared, ssh active; ufw inactive.') },
      { after: 200, event: tc('list_containers') },
      { after: 800, event: tr('list_containers', '6 containers up; demo-db unhealthy, rest healthy/running.') },
      { after: 500, event: answer('1. Host is healthy — CPU ~13%, RAM ~41%, disk 37%, load 0.4, up 11 days.\n2. All managed services active except UFW (off by design here); Caddy is serving 4 sites, all returning HTTP 200.\n3. 6 containers running — **demo-db is currently unhealthy** (open incident #1); everything else is green.') },
      { after: 200, event: 'done' },
    ],
  },
};

function fallback(question) {
  return {
    steps: [
      { after: THINK, event: thought('Checking the live host state.') },
      { after: 400, event: tc('get_system_metrics') },
      { after: TOOL, event: tr('get_system_metrics', 'CPU 13%, RAM 41%, disk 37%, load 0.4, temp 49°C, uptime 11 days.') },
      { after: 500, event: answer(`This is the Sentinel **demo** — every value here is fabricated, so I answered "${truncate(question)}" from the simulated host state. In the real product I run read-only tools against your actual VPS (metrics, containers, services, logs, git status, and files you allow) and can open an incident when I find something that needs fixing. Try one of the suggested questions for a fuller walkthrough.`) },
      { after: 200, event: 'done' },
    ],
  };
}
function truncate(s) { return s.length > 60 ? s.slice(0, 57) + '…' : s; }

/** POST /api/chat — returns a streaming Response. */
export function runChatStream({ message, sessionId }) {
  const s = getState();
  let session = sessionId ? s.chatSessions.find(x => x.id === Number(sessionId)) : null;
  const isNew = !session;
  if (!session) {
    session = { id: nextId('session'), title: truncate(message), created_at: Date.now(), updated_at: Date.now(), messages: [] };
    mutate(st => { st.chatSessions.unshift(session); });
  }

  // Persist the user's message immediately (matches routes/chat.js)
  mutate(() => {
    session.messages.push({ id: nextId('message'), session_id: session.id, role: 'user', content: message, tool_calls_json: null, created_at: Date.now(), toolCalls: null });
    session.updated_at = Date.now();
  });

  const script = SCRIPTS[message.trim()] || fallback(message.trim());

  const calls = [];
  let suggestedIncident = null;
  let finalAnswer = '';

  const steps = [
    { after: 30, event: { type: 'session', sessionId: session.id, title: session.title } },
    ...script.steps,
  ];

  const onFrame = (ev) => {
    if (ev.type === 'tool_call') calls.push({ tool: ev.tool, params: ev.params, ok: true, summary: '' });
    else if (ev.type === 'tool_result') {
      const c = [...calls].reverse().find(x => x.tool === ev.tool && !x.summary);
      if (c) { c.ok = ev.ok; c.summary = ev.summary; }
    } else if (ev.type === 'suggest_incident') {
      suggestedIncident = { resourceType: ev.resourceType, externalId: ev.externalId, summary: ev.summary };
    } else if (ev.type === 'answer') {
      finalAnswer = ev.text;
      // Persist the finished assistant turn + announce it.
      mutate(() => {
        const tcJson = (calls.length || suggestedIncident) ? { calls, suggestedIncident } : null;
        session.messages.push({
          id: nextId('message'), session_id: session.id, role: 'assistant',
          content: finalAnswer, tool_calls_json: tcJson ? JSON.stringify(tcJson) : null,
          created_at: Date.now(), toolCalls: tcJson,
        });
        session.updated_at = Date.now();
      });
      broadcast({ type: 'chat', data: { event: 'answered', sessionId: session.id, title: session.title, question: message, preview: finalAnswer.slice(0, 160) } });
    }
  };

  return sseResponse(steps, onFrame);
}
