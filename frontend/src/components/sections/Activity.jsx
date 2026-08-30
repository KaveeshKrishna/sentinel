import { useState, useEffect } from 'react';
import { api } from '../../api/client';
import Icon from '../shared/Icon';

function timeStr(ts) {
  const d = new Date(ts);
  return d.toLocaleString('en-GB', { hour12: false, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export default function Activity() {
  const [events, setEvents]   = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        setEvents(await api.get('/activity'));
      } finally {
        setLoading(false);
      }
    }
    load();
    const p = setInterval(load, 5000);
    return () => clearInterval(p);
  }, []);

  if (loading) return <div className="empty-state"><div className="boot-spinner" /></div>;

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div className="card-title" style={{ marginBottom: 0 }}><Icon name="clipboard" /> Activity Timeline ({events.length} events)</div>
      </div>

      {events.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon"><Icon name="refresh-cw" size={32} /></div>
          <p>No events yet</p>
        </div>
      ) : (
        <div className="timeline" id="activity-timeline">
          {events.map(ev => (
            <div key={ev.id} className="timeline-item">
              <div className="timeline-icon" style={{ background: `${ev.color}18`, border: `1px solid ${ev.color}40` }}>
                <Icon name={ev.icon} size={13} color={ev.color} />
              </div>
              <div className="timeline-body">
                <div className="timeline-msg">{ev.message}</div>
                <div className="timeline-time">{timeStr(ev.timestamp)}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
