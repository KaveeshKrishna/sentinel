import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import Icon from '../shared/Icon';
import StatusBadge from '../shared/StatusBadge';
import { useLiveEvents } from '../../hooks/useWebSocket';

const SEVERITY_COLOR = { high: 'var(--red)', medium: 'var(--yellow)', unknown: 'var(--text-dim)' };

function timeAgo(ts) {
  if (!ts) return '—';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const STATUS_FILTERS = [
  { id: '', label: 'All' },
  { id: 'AWAITING_APPROVAL', label: 'Needs Approval' },
  { id: 'RESOLVED', label: 'Resolved' },
  { id: 'FAILED', label: 'Failed' },
  { id: 'DISMISSED', label: 'Dismissed' }
];

export default function Incidents() {
  const [incidents, setIncidents] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [clearing, setClearing]   = useState(false);
  const { incidentTick } = useLiveEvents();
  const navigate = useNavigate();

  async function load() {
    try {
      const qs = statusFilter ? `?status=${statusFilter}` : '';
      setIncidents(await api.get(`/incidents${qs}`));
    } catch {
      setIncidents([]);
    } finally {
      setLoading(false);
    }
  }

  async function deleteOne(e, id) {
    e.stopPropagation();
    if (!confirm(`Delete incident #${id}? This permanently removes it and its evidence, actions and AI runs.`)) return;
    try {
      await api.del(`/incidents/${id}`);
      await load();
    } catch (err) {
      alert(err.message);
    }
  }

  async function clearAll() {
    const label = STATUS_FILTERS.find(f => f.id === statusFilter)?.label || 'All';
    const scope = statusFilter ? `all "${label}" incidents` : 'ALL incidents';
    if (!confirm(`Clear ${scope}? This permanently deletes ${incidents.length} incident(s) and their evidence, actions and AI runs.`)) return;
    setClearing(true);
    try {
      await api.del(`/incidents${statusFilter ? `?status=${statusFilter}` : ''}`);
      await load();
    } catch (err) {
      alert(err.message);
    } finally {
      setClearing(false);
    }
  }

  // The 8s poll is now a fallback: incidentTick makes the list refresh
  // the moment the server pushes a change, so a new incident appears
  // immediately rather than up to 8 seconds late.
  useEffect(() => {
    setLoading(true);
    load();
    const p = setInterval(load, 8000);
    return () => clearInterval(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  useEffect(() => {
    if (incidentTick > 0) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incidentTick]);

  const openCount = incidents.filter(i => !['RESOLVED', 'FAILED', 'DISMISSED'].includes(i.status)).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {STATUS_FILTERS.map(f => (
          <button
            key={f.id}
            id={`incident-filter-${f.id || 'all'}`}
            className={`btn btn-sm ${statusFilter === f.id ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setStatusFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
        {!loading && incidents.length > 0 && (
          <button
            id="btn-clear-incidents"
            className="btn btn-sm btn-danger"
            style={{ marginLeft: 'auto' }}
            onClick={clearAll}
            disabled={clearing}
          >
            {clearing ? '…' : <><Icon name="trash" size={12} /> {`Clear ${statusFilter ? STATUS_FILTERS.find(f => f.id === statusFilter)?.label : 'all'} (${incidents.length})`}</>}
          </button>
        )}
      </div>

      {loading ? (
        <div className="empty-state"><div className="boot-spinner" /></div>
      ) : incidents.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon"><Icon name="check-circle" size={32} /></div>
          <p>No incidents{statusFilter ? ' match this filter' : ' — everything looks healthy'}</p>
        </div>
      ) : (
        <div className="card">
          <div className="card-title" style={{ marginBottom: 12 }}>
            <Icon name="alert-triangle" /> Incidents ({incidents.length}{openCount > 0 ? `, ${openCount} open` : ''})
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Status</th><th>Severity</th><th>Resource</th><th>Trigger</th><th>Root Cause</th><th>Detected</th><th></th>
                </tr>
              </thead>
              <tbody>
                {incidents.map(inc => (
                  <tr key={inc.id} id={`incident-row-${inc.id}`} onClick={() => navigate(`/incidents/${inc.id}`)}>
                    <td><StatusBadge status={inc.status} /></td>
                    <td>
                      <span style={{ color: SEVERITY_COLOR[inc.severity] || 'var(--text-dim)', fontWeight: 600, fontSize: '0.78rem', textTransform: 'uppercase' }}>
                        {inc.severity}
                      </span>
                    </td>
                    <td style={{ fontWeight: 500 }}>{inc.resourceName || `#${inc.resource_id}`}</td>
                    <td className="mono" style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{inc.trigger_rule}</td>
                    <td style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {inc.root_cause || <span style={{ color: 'var(--text-dim)' }}>—</span>}
                    </td>
                    <td className="mono" style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{timeAgo(inc.detected_at)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        id={`btn-delete-incident-${inc.id}`}
                        className="btn btn-secondary btn-sm"
                        title="Delete incident"
                        onClick={e => deleteOne(e, inc.id)}
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
