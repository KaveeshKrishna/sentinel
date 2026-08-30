import { useState, useEffect } from 'react';
import { api } from '../../api/client';
import Icon from '../shared/Icon';

const SERVICE_INFO = {
  docker:      { icon: 'box', label: 'Docker' },
  caddy:       { icon: 'globe', label: 'Caddy' },
  cloudflared: { icon: 'cloud', label: 'Cloudflared' },
  ssh:         { icon: 'lock', label: 'SSH (sshd)' },
  ufw:         { icon: 'shield', label: 'UFW Firewall' }
};

function ServiceCard({ name, status, onAction }) {
  const [acting, setActing] = useState(null);
  const info = SERVICE_INFO[name] || { icon: 'settings', label: name };
  const isActive = status === 'active';

  async function act(action) {
    setActing(action);
    await onAction(name, action);
    setActing(null);
  }

  return (
    <div id={`service-card-${name}`} className="service-card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: '1.2rem' }}><Icon name={info.icon} size={18} /></span>
        <div>
          <div className="service-name">{info.label}</div>
          <span style={{
            fontSize: '0.72rem',
            fontWeight: 600,
            color: isActive ? 'var(--green)' : status === 'inactive' || status === 'failed' ? 'var(--red)' : 'var(--yellow)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em'
          }}>
            ● {status || 'unknown'}
          </span>
        </div>
      </div>
      <div className="service-actions">
        <button
          id={`btn-${name}-restart`}
          className="btn btn-secondary btn-sm"
          onClick={() => act('restart')}
          disabled={!!acting}
          title="Restart"
        >
          {acting === 'restart' ? '…' : <Icon name="refresh-cw" size={12} />}
        </button>
        {!isActive && (
          <button
            id={`btn-${name}-start`}
            className="btn btn-success btn-sm"
            onClick={() => act('start')}
            disabled={!!acting}
          >
            {acting === 'start' ? '…' : '▶ Start'}
          </button>
        )}
        {isActive && (
          <button
            id={`btn-${name}-stop`}
            className="btn btn-danger btn-sm"
            onClick={() => act('stop')}
            disabled={!!acting}
          >
            {acting === 'stop' ? '…' : '■ Stop'}
          </button>
        )}
      </div>
    </div>
  );
}

export default function Services() {
  const [statuses, setStatuses] = useState({});
  const [loading,  setLoading]  = useState(true);

  async function load() {
    try {
      setStatuses(await api.get('/services'));
    } finally {
      setLoading(false);
    }
  }

  async function handleAction(service, action) {
    await api.post(`/services/${service}/${action}`);
    await load();
  }

  useEffect(() => {
    load();
    const p = setInterval(load, 8000);
    return () => clearInterval(p);
  }, []);

  if (loading) return <div className="empty-state"><div className="boot-spinner" /></div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
        Service control runs via <code style={{ fontFamily: 'var(--mono)', background: 'var(--surface-2)', padding: '1px 5px', borderRadius: 4 }}>nsenter</code> into the host's namespace. Requires privileged mode.
      </div>
      <div className="services-grid">
        {Object.entries(SERVICE_INFO).map(([name]) => (
          <ServiceCard
            key={name}
            name={name}
            status={statuses[name] || 'unknown'}
            onAction={handleAction}
          />
        ))}
      </div>
    </div>
  );
}
