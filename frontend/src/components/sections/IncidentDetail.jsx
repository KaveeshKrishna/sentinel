import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import StatusBadge from '../shared/StatusBadge';

const RISK_COLOR = {
  READ_ONLY: 'var(--text-muted)',
  LOW_RISK: 'var(--green)',
  MEDIUM_RISK: 'var(--yellow)',
  HIGH_RISK: '#f97316',
  DESTRUCTIVE: 'var(--red)'
};

function fmtDate(ts) {
  return ts ? new Date(ts).toLocaleString('en-GB', { hour12: false }) : '—';
}

function RiskTag({ risk }) {
  if (!risk) return null;
  return (
    <span style={{
      fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em',
      color: RISK_COLOR[risk] || 'var(--text-dim)'
    }}>
      {risk.replace('_', ' ')}
    </span>
  );
}

export default function IncidentDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [incident, setIncident] = useState(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [busyActionId, setBusyActionId] = useState(null);
  const [dismissing, setDismissing] = useState(false);

  const load = useCallback(async () => {
    try {
      setIncident(await api.get(`/incidents/${id}`));
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  async function approve(actionId) {
    setBusyActionId(actionId);
    try {
      await api.post(`/incidents/${id}/approve`, { actionId });
      await load();
    } catch (err) {
      alert(err.message);
    } finally {
      setBusyActionId(null);
    }
  }

  async function dismiss() {
    if (!confirm('Dismiss this incident? This cannot be undone.')) return;
    setDismissing(true);
    try {
      await api.post(`/incidents/${id}/dismiss`);
      await load();
    } catch (err) {
      alert(err.message);
    } finally {
      setDismissing(false);
    }
  }

  if (loading) return <div className="empty-state"><div className="boot-spinner" /></div>;
  if (error || !incident) return (
    <div className="empty-state">
      <p>{error || 'Incident not found'}</p>
      <button className="btn btn-secondary btn-sm" onClick={() => navigate('/incidents')}>← Back to Incidents</button>
    </div>
  );

  const isTerminal = ['RESOLVED', 'FAILED', 'DISMISSED'].includes(incident.status);
  const diagnosis = incident.diagnosis;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button id="btn-back-incidents" className="btn btn-secondary btn-sm" onClick={() => navigate('/incidents')}>← Back</button>
        <div style={{ fontSize: '1rem', fontWeight: 600 }}>Incident #{incident.id}</div>
        <StatusBadge status={incident.status} />
        {!isTerminal && (
          <button id="btn-dismiss-incident" className="btn btn-danger btn-sm" style={{ marginLeft: 'auto' }} onClick={dismiss} disabled={dismissing}>
            {dismissing ? '…' : '✕ Dismiss'}
          </button>
        )}
      </div>

      <div className="card">
        <div className="card-title">Overview</div>
        <div className="info-row"><span className="info-key">Resource</span><span className="info-val">{incident.resourceName || `#${incident.resource_id}`} {incident.resourceType && `(${incident.resourceType})`}</span></div>
        <div className="info-row"><span className="info-key">Severity</span><span className="info-val" style={{ textTransform: 'uppercase' }}>{incident.severity}</span></div>
        <div className="info-row"><span className="info-key">Trigger</span><span className="info-val mono">{incident.trigger_rule}</span></div>
        <div className="info-row"><span className="info-key">Summary</span><span className="info-val">{incident.trigger_summary}</span></div>
        <div className="info-row"><span className="info-key">Detected</span><span className="info-val">{fmtDate(incident.detected_at)}</span></div>
        {incident.resolved_at && (
          <div className="info-row"><span className="info-key">Resolved</span><span className="info-val">{fmtDate(incident.resolved_at)}</span></div>
        )}
      </div>

      {diagnosis ? (
        <div className="card">
          <div className="card-title">🧠 AI Diagnosis</div>
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>Root Cause</div>
            <div style={{ fontSize: '0.95rem' }}>{diagnosis.rootCause}</div>
          </div>
          <div className="info-row"><span className="info-key">Confidence</span><span className="info-val">{Math.round((diagnosis.confidence ?? 0) * 100)}%</span></div>
          {diagnosis.affectedComponents?.length > 0 && (
            <div className="info-row"><span className="info-key">Affected</span><span className="info-val">{diagnosis.affectedComponents.join(', ')}</span></div>
          )}
        </div>
      ) : incident.diagnosis_raw_text ? (
        <div className="card">
          <div className="card-title">⚠ Diagnosis Failed to Parse</div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', whiteSpace: 'pre-wrap', fontFamily: 'var(--mono)' }}>
            {incident.diagnosis_raw_text}
          </div>
        </div>
      ) : null}

      {incident.actions?.length > 0 && (
        <div className="card">
          <div className="card-title">⚙ Recommended Actions</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {incident.actions.map(action => (
              <div key={action.id} id={`action-${action.id}`} style={{
                border: '1px solid var(--border)', borderRadius: 'var(--r)', padding: 12,
                display: 'flex', flexDirection: 'column', gap: 6
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <span className="mono" style={{ fontWeight: 600 }}>{action.tool_name}</span>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <RiskTag risk={action.real_risk} />
                    <span className="badge badge-gray">{action.status}</span>
                  </div>
                </div>
                {action.rationale && <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>{action.rationale}</div>}
                {Object.keys(action.params || {}).length > 0 && (
                  <div className="mono" style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>
                    {JSON.stringify(action.params)}
                  </div>
                )}
                {action.error && <div style={{ fontSize: '0.8rem', color: 'var(--red)' }}>Error: {action.error}</div>}
                {incident.status === 'AWAITING_APPROVAL' && action.status === 'proposed' && (
                  <div>
                    <button
                      id={`btn-approve-${action.id}`}
                      className="btn btn-success btn-sm"
                      onClick={() => approve(action.id)}
                      disabled={busyActionId === action.id}
                    >
                      {busyActionId === action.id ? 'Executing…' : '✓ Approve & Execute'}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {incident.evidence?.length > 0 && (
        <div className="card">
          <div className="card-title">📎 Evidence</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {incident.evidence.map(ev => (
              <div key={ev.id} style={{ borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                  <span className="mono" style={{ fontSize: '0.75rem', color: 'var(--accent)' }}>{ev.source_tool}</span>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>{fmtDate(ev.collected_at)}</span>
                </div>
                <div style={{ fontSize: '0.82rem', marginTop: 2 }}>{ev.summary}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
