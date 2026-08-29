import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import StatusBadge from '../shared/StatusBadge';
import IncidentTimeline from './IncidentTimeline';
import IncidentReport from './IncidentReport';
import { useLiveEvents } from '../../hooks/useWebSocket';
import Icon from '../shared/Icon';

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
  const [deleting, setDeleting] = useState(false);
  const [rediagnosing, setRediagnosing] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const { lastIncident, incidentTick } = useLiveEvents();

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

  // The engine advances an incident through several states on its own
  // (INVESTIGATING -> DIAGNOSED -> ... and auto-remediation end to end).
  // Refetch when the server says *this* incident changed, so the page
  // follows along instead of showing a stale state until a manual action.
  useEffect(() => {
    if (lastIncident && String(lastIncident.id) === String(id)) load();
  }, [incidentTick, lastIncident, id, load]);

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

  async function rediagnose() {
    setRediagnosing(true);
    try {
      await api.post(`/incidents/${id}/diagnose`);
      await load();
    } catch (err) {
      alert(err.message);
    } finally {
      setRediagnosing(false);
    }
  }

  /**
   * "Ask AI instead" — for when a runbook-matched diagnosis isn't
   * trusted this time. A different route than rediagnose()'s: a
   * runbook-only incident has no evidence gathered yet, so this one
   * runs the full gather-then-diagnose pass server-side.
   */
  async function askAiInstead() {
    setRediagnosing(true);
    try {
      await api.post(`/incidents/${id}/ai-diagnose`);
      await load();
    } catch (err) {
      alert(err.message);
    } finally {
      setRediagnosing(false);
    }
  }

  /**
   * A direct, human-initiated rollback — the click itself is the
   * approval, exactly like the Deploy button on the Deployments page,
   * and independent of the incident's own AI-recommendation/approval
   * flow (which handles a rollback the AI proposes, via the normal
   * Recommended Actions card below). Drains the route's SSE response the
   * same way Deployments.jsx's own deploy() does — no live log display
   * here, just a busy state, since this card only needs the outcome.
   */
  async function rollback(repoName, sha) {
    if (!confirm(`Roll back "${repoName}" to ${sha.slice(0, 7)}? This runs git reset --hard and re-deploys.`)) return;
    setRollingBack(true);
    try {
      const resp = await fetch(`/api/deployments/${encodeURIComponent(repoName)}/rollback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sha })
      });
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let lastError = null;
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (const part of buffer.split('\n\n').slice(0, -1)) {
          const line = part.split('\n').find(l => l.startsWith('data:'));
          if (!line) continue;
          try {
            const ev = JSON.parse(line.slice(5));
            if (ev.type === 'error') lastError = ev.data;
          } catch { /* ignore keepalive/malformed frames */ }
        }
        buffer = buffer.split('\n\n').slice(-1)[0];
      }
      if (lastError) alert(lastError);
      await load();
    } catch (err) {
      alert(err.message);
    } finally {
      setRollingBack(false);
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

  async function remove() {
    if (!confirm(`Delete incident #${id}? This permanently removes it and its evidence, actions and AI runs.`)) return;
    setDeleting(true);
    try {
      await api.del(`/incidents/${id}`);
      navigate('/incidents');
    } catch (err) {
      alert(err.message);
      setDeleting(false);
    }
  }

  if (loading) return <div className="empty-state"><div className="boot-spinner" /></div>;
  if (error || !incident) return (
    <div className="empty-state">
      <p>{error || 'Incident not found'}</p>
      <button className="btn btn-secondary btn-sm" onClick={() => navigate('/incidents')}><Icon name="chevron-left" size={12} /> Back to Incidents</button>
    </div>
  );

  const isTerminal = ['RESOLVED', 'FAILED', 'DISMISSED'].includes(incident.status);
  const diagnosis = incident.diagnosis;
  const deployEvidence = incident.evidence?.find(e => e.source_tool === 'deploy_correlation');
  const deploy = deployEvidence?.data;
  const recommendedRollback = incident.actions?.find(a => a.tool_name === 'rollback_repository' && a.status === 'proposed');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button id="btn-back-incidents" className="btn btn-secondary btn-sm" onClick={() => navigate('/incidents')}><Icon name="chevron-left" size={12} /> Back</button>
        <div style={{ fontSize: '1rem', fontWeight: 600 }}>Incident #{incident.id}</div>
        <StatusBadge status={incident.status} />
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {!isTerminal && (
            <button
              id="btn-rediagnose-incident"
              className={`btn btn-sm ${incident.status === 'DETECTED' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={rediagnose}
              disabled={rediagnosing}
              title={incident.status === 'DETECTED'
                ? 'Gather evidence and ask the AI for a root cause. Uses one provider request.'
                : 'Re-run the AI diagnosis against all evidence gathered so far'}
            >
              {rediagnosing
                ? 'Diagnosing…'
                : incident.status === 'DETECTED' ? <><Icon name="search" size={12} /> Diagnose</> : <><Icon name="refresh-cw" size={12} /> Re-diagnose</>}
            </button>
          )}
          {!isTerminal && (
            <button id="btn-dismiss-incident" className="btn btn-danger btn-sm" onClick={dismiss} disabled={dismissing}>
              {dismissing ? '…' : <><Icon name="x" size={12} /> Dismiss</>}
            </button>
          )}
          <button id="btn-delete-incident" className="btn btn-secondary btn-sm" onClick={remove} disabled={deleting}>
            {deleting ? '…' : <><Icon name="trash" size={12} /> Delete</>}
          </button>
        </div>
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

      <IncidentTimeline incidentId={incident.id} refreshKey={incidentTick} />

      <IncidentReport incidentId={incident.id} isTerminal={isTerminal} refreshKey={incidentTick} />

      {deploy && (
        <div className="card" style={{ borderColor: 'var(--yellow)' }}>
          <div className="card-title"><Icon name="zap" /> Deploy Correlation</div>
          <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginBottom: 10 }}>
            <strong style={{ color: 'var(--text)' }}>{deploy.repo_name}</strong> was deployed{' '}
            <strong style={{ color: 'var(--yellow)' }}>{deployEvidence.summary.match(/deployed (.+?) before/)?.[1] || 'shortly'} before</strong>{' '}
            this incident.
          </div>
          <div className="info-row">
            <span className="info-key">From</span>
            <span className="info-val mono">{deploy.from_sha?.slice(0, 7)} — {deploy.from_message || '(no message)'}</span>
          </div>
          <div className="info-row">
            <span className="info-key">To</span>
            <span className="info-val mono">{deploy.to_sha?.slice(0, 7)} — {deploy.to_message || '(no message)'}</span>
          </div>
          {recommendedRollback && (
            <div style={{ marginTop: 10, padding: 8, background: 'var(--yellow-dim)', borderRadius: 'var(--r)', fontSize: '0.82rem' }}>
              <Icon name="brain" size={13} /> The AI diagnosis recommends rolling this back — see Recommended Actions below to approve it.
            </div>
          )}
          {deploy.from_sha && (
            <div style={{ marginTop: 10 }}>
              <button
                id="btn-rollback-deploy"
                className="btn btn-danger btn-sm"
                onClick={() => rollback(deploy.repo_name, deploy.from_sha)}
                disabled={rollingBack}
                title="Roll this repo back directly — this click is the approval, independent of the incident's own AI-recommendation flow"
              >
                {rollingBack ? 'Rolling back…' : <><Icon name="corner-up-left" size={12} /> {`Roll back to ${deploy.from_sha.slice(0, 7)}`}</>}
              </button>
            </div>
          )}
        </div>
      )}

      {diagnosis?.source === 'runbook' ? (
        // Visually distinct from the AI Diagnosis card below (green, not
        // purple) — this diagnosis cost zero provider requests, and the
        // track record is what earns trust here, not a confidence score.
        <div className="card" style={{ borderColor: 'var(--green)' }}>
          <div className="card-title"><Icon name="clipboard" /> Known Fix <span style={{ fontWeight: 400, color: 'var(--text-dim)', textTransform: 'none' }}>— no AI request used</span></div>
          <div style={{ marginBottom: 10, fontSize: '0.95rem' }}>{diagnosis.rootCause}</div>
          <div className="info-row">
            <span className="info-key">Track record</span>
            <span className="info-val">{diagnosis.successes}/{diagnosis.successes + diagnosis.failures} successful</span>
          </div>
          {diagnosis.avgRecoveryMs != null && (
            <div className="info-row">
              <span className="info-key">Usually resolves in</span>
              <span className="info-val">~{Math.round(diagnosis.avgRecoveryMs / 1000)}s</span>
            </div>
          )}
          <div style={{ marginTop: 10 }}>
            <button
              id="btn-ask-ai-instead"
              className="btn btn-secondary btn-sm"
              onClick={askAiInstead}
              disabled={rediagnosing}
              title="Don't trust the learned fix this time — gather fresh evidence and ask the AI for a real diagnosis"
            >
              {rediagnosing ? 'Asking AI…' : <><Icon name="brain" size={12} /> Ask AI instead</>}
            </button>
          </div>
        </div>
      ) : diagnosis ? (
        <div className="card">
          <div className="card-title"><Icon name="brain" /> AI Diagnosis</div>
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>Root Cause</div>
            <div style={{ fontSize: '0.95rem' }}>{diagnosis.rootCause}</div>
          </div>
          <div className="info-row"><span className="info-key">Confidence</span><span className="info-val">{typeof diagnosis.confidence === 'number' ? `${Math.round(diagnosis.confidence * 100)}%` : '—'}</span></div>
          {diagnosis.affectedComponents?.length > 0 && (
            <div className="info-row"><span className="info-key">Affected</span><span className="info-val">{diagnosis.affectedComponents.join(', ')}</span></div>
          )}
        </div>
      ) : incident.diagnosis_raw_text ? (
        <div className="card">
          <div className="card-title"><Icon name="alert-triangle" /> Diagnosis Failed to Parse</div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', whiteSpace: 'pre-wrap', fontFamily: 'var(--mono)' }}>
            {incident.diagnosis_raw_text}
          </div>
        </div>
      ) : incident.status === 'DETECTED' ? (
        <div className="card">
          <div className="card-title"><Icon name="brain" /> AI Diagnosis</div>
          <div className="empty-state" style={{ padding: '18px 0' }}>
            <div className="empty-state-icon"><Icon name="search" size={32} /></div>
            <p style={{ maxWidth: 460, margin: '0 auto', lineHeight: 1.6 }}>
              Not diagnosed yet. Sentinel detected and recorded this incident, but only asks the AI
              automatically for resources you've opted into auto-remediation — so a routine blip
              can't quietly spend your provider quota.
            </p>
            <p style={{ fontSize: '0.78rem', color: 'var(--text-dim)', marginTop: 8 }}>
              Press <strong>Diagnose</strong> above to gather evidence and ask for a root cause.
            </p>
          </div>
        </div>
      ) : null}

      {incident.actions?.length > 0 && (
        <div className="card">
          <div className="card-title"><Icon name="settings" /> Recommended Actions</div>
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
                      {busyActionId === action.id
                        ? 'Running…'
                        : action.real_risk === 'READ_ONLY'
                          // A READ_ONLY action gathers evidence; it doesn't
                          // remediate anything, so "Approve & Execute" would
                          // overstate what clicking it does.
                          ? <><Icon name="search" size={12} /> Run &amp; Add Evidence</>
                          : <><Icon name="check" size={12} /> Approve &amp; Execute</>}
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
          <div className="card-title"><Icon name="paperclip" /> Evidence</div>
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
