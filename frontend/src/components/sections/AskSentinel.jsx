import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client';

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
        <span>{call.ok === false ? '⚠' : '🔧'}</span>
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
        {turn.refusals?.map((r, i) => <div key={i} className="chat-refused">🔒 {r.reason}</div>)}
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
              {turn.escalatedTo ? `→ Incident #${turn.escalatedTo}` : escalating ? 'Creating…' : '⚑ Create incident'}
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
  const endRef = useRef(null);
  const navigate = useNavigate();

  const loadSessions = useCallback(() => {
    api.get('/chat/sessions').then(setSessions).catch(() => {});
  }, []);

  useEffect(() => { loadSessions(); }, [loadSessions]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [turns]);

  async function openSession(id) {
    try {
      const s = await api.get(`/chat/sessions/${id}`);
      setSessionId(s.id);
      setTurns(s.messages.map(m => ({
        role: m.role,
        content: m.content,
        calls: m.toolCalls?.calls || null,
        suggestedIncident: m.toolCalls?.suggestedIncident || null
      })));
    } catch (err) {
      alert(err.message);
    }
  }

  function newSession() {
    setSessionId(null);
    setTurns([]);
    setInput('');
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
      loadSessions();
    }
  }

  function handleEvent(ev) {
    switch (ev.type) {
      case 'session':
        setSessionId(ev.sessionId);
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

  return (
    <div className="chat-layout">
      <div className="chat-sessions">
        <button className="btn btn-secondary btn-sm btn-full" id="btn-new-chat" onClick={newSession}>+ New chat</button>
        <div className="chat-session-list">
          {sessions.map(s => (
            <div
              key={s.id}
              className={`chat-session ${s.id === sessionId ? 'active' : ''}`}
              onClick={() => openSession(s.id)}
            >
              <span className="chat-session-title">{s.title}</span>
              <button className="btn-icon" onClick={(e) => removeSession(e, s.id)} title="Delete">✕</button>
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

        <form
          className="chat-input-row"
          onSubmit={(e) => { e.preventDefault(); send(); }}
        >
          <input
            id="chat-input"
            className="form-input"
            placeholder="Ask about CPU, containers, services, logs…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={busy}
          />
          <button id="btn-chat-send" className="btn btn-primary" type="submit" disabled={busy || !input.trim()}>
            {busy ? '…' : 'Ask'}
          </button>
        </form>
      </div>
    </div>
  );
}
