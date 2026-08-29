import { useState, useEffect } from 'react';
import { api } from '../../api/client';
import Icon from '../shared/Icon';
import StatusBadge from '../shared/StatusBadge';
import ContainerPanel from '../shared/ContainerPanel';

function fmt(bytes) {
  if (!bytes) return '0 B';
  const k = 1024; const s = ['B','KB','MB','GB'];
  const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k));
  return `${(bytes / k**i).toFixed(1)} ${s[Math.min(i,3)]}`;
}

export default function DockerSection() {
  const [containers, setContainers] = useState([]);
  const [loading, setLoading]       = useState(true);
  const [selected, setSelected]     = useState(null);

  async function load() {
    try {
      setContainers(await api.get('/docker/containers'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const poll = setInterval(load, 3000);
    return () => clearInterval(poll);
  }, []);

  if (loading) return <div className="empty-state"><div className="boot-spinner" /></div>;

  return (
    <>
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div className="card-title" style={{ marginBottom: 0 }}><Icon name="box" /> Containers ({containers.length})</div>
          <button id="btn-refresh-containers" className="btn btn-secondary btn-sm" onClick={load}><Icon name="refresh-cw" size={12} /> Refresh</button>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Name</th>
                <th>CPU %</th>
                <th>RAM</th>
                <th>Restarts</th>
                <th>Ports</th>
                <th>Health</th>
              </tr>
            </thead>
            <tbody>
              {containers.map(c => (
                <tr key={c.id} id={`container-row-${c.shortId}`} onClick={() => setSelected(c)}>
                  <td><StatusBadge status={c.state} /></td>
                  <td style={{ fontWeight: 500 }}>{c.name}</td>
                  <td className="mono">{c.cpuPercent?.toFixed(2)}%</td>
                  <td className="mono">{fmt(c.memUsage)}</td>
                  <td className="mono">{c.restartCount}</td>
                  <td className="mono" style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{c.ports || '—'}</td>
                  <td><StatusBadge status={c.health === 'N/A' ? c.state : c.health} /></td>
                </tr>
              ))}
              {containers.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-dim)', padding: 24 }}>
                    No containers found
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selected && (
        <ContainerPanel
          container={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  );
}
