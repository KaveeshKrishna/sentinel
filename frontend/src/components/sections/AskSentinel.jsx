import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import Icon from '../shared/Icon';
import { useLiveEvents } from '../../hooks/useWebSocket';

const SUGGESTIONS = [
  'Why is CPU high right now?',
  'Is anything unhealthy at the moment?',
  'Which containers restarted recently?',
  'Summarise the state of this host in three lines.'
];

function ToolChip({ call }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="chat-tool">
      <button className="chat-tool-head" onClick={() => setOpen(o => !o)}>
        <span>{call.ok === false ? <Icon name="alert-triangle" size={13} /> : <Icon name="wrench" size={13} />}</span>
        <span className="mono">{call.tool}</span>
        {call.params && Object.keys(call.params).length > 0 && (
          <span className="chat-tool-params mono">{JSON.stringify(call.params)}</span>
        )}
        <span className="chat-tool-caret">{open ? '▾' : '▸'}</span>
      </button>
      {open && <pre className="chat-tool-out">{call.summary || (call.running ? 'Running…' : '')}</pre>}
    </div>
  );
}

function Turn({ turn, onEscalate, escalating }) {
  if (turn.role === 'user') {
    return <div className="chat-turn chat-user"><div className="chat-bubble">{turn.content}</div></div>;
  }
  return (
    <div className="chat-turn chat-assistant">
      <div className="chat-avatar">◆</div>
      <div className="chat-body">
        {turn.thought && <div className="chat-thought">{turn.thought}</div>}
        {turn.calls?.map((c, i) => <ToolChip key={i} call={c} />)}
        {turn.refusals?.map((r, i) => <div key={i} className="chat-refused"><Icon name="lock" size={13} /> {r.reason}</div>)}
        {turn.content && <div className="chat-answer">{turn.content}</div>}
        {turn.error && <div className="error-msg">{turn.error}</div>}
        {turn.pending && !turn.content && <div className="chat-thinking"><span /><span /><span /></div>}
        {turn.suggestedIncident && (
          <div className="chat-suggest">
            <div>
              <strong>Sentinel found something actionable.</strong>
              <div className="chat-suggest-detail">
                {turn.suggestedIncident.resourceType} <span className="mono">{turn.suggestedIncident.externalId}</span>
                {turn.suggestedIncident.summary && ` — ${turn.suggestedIncident.summary}`}
              </div>
            </div>
            <button
              className="btn btn-primary btn-sm"
              id="btn-escalate-incident"
              disabled={escalating || turn.escalatedTo}
              onClick={() => onEscalate(turn)}
            >
              {turn.escalatedTo ? `→ Incident #${turn.escalatedTo}` : escalating ? 'Creating…' : <><Icon name="flag" size={12} /> Create incident</>}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Conversational access to the host, streamed.
 *
 * Sentinel answers by actually running read-only tools and showing you
 * which ones — the tool chips are the point, not decoration. It cannot
 * change anything; when it finds something that needs fixing it offers
 * to open a real incident, which then goes through the normal approval
 * flow like any other.
 */
export default function AskSentinel() {
  const [turns, setTurns] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [sessionId, setSessionId] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [escalating, setEscalating] = useState(false);
  // Chat history is a permanent left column on desktop but hidden on
  // phone width (see .chat-sessions media rules) — this opens it as a
  // second, right-hand drawer instead, alongside the sidebar's own
  // hamburger, rather than losing access to past conversations entirely.
  const [historyOpen, setHistoryOpen] = useState(false);
  // Sessions with a turn currently running server-side — not just this
  // one. A turn now outlives its own stream (ai/chatRuns.js), so this is
  // what lets a reopened conversation, or a *different* one the operator
  // switches to while another is still thinking, show that honestly
  // instead of looking finished or idle.
  const [runningSessions, setRunningSessions] = useState(() => new Set());
  const endRef = useRef(null);
  // The session whose turn is currently streaming. Held in a ref because
  // Stop must target the right conversation even after the operator has
  // clicked into a different one.
  const runningSessionRef = useRef(null);
  const navigate = useNavigate();
  const { lastChat, chatTick } = useLiveEvents();

  const loadSessions = useCallback(() => {
    api.get('/chat/sessions').then(setSessions).catch(() => {});
  }, []);

  const loadRunning = useCallback(() => {
    api.get('/chat/running')
      .then(({ running }) => setRunningSessions(new Set(running.map(r => r.sessionId))))
      .catch(() => {});
  }, []);

  useEffect(() => { loadSessions(); }, [loadSessions]);

  // Poll for what's running elsewhere (another tab, or a turn this
  // component instance didn't itself start) — the WS 'chat' event below
  // covers the *finish* of a turn but nothing announces a start.
  useEffect(() => {
    loadRunning();
    const t = setInterval(loadRunning, 4000);
    return () => clearInterval(t);
  }, [loadRunning]);

  // A turn finished — announced whether or not anyone is watching it.
  // Drop it from the running set, refresh the session list (title/order),
  // and if it's the conversation currently open, pull in the real answer
  // in place of the placeholder openSession() shows for a running turn.
  const seenChatTick = useRef(0);
  useEffect(() => {
    if (!lastChat || chatTick === seenChatTick.current) return;
    seenChatTick.current = chatTick;
    setRunningSessions(prev => {
      if (!prev.has(lastChat.sessionId)) return prev;
      const next = new Set(prev);
      next.delete(lastChat.sessionId);
      return next;
    });
    loadSessions();
    if (lastChat.sessionId === sessionId) openSession(sessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastChat, chatTick]);

  // Deep link from the "answer landed" toast — a turn finishes even when
  // the operator has navigated away, so the notification has to be able
  // to bring them back to the right conversation.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const wanted = Number(searchParams.get('session'));
    if (!wanted) return;
    openSession(wanted);
    setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [turns]);

  async function openSession(id) {
    setHistoryOpen(false);
    try {
      const s = await api.get(`/chat/sessions/${id}`);
      setSessionId(s.id);
      const mapped = s.messages.map(m => ({
        role: m.role,
        content: m.content,
        calls: m.toolCalls?.calls || null,
        suggestedIncident: m.toolCalls?.suggestedIncident || null
      }));
      // A running turn's user message is persisted immediately, before
      // its reply — so a still-thinking conversation naturally ends on a
      // user turn with nothing after it. Show that honestly (a pending
      // bubble, Stop instead of Ask) rather than a conversation that
      // looks like it's just waiting on the operator.
      if (mapped.length > 0 && mapped[mapped.length - 1].role === 'user' && runningSessions.has(id)) {
        mapped.push({ role: 'assistant', pending: true, calls: [], refusals: [] });
        runningSessionRef.current = id;
      }
      setTurns(mapped);
    } catch (err) {
      alert(err.message);
    }
  }

  function newSession() {
    setSessionId(null);
    setTurns([]);
    setInput('');
    setHistoryOpen(false);
  }

  async function removeSession(e, id) {
    e.stopPropagation();
    if (!confirm('Delete this conversation?')) return;
    try {
      await api.del(`/chat/sessions/${id}`);
      if (id === sessionId) newSession();
      loadSessions();
    } catch (err) {
      alert(err.message);
    }
  }

  /**
   * Stop a turn that is mid-thought.
   *
   * The turn runs server-side and no longer dies when this component
   * unmounts or the tab closes, so this is the only way to end one early
   * — which is why it needs the session id even if the stream has since
   * detached.
   */
  async function stop() {
    const target = runningSessionRef.current ?? sessionId;
    if (!target) return;
    try {
      await api.post(`/chat/sessions/${target}/stop`, {});
    } catch { /* already finished — nothing to stop */ }
  }

  /** Mutate the in-flight assistant turn (always the last one). */
  function patchLast(fn) {
    setTurns(prev => {
      const next = [...prev];
      next[next.length - 1] = fn({ ...next[next.length - 1] });
      return next;
    });
  }

  async function send(question) {
    const q = (question ?? input).trim();
    if (!q || busy) return;
    setInput('');
    setBusy(true);
    setTurns(prev => [...prev, { role: 'user', content: q }, { role: 'assistant', pending: true, calls: [], refusals: [] }]);

    try {
      // Raw fetch, not api.client: this response is an SSE stream and we
      // need its ReadableStream reader (same as Deployments' deploy log).
      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: q, sessionId })
      });
      if (resp.status === 401) { window.location.href = '/login'; return; }
      if (!resp.ok || !resp.body) throw new Error(`Request failed (${resp.status})`);

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop();
        for (const part of parts) {
          const dataLine = part.split('\n').find(l => l.startsWith('data:'));
          if (!dataLine) continue;
          let ev;
          try { ev = JSON.parse(dataLine.slice(5)); } catch { continue; }
          handleEvent(ev);
        }
      }
    } catch (err) {
      patchLast(t => ({ ...t, pending: false, error: err.message }));
    } finally {
      setBusy(false);
      setRunningSessions(prev => {
        if (!runningSessionRef.current || !prev.has(runningSessionRef.current)) return prev;
        const next = new Set(prev);
        next.delete(runningSessionRef.current);
        return next;
      });
      runningSessionRef.current = null;
      loadSessions();
    }
  }

  function handleEvent(ev) {
    switch (ev.type) {
      case 'session':
        setSessionId(ev.sessionId);
        runningSessionRef.current = ev.sessionId;
        setRunningSessions(prev => new Set(prev).add(ev.sessionId));
        // So the new conversation appears in history immediately, not
        // only once it has an answer — the row exists server-side (and
        // already carries the operator's own question) the moment this
        // event arrives.
        loadSessions();
        break;
      case 'stopped':
        patchLast(t => ({
          ...t, pending: false, thought: null,
          content: t.content || '(stopped)'
        }));
        break;
      case 'thought':
        patchLast(t => ({ ...t, thought: ev.text }));
        break;
      case 'tool_call':
        patchLast(t => ({ ...t, calls: [...(t.calls || []), { tool: ev.tool, params: ev.params, running: true }] }));
        break;
      case 'tool_result':
        patchLast(t => {
          const calls = [...(t.calls || [])];
          for (let i = calls.length - 1; i >= 0; i--) {
            if (calls[i].tool === ev.tool && calls[i].running) {
              calls[i] = { ...calls[i], running: false, ok: ev.ok, summary: ev.summary };
              break;
            }
          }
          return { ...t, calls };
        });
        break;
      case 'tool_refused':
        patchLast(t => ({ ...t, refusals: [...(t.refusals || []), { reason: ev.reason }] }));
        break;
      case 'answer':
        patchLast(t => ({ ...t, pending: false, thought: null, content: ev.text }));
        break;
      case 'suggest_incident':
        patchLast(t => ({ ...t, suggestedIncident: { resourceType: ev.resourceType, externalId: ev.externalId, summary: ev.summary } }));
        break;
      case 'error':
        patchLast(t => ({ ...t, pending: false, error: ev.message }));
        break;
      default:
        break;
    }
  }

  async function escalate(turn) {
    setEscalating(true);
    try {
      const { incidentId } = await api.post('/chat/escalate', turn.suggestedIncident);
      patchLast(t => ({ ...t, escalatedTo: incidentId }));
      navigate(`/incidents/${incidentId}`);
    } catch (err) {
      alert(err.message);
    } finally {
      setEscalating(false);
    }
  }

  // Whether the conversation on screen right now is thinking — either
  // this component instance started that turn (busy), or it's running
  // elsewhere and the operator has switched to look at it.
  const isCurrentBusy = busy || (sessionId != null && runningSessions.has(sessionId));
  const otherRunning = [...runningSessions].filter(id => id !== sessionId);

  return (
    <div className="chat-layout">
      {historyOpen && <div className="chat-history-backdrop" onClick={() => setHistoryOpen(false)} />}

      <div className={`chat-sessions ${historyOpen ? 'mobile-open' : ''}`}>
        <button className="btn btn-secondary btn-sm btn-full" id="btn-new-chat" onClick={newSession}>+ New chat</button>
        <div className="chat-session-list">
          {sessions.map(s => (
            <div
              key={s.id}
              className={`chat-session ${s.id === sessionId ? 'active' : ''}`}
              onClick={() => openSession(s.id)}
            >
              <span className="chat-session-title">{s.title}</span>
              {runningSessions.has(s.id) && (
                <span className="chat-session-running" title="Still thinking" />
              )}
              <button className="btn-icon" onClick={(e) => removeSession(e, s.id)} title="Delete"><Icon name="x" size={12} /></button>
            </div>
          ))}
          {sessions.length === 0 && <div className="chat-session-empty">No conversations yet.</div>}
        </div>
      </div>

      <div className="chat-main">
        <div className="chat-scroll">
          {turns.length === 0 && (
            <div className="chat-welcome">
              <div className="chat-welcome-title">Ask Sentinel about this host</div>
              <div className="chat-welcome-sub">
                It answers by running read-only tools against the live system — you'll see exactly which.
                It can't change anything; if it finds a real problem it will offer to open an incident.
              </div>
              <div className="chat-suggestions">
                {SUGGESTIONS.map(s => (
                  <button key={s} className="chat-suggestion" onClick={() => send(s)}>{s}</button>
                ))}
              </div>
            </div>
          )}
          {turns.map((t, i) => (
            <Turn key={i} turn={t} onEscalate={escalate} escalating={escalating} />
          ))}
          <div ref={endRef} />
        </div>

        {otherRunning.length > 0 && (
          <div className="chat-elsewhere-notice">
            <Icon name="clock" size={13} />
            {otherRunning.length === 1
              ? <><strong>{sessions.find(s => s.id === otherRunning[0])?.title || 'Another conversation'}</strong> is still thinking…</>
              : <>{otherRunning.length} other conversations are still thinking…</>}
          </div>
        )}

        <form
          className="chat-input-row"
          onSubmit={(e) => { e.preventDefault(); send(); }}
        >
          {/* Mobile-only: .chat-sessions is a hidden drawer at this
              width (see the max-width:768px rules), so this is the only
              way in to past conversations — a second, smaller
              "hamburger" next to the sidebar's own, opening chat
              history instead of navigation. */}
          <button
            id="btn-chat-history"
            type="button"
            className="btn btn-secondary btn-icon chat-history-dock-btn"
            onClick={() => setHistoryOpen(true)}
            aria-label="Chat history"
            title="Chat history"
          >
            <Icon name="clock" size={16} />
          </button>
          <input
            id="chat-input"
            className="form-input"
            placeholder={isCurrentBusy ? "Thinking — you can leave this page, the answer will be saved…" : "Ask about CPU, containers, services, logs…"}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={isCurrentBusy}
          />
          {isCurrentBusy ? (
            // The turn continues server-side whether or not this page is
            // open, so stopping has to be a deliberate act rather than a
            // side effect of navigating away.
            <button id="btn-chat-stop" className="btn btn-danger" type="button" onClick={stop}>
              ■ Stop
            </button>
          ) : (
            <button id="btn-chat-send" className="btn btn-primary" type="submit" disabled={!input.trim()}>
              Ask
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
