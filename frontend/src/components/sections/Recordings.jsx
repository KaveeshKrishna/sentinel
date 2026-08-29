import { useState, useEffect, lazy, Suspense } from 'react';
import { api } from '../../api/client';
import Icon from '../shared/Icon';

// Lazy-load chart library only on Recordings tab
const SessionReport = lazy(() => import('./SessionReport'));

function fmt(ms) {
  if (!ms) return '—';
  const s = Math.floor(ms/1000), m = Math.floor(s/60), h = Math.floor(m/60), d = Math.floor(h/24);
  if (d > 0) return `${d}d ${h%24}h ${m%60}m`;
  if (h > 0) return `${h}h ${m%60}m`;
  return `${m}m`;
}

function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('en-GB', { hour12: false, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function HealthLabel({ label, score }) {
  const cls = {
    Excellent: 'excellent', Good: 'good', Fair: 'fair', Poor: 'poor', Critical: 'critical'
  }[label] || 'good';
  return <span className={`health-score ${cls}`}>{score}/100 · {label}</span>;
}

export default function Recordings() {
  const [sessions, setSessions]   = useState([]);
  const [loading,  setLoading]    = useState(true);
  const [selected, setSelected]   = useState(null); // session ID to view

  async function load() {
    try { setSessions(await api.get('/recordings')); }
    finally { setLoading(false); }
  }

  async function deleteSession(id, e) {
    e.stopPropagation();
    if (!confirm('Delete this recording session?')) return;
    await api.del(`/recordings/${id}`);
    if (selected === id) setSelected(null);
    load();
  }

  useEffect(() => { load(); }, []);

  if (selected !== null) {
    return (
      <Suspense fallback={<div className="empty-state"><div className="boot-spinner" /></div>}>
        <SessionReport sessionId={selected} onBack={() => setSelected(null)} onDeleted={() => { setSelected(null); load(); }} />
      </Suspense>
    );
  }

  if (loading) return <div className="empty-state"><div className="boot-spinner" /></div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {sessions.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon"><Icon name="circle" size={32} /></div>
          <p>No recordings yet. Use the banner above to start a session.</p>
        </div>
      ) : (
        <div className="card">
          <div className="card-title"><Icon name="hard-drive" /> Recording Sessions ({sessions.length})</div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>#</th><th>Name</th><th>Date</th><th>Duration</th><th>Samples</th>
                  <th>Avg CPU</th><th>Avg RAM</th><th>Peak Temp</th><th></th>
                </tr>
              </thead>
              <tbody>
                {sessions.map(s => (
                  <tr key={s.id} id={`session-row-${s.id}`} onClick={() => setSelected(s.id)}>
                    <td className="mono" style={{ color: 'var(--text-dim)' }}>{s.id}</td>
                    <td style={{ fontWeight: 500 }}>{s.name}</td>
                    <td className="mono" style={{ fontSize: '0.78rem' }}>{fmtDate(s.start_time)}</td>
                    <td className="mono">{fmt(s.end_time ? s.end_time - s.start_time : null)}</td>
                    <td className="mono">{s.sample_count}</td>
                    <td className="mono">{s.avg_cpu != null ? `${s.avg_cpu}%` : '—'}</td>
                    <td className="mono">{s.avg_ram != null ? `${s.avg_ram}%` : '—'}</td>
                    <td className="mono">{s.peak_temp != null ? `${s.peak_temp}°C` : '—'}</td>
                    <td>
                      <button
                        id={`btn-delete-session-${s.id}`}
                        className="btn btn-danger btn-sm btn-icon"
                        onClick={e => deleteSession(s.id, e)}
                        title="Delete session"
                      >
                        <Icon name="x" size={11} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
