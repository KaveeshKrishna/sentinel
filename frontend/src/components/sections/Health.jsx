import { useState, useEffect } from 'react';
import { api } from '../../api/client';

function relativeLatency(ms) {
  if (ms == null) return '—';
  return `${ms}ms`;
}

const AI_WINDOWS = [
  { id: '24h', label: 'Last 24 hours' },
  { id: '7d',  label: 'Last 7 days' },
  { id: '15d', label: 'Last 15 days' },
  { id: '30d', label: 'Last month' }
];

function Tile({ label, ok, warn, value, detail }) {
  const tone = ok ? 'green' : warn ? 'yellow' : 'red';
  return (
    <div className="card" style={{ flex: '1 1 200px' }}>
      <div className="card-title">{label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span className={`badge badge-${tone}`}>
          <span className="badge-dot" style={{ background: `var(--${tone})` }} />
          {value}
        </span>
      </div>
      {detail && <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{detail}</div>}
    </div>
  );
}

/**
 * Sentinel's own health and AI spend — an answer to "what is this
 * costing me and is it working", which previously required reading the
 * database by hand (scripts/ai-runs.js, scripts/why-no-incident.js).
 *
 * Every AI module's failure path deliberately records usage:null (see
 * ai/chat.js, ai/orchestrator.js, ai/report.js) — a retried attempt still
 * cost a request but its token count is unknown, so the totals below are
 * a floor, not an exact figure. Noted inline rather than fixed, since
 * changing that would touch three modules' error paths for a display-only
 * number.
 */
export default function Health() {
  const [data, setData]       = useState(null);
  const [credentials, setCredentials] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [aiWindow, setAiWindow] = useState('7d');

  async function load() {
    try {
      const [overview, credResp] = await Promise.all([
        api.get(`/health/overview?aiWindow=${aiWindow}`),
        api.get('/settings/ai/credentials')
      ]);
      setData(overview);
      setCredentials(credResp.credentials || []);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiWindow]);

  if (loading) return <div className="empty-state"><div className="boot-spinner" /></div>;
  if (error || !data) return <div className="empty-state"><p>{error || 'No data'}</p></div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <Tile
          label="Agent"
          ok={data.agent.reachable}
          value={data.agent.reachable ? `Reachable — ${relativeLatency(data.agent.latencyMs)}` : 'Unreachable'}
          detail={data.agent.reachable ? `${data.agent.toolCount} tools registered` : data.agent.error}
        />
        <Tile
          label="Database"
          ok={true}
          value={`${(data.db.sizeKb / 1024).toFixed(1)} MB`}
        />
        <Tile
          label="AI providers"
          ok={credentials.some(c => c.enabled && !c.lastError)}
          warn={credentials.some(c => c.enabled)}
          value={credentials.length === 0 ? 'Not configured' : `${credentials.filter(c => c.enabled).length} enabled`}
          detail={credentials.filter(c => c.lastError).length > 0
            ? `${credentials.filter(c => c.lastError).length} reporting an error — see Settings`
            : null}
        />
      </div>

      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div className="card-title" style={{ marginBottom: 0 }}>AI spend</div>
          <select
            id="select-ai-spend-window"
            className="form-input"
            style={{ width: 'auto', padding: '5px 10px', fontSize: '0.8rem' }}
            value={aiWindow}
            onChange={e => setAiWindow(e.target.value)}
          >
            {AI_WINDOWS.map(w => <option key={w.id} value={w.id}>{w.label}</option>)}
          </select>
        </div>
        <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '10px 0 12px' }}>
          A failed provider attempt still costs a request but its token count is unknown — totals below are a
          floor, not an exact figure.
        </p>
        {data.aiRuns.byCredential.length === 0 ? (
          <div className="empty-state" style={{ padding: '18px 0' }}>
            <p>No AI requests in the {AI_WINDOWS.find(w => w.id === aiWindow)?.label.toLowerCase()}.</p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Credential</th>
                  <th>Requests</th>
                  <th>Prompt tokens</th>
                  <th>Completion tokens</th>
                  <th>Avg latency</th>
                  <th>Errors</th>
                </tr>
              </thead>
              <tbody>
                {data.aiRuns.byCredential.map(c => (
                  <tr key={c.credentialId ?? 'env'}>
                    <td>{c.label}</td>
                    <td>{c.requests}</td>
                    <td>{c.promptTokens.toLocaleString()}</td>
                    <td>{c.completionTokens.toLocaleString()}</td>
                    <td>{relativeLatency(c.avgLatencyMs)}</td>
                    <td>{c.errorCount > 0 ? <span style={{ color: 'var(--red)' }}>{c.errorCount}</span> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {data.aiRuns.byPurpose.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: 6 }}>By purpose</div>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              {data.aiRuns.byPurpose.map(p => (
                <div key={p.purpose} style={{ fontSize: '0.82rem' }}>
                  <span className="mono" style={{ color: 'var(--accent)' }}>{p.purpose}</span>{' '}
                  {p.requests} req · {(p.promptTokens + p.completionTokens).toLocaleString()} tok
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-title">Slowest tools — last 24h</div>
        {data.toolExecutions.byTool.length === 0 ? (
          <div className="empty-state" style={{ padding: '18px 0' }}>
            <p>No tool calls in the last 24 hours.</p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Tool</th>
                  <th>Calls</th>
                  <th>Error rate</th>
                  <th>Avg</th>
                  <th>p95</th>
                </tr>
              </thead>
              <tbody>
                {data.toolExecutions.byTool.map(t => (
                  <tr key={t.toolName}>
                    <td className="mono">{t.toolName}</td>
                    <td>{t.count}</td>
                    <td>{t.errorRate > 0 ? <span style={{ color: 'var(--red)' }}>{Math.round(t.errorRate * 100)}%</span> : '0%'}</td>
                    <td>{relativeLatency(t.avgDurationMs)}</td>
                    <td>{relativeLatency(t.p95DurationMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p style={{ fontSize: '0.72rem', color: 'var(--text-dim)', marginTop: 10 }}>
          Counts tool calls made on an incident's behalf (evidence-gathering, remediation, verification, Ask
          Sentinel) plus deploys/rollbacks. An ordinary Docker/service start-stop-restart click from the UI
          isn't yet audited this way.
        </p>
      </div>
    </div>
  );
}
