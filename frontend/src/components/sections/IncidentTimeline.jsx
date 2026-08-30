import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import Icon from '../shared/Icon';

const STAGE_ICON = {
  done: <Icon name="check" size={11} />, active: '•', failed: <Icon name="x" size={11} />, skipped: '–', pending: ''
};

const ENTRY_ICON = {
  transition: '◆',
  tool: <Icon name="wrench" size={12} />,
  ai: <Icon name="brain" size={12} />,
  action: <Icon name="settings" size={12} />
};

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString();
}

function fmtDuration(ms) {
  if (ms == null) return null;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** One line of prose per entry kind — the timeline is meant to be read. */
function describe(e) {
  switch (e.kind) {
    case 'transition':
      return e.from ? `${e.from} → ${e.to}` : `Incident opened (${e.to})`;
    case 'tool':
      return `${e.tool} ${e.status === 'ok' ? 'succeeded' : 'failed'}`;
    case 'ai':
      return e.ok
        ? `${e.provider}/${e.model} returned a ${e.purpose} (attempt ${e.attempt})`
        : `${e.provider}/${e.model} ${e.purpose} attempt ${e.attempt} failed`;
    case 'action':
      return `Proposed ${e.tool} (${e.realRisk}) — ${e.status}`;
    default:
      return e.kind;
  }
}

function entryMeta(e) {
  const bits = [];
  if (e.kind === 'tool') {
    const d = fmtDuration(e.durationMs);
    if (d) bits.push(d);
    if (e.approved) bits.push('approved');
  }
  if (e.kind === 'ai') {
    const d = fmtDuration(e.latencyMs);
    if (d) bits.push(d);
    if (e.promptTokens != null || e.completionTokens != null) {
      bits.push(`${e.promptTokens ?? '?'}→${e.completionTokens ?? '?'} tok`);
    }
  }
  if (e.kind === 'action' && e.approvedVia) bits.push(`via ${e.approvedVia}`);
  return bits.join(' · ');
}

/**
 * The OBSERVE → DIAGNOSE → PLAN → ACT → VERIFY loop, drawn from what was
 * actually recorded for this incident, over a detailed entry list.
 * Re-fetches whenever `refreshKey` changes so it tracks live pushes.
 */
export default function IncidentTimeline({ incidentId, refreshKey }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.get(`/incidents/${incidentId}/timeline`)
      .then(d => { if (!cancelled) { setData(d); setError(null); } })
      .catch(err => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [incidentId, refreshKey]);

  if (error) return <div className="card"><div className="card-title"><Icon name="refresh-cw" /> Reasoning Loop</div><div className="error-msg">{error}</div></div>;
  if (!data) return null;

  const synthesized = data.entries.some(e => e.kind === 'transition' && e.synthesized);

  return (
    <div className="card">
      <div className="card-title"><Icon name="refresh-cw" /> Reasoning Loop</div>

      <div className="loop-strip">
        {data.phases.map(p => (
          <div key={p.phase} className={`loop-stage ${p.status}`} id={`loop-${p.phase.toLowerCase()}`}>
            <div className="loop-dot">{STAGE_ICON[p.status]}</div>
            <div className="loop-label">{p.phase}</div>
            <div className="loop-time">{p.at ? fmtTime(p.at) : ''}</div>
          </div>
        ))}
      </div>

      {synthesized && (
        <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)', marginBottom: 10 }}>
          This incident predates transition recording — the stages below are approximated from its timestamps.
        </div>
      )}

      <div className="tl-list">
        {data.entries.map((e, i) => {
          const meta = entryMeta(e);
          return (
            <div className="tl-entry" key={i}>
              <div className="tl-time">{fmtTime(e.at)}</div>
              <div className="tl-icon">{ENTRY_ICON[e.kind] || '•'}</div>
              <div>
                <div className="tl-text">
                  <span className="tl-phase">{e.phase}</span>
                  {describe(e)}
                  {meta && <span className="tl-meta">{meta}</span>}
                </div>
                {e.error && <div className="tl-err">{e.error}</div>}
              </div>
            </div>
          );
        })}
        {data.entries.length === 0 && (
          <div style={{ color: 'var(--text-dim)', fontSize: '0.8125rem' }}>Nothing recorded yet.</div>
        )}
      </div>
    </div>
  );
}
