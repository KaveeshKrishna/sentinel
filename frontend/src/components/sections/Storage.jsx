import { useMetrics } from '../../hooks/useWebSocket';
import Icon from '../shared/Icon';

function fmt(bytes) {
  if (!bytes) return '0 B';
  const k = 1024; const s = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k));
  return `${(bytes / k**i).toFixed(1)} ${s[Math.min(i,4)]}`;
}

function UsageBar({ pct, color }) {
  const c = pct > 85 ? 'var(--red)' : pct > 70 ? 'var(--yellow)' : color || 'var(--accent)';
  return (
    <div className="usage-bar" style={{ height: 10, borderRadius: 5, marginBottom: 6 }}>
      <div className="usage-bar-fill" style={{ width: `${Math.min(pct,100)}%`, background: c, height: '100%', borderRadius: 5 }} />
    </div>
  );
}

export default function Storage() {
  const ctx = useMetrics();
  const m   = ctx?.metrics;
  const du  = m?.disk?.usage;
  const io  = m?.disk?.io;
  const otherDisks = (m?.disk?.allDisks || []).filter(d => d.name !== io?.name);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Root SSD */}
      <div className="card">
        <div className="card-title"><Icon name="hard-drive" /> Root SSD (NVMe)</div>
        {du ? (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
              <div>
                <div style={{ fontSize: '2rem', fontWeight: 700, fontFamily: 'var(--mono)', color: 'var(--text)' }}>
                  {du.usedPercent}%
                </div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  {fmt(du.used)} used of {fmt(du.total)}
                </div>
              </div>
              <div style={{ textAlign: 'right', fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                <div>{fmt(du.avail)} free</div>
                <div style={{ marginTop: 4, fontFamily: 'var(--mono)', fontSize: '0.72rem', color: 'var(--text-dim)' }}>{du.filesystem}</div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: '0.72rem', color: 'var(--text-dim)' }}>mounted at {du.mountpoint}</div>
              </div>
            </div>
            <UsageBar pct={du.usedPercent} color="var(--green)" />
            {io && (
              <div style={{ display: 'flex', gap: 24, marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)', fontSize: '0.82rem' }}>
                <div>
                  <div style={{ color: 'var(--text-muted)', fontSize: '0.72rem', marginBottom: 2 }}>READ SPEED</div>
                  <div style={{ fontFamily: 'var(--mono)' }}>{fmt(io.readSpeed)}/s</div>
                </div>
                <div>
                  <div style={{ color: 'var(--text-muted)', fontSize: '0.72rem', marginBottom: 2 }}>WRITE SPEED</div>
                  <div style={{ fontFamily: 'var(--mono)' }}>{fmt(io.writeSpeed)}/s</div>
                </div>
                {io.name && (
                  <div style={{ marginLeft: 'auto' }}>
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.72rem', marginBottom: 2 }}>DEVICE</div>
                    <div style={{ fontFamily: 'var(--mono)' }}>{io.name}</div>
                  </div>
                )}
              </div>
            )}
          </>
        ) : (
          <div style={{ color: 'var(--text-muted)' }}>No disk data available</div>
        )}
      </div>

      {/* Additional disks — presence + I/O only (from /proc/diskstats, no
          active read/write of our own); full SMART data is a separate,
          not-yet-built feature (see ARCHITECTURE.md roadmap). */}
      <div className="card" style={otherDisks.length ? undefined : { opacity: 0.5 }}>
        <div className="card-title"><Icon name="package" /> Additional Disks</div>
        {otherDisks.length ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {otherDisks.map(d => (
              <div key={d.name} style={{ display: 'flex', gap: 24, alignItems: 'center', fontSize: '0.82rem' }}>
                <div style={{ fontFamily: 'var(--mono)', fontWeight: 600 }}>{d.name}</div>
                <div>
                  <div style={{ color: 'var(--text-muted)', fontSize: '0.72rem', marginBottom: 2 }}>READ SPEED</div>
                  <div style={{ fontFamily: 'var(--mono)' }}>{fmt(d.readSpeed)}/s</div>
                </div>
                <div>
                  <div style={{ color: 'var(--text-muted)', fontSize: '0.72rem', marginBottom: 2 }}>WRITE SPEED</div>
                  <div style={{ fontFamily: 'var(--mono)' }}>{fmt(d.writeSpeed)}/s</div>
                </div>
                <div style={{ marginLeft: 'auto', fontSize: '0.72rem', color: 'var(--text-dim)' }}>SMART data not yet supported</div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ display: 'flex', align: 'center', gap: 12, color: 'var(--text-muted)', fontSize: '0.9rem' }}>
            <span style={{ fontSize: '1.5rem' }}><Icon name="plug" size={22} /></span>
            <div>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>None Detected</div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>
                Additional disks will appear here once connected
              </div>
            </div>
          </div>
        )}
      </div>

    </div>
  );
}
