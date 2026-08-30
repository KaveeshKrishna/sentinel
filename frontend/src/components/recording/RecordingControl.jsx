import { useState, useEffect, useRef } from 'react';
import { api } from '../../api/client';
import Icon from '../shared/Icon';

function fmt(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  return `${String(h).padStart(2,'0')}:${String(m%60).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
}

export default function RecordingControl() {
  const [state, setState]     = useState(null); // recording engine state
  const [elapsed, setElapsed] = useState(0);
  const [loading, setLoading] = useState(false);
  const [naming, setNaming]   = useState(false); // name-prompt popup open?
  const [pendingName, setPendingName] = useState('');
  const tickRef = useRef(null);

  async function fetchState() {
    try {
      const d = await api.get('/recordings/state');
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

  async function start(sessionName) {
    setLoading(true);
    try {
      const d = await api.post('/recordings/start', { name: sessionName?.trim() || undefined });
      setState(d);
      setNaming(false);
      setPendingName('');
    } catch (err) {
      alert(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function stop() {
    setLoading(true);
    try {
      const d = await api.post('/recordings/stop');
      setState({ ...d, recording: false });
    } catch (err) {
      alert(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (!state) return null;

  return (
    <>
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
          >
            {loading ? '…' : <><Icon name="square" size={12} /> Stop Recording</>}
          </button>
        </>
      ) : (
        <button
          id="btn-start-recording"
          className="btn btn-sm"
          style={{ background: 'var(--red)', color: '#fff', border: 'none' }}
          onClick={() => setNaming(true)}
          disabled={loading}
        >
          {loading ? '…' : <><Icon name="circle" size={12} /> Start Recording</>}
        </button>
      )}

      {naming && (
        <div className="modal-overlay" onClick={() => setNaming(false)}>
          <div className="modal-card" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Start Recording</div>
            <p className="modal-desc">
              Give this session a name so it's easy to find later, or leave it blank.
            </p>
            <input
              id="input-session-name"
              className="form-input"
              autoFocus
              placeholder="Session name (optional)"
              value={pendingName}
              onChange={e => setPendingName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') start(pendingName); }}
            />
            <div className="modal-actions">
              <button className="btn btn-secondary btn-sm" onClick={() => setNaming(false)} disabled={loading}>
                Cancel
              </button>
              <button
                id="btn-confirm-start-recording"
                className="btn btn-sm"
                style={{ background: 'var(--red)', color: '#fff', border: 'none' }}
                onClick={() => start(pendingName)}
                disabled={loading}
              >
                {loading ? '…' : <><Icon name="circle" size={12} /> Start Recording</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
