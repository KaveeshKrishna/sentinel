import { useState, useEffect } from 'react';
import { api } from '../../api/client';
import StatusBadge from '../shared/StatusBadge';
import Icon from '../shared/Icon';

export default function Websites() {
  const [sites, setSites]     = useState([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    try {
      setSites(await api.get('/websites'));
    } catch {
      setSites([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); const p = setInterval(load, 30000); return () => clearInterval(p); }, []);

  if (loading) return <div className="empty-state"><div className="boot-spinner" /></div>;
  if (sites.length === 0) return (
    <div className="empty-state">
      <div className="empty-state-icon"><Icon name="globe" size={32} /></div>
      <p>No sites found in Caddyfile</p>
    </div>
  );

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
      {sites.map((site, i) => (
        <div key={i} id={`site-card-${site.domain}`} className="website-card">
          <div className="website-domain"><Icon name="globe" size={14} /> {site.domain}</div>
          <div style={{ marginBottom: 10 }}>
            <StatusBadge status={site.status || site.dockerStatus} />
            <span style={{ marginLeft: 8, fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              {site.containerName
                ? `(${site.containerName})`
                : site.upstream === 'host'
                  ? '(host service)'
                  : ''}
            </span>
          </div>
          <div className="website-stats">
            <span className="website-stat">:{site.localPort}</span>
            <span className="website-stat">
              {site.responseTime >= 0 ? `${site.responseTime} ms` : 'Unreachable'}
            </span>
            {site.httpStatus > 0 && (
              <span className="website-stat" style={{
                color: site.httpStatus < 400 ? 'var(--green)' : 'var(--red)'
              }}>
                HTTP {site.httpStatus}
              </span>
            )}
            <span className="website-stat" style={{ color: 'var(--green)' }}>
              <Icon name="lock" size={12} /> {site.httpsStatus}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
