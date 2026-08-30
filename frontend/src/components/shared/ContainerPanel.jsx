import { useState, useEffect } from 'react';
import { api } from '../../api/client';
import StatusBadge from './StatusBadge';
import Icon from './Icon';

function fmt(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const s = ['B','KB','MB','GB'];
  const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k));
  return `${(bytes / k**i).toFixed(1)} ${s[Math.min(i, 3)]}`;
}

export default function ContainerPanel({ container, onClose }) {
  const [logs, setLogs]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction]   = useState(null);

  useEffect(() => {
    if (!container) return;
    setLoading(true);
    setLogs(null);
    api.get(`/docker/containers/${container.id}/logs?tail=200`)
      .then(lines => { setLogs(lines); setLoading(false); })
      .catch(() => { setLogs([]); setLoading(false); });
  }, [container?.id]);

  async function doAction(act) {
    setAction(act);
    try {
      await api.post(`/docker/containers/${container.id}/${act}`);
    } finally {
      setAction(null);
    }
  }

  if (!container) return null;
  const isRunning = container.state === 'running';

  return (
    <>
      <div className="panel-overlay" onClick={onClose} />
      <div className="panel">
        <div className="panel-header">
          <div>
            <div className="panel-title">{container.name}</div>
            <StatusBadge status={container.state} />
          </div>
          <button id="panel-close" className="btn btn-secondary btn-sm btn-icon" onClick={onClose}><Icon name="x" size={12} /></button>
        </div>

        <div className="panel-body">
          {/* Actions */}
          <div className="panel-section">
            <div className="panel-section-title">Controls</div>
            <div className="panel-actions">
              {!isRunning && (
                <button id="btn-container-start" className="btn btn-success btn-sm" onClick={() => doAction('start')} disabled={!!action}>
                  {action === 'start' ? '…' : '▶ Start'}
                </button>
              )}
              {isRunning && (
                <button id="btn-container-stop" className="btn btn-danger btn-sm" onClick={() => doAction('stop')} disabled={!!action}>
                  {action === 'stop' ? '…' : '■ Stop'}
                </button>
              )}
              <button id="btn-container-restart" className="btn btn-secondary btn-sm" onClick={() => doAction('restart')} disabled={!!action}>
                {action === 'restart' ? '…' : <><Icon name="refresh-cw" size={12} /> Restart</>}
              </button>
            </div>
          </div>

          {/* Info */}
          <div className="panel-section">
            <div className="panel-section-title">Details</div>
            <div className="info-row"><span className="info-key">Image</span>         <span className="info-val">{container.image}</span></div>
            <div className="info-row"><span className="info-key">ID</span>            <span className="info-val mono">{container.shortId}</span></div>
            <div className="info-row"><span className="info-key">CPU</span>           <span className="info-val">{container.cpuPercent?.toFixed(2)}%</span></div>
            <div className="info-row"><span className="info-key">Memory</span>        <span className="info-val">{fmt(container.memUsage)}</span></div>
            <div className="info-row"><span className="info-key">Restarts</span>      <span className="info-val">{container.restartCount}</span></div>
            <div className="info-row"><span className="info-key">Ports</span>         <span className="info-val">{container.ports || '—'}</span></div>
            <div className="info-row"><span className="info-key">Health</span>        <span className="info-val"><StatusBadge status={container.health} /></span></div>
            {container.composeProject && (
              <div className="info-row"><span className="info-key">Compose Project</span><span className="info-val">{container.composeProject}</span></div>
            )}
          </div>

          {/* Logs */}
          <div className="panel-section">
            <div className="panel-section-title">Last 200 Log Lines</div>
            <div className="log-viewer" id="container-logs">
              {loading && <div className="log-loading">Loading logs…</div>}
              {!loading && (!logs || logs.length === 0) && (
                <div className="log-loading">No logs available</div>
              )}
              {!loading && logs?.map((line, i) => (
                <div key={i} className={`log-line ${line.stream === 'stderr' ? 'stderr' : ''}`}>
                  {line.text}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
