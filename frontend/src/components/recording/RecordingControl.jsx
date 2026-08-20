import { useState, useEffect, useRef } from 'react';

function fmt(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  return `${String(h).padStart(2,'0')}:${String(m%60).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
}

export default function RecordingControl() {
  const [state, setState]     = useState(null); // recording engine state
  const [name, setName]       = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [loading, setLoading] = useState(false);
  const tickRef = useRef(null);

  async function fetchState() {
    try {
      const r = await fetch('/api/recordings/state');
      const d = await r.json();
      setState(d);
      setElapsed(d.elapsed || 0);
    } catch {}
  }

  useEffect(() => {
    fetchState();
    // Poll state every 5s (recording state doesn't need WS)
    const poll = setInterval(fetchState, 5000);
    return () => clearInterval(poll);
  }, []);

  // Live elapsed counter when recording
  useEffect(() => {
    clearInterval(tickRef.current);
    if (state?.recording && state?.startTime) {
      tickRef.current = setInterval(() => {
        setElapsed(Date.now() - state.startTime);
      }, 1000);
    }
    return () => clearInterval(tickRef.current);
  }, [state?.recording, state?.startTime]);

  async function start() {
    setLoading(true);
    try {
      const r = await fetch('/api/recordings/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() || undefined })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setState(d);
      setName('');
    } catch (err) {
      alert(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function stop() {
    setLoading(true);
    try {
      const r = await fetch('/api/recordings/stop', { method: 'POST' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setState({ ...d, recording: false });
    } catch (err) {
      alert(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (!state) return null;

  return (
    <div className="recording-banner">
      {state.recording ? (
        <>
          <div className="recording-indicator">
            <div className="rec-dot" />
            <span style={{ color: 'var(--red)', fontWeight: 600 }}>Recording</span>
          </div>
          <div className="recording-stats">
            <span><strong>{state.sessionName || '—'}</strong></span>
            <span>Elapsed: <strong>{fmt(elapsed)}</strong></span>
            <span>Samples: <strong>{state.sampleCount}</strong></span>
          </div>
          <button
            id="btn-stop-recording"
            className="btn btn-danger btn-sm"
            onClick={stop}
            disabled={loading}
            style={{ marginLeft: 'auto' }}
          >
            {loading ? '…' : '⏹ Stop Recording'}
          </button>
        </>
      ) : (
        <>
          <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', fontWeight: 500 }}>
            Recording Mode
          </span>
          <input
            id="input-session-name"
            className="form-input"
            style={{ width: 200, padding: '4px 10px', fontSize: '0.8rem' }}
            placeholder="Session name (optional)"
            value={name}
            onChange={e => setName(e.target.value)}
          />
          <button
            id="btn-start-recording"
            className="btn btn-sm"
            style={{ background: 'var(--red)', color: '#fff', border: 'none' }}
            onClick={start}
            disabled={loading}
          >
            {loading ? '…' : '⏺ Start Recording'}
          </button>
          {state.sessionId && (
            <span style={{ fontSize: '0.72rem', color: 'var(--text-dim)', marginLeft: 8 }}>
              Last session #{state.sessionId}
            </span>
          )}
        </>
      )}
    </div>
  );
}
