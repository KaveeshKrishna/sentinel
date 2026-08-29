import { useMetrics } from '../../hooks/useWebSocket';
import Icon from '../shared/Icon';

function fmt(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const s = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k));
  return `${(bytes / k**i).toFixed(1)} ${s[Math.min(i, 4)]}`;
}

function UsageBar({ label, used, total, color = 'var(--accent)' }) {
  const pct = total > 0 ? (used / total) * 100 : 0;
  return (
    <div className="usage-bar-wrap">
      <div className="usage-bar-label">
        <span>{label}</span>
        <span>{pct.toFixed(1)}%</span>
      </div>
      <div className="usage-bar">
        <div className="usage-bar-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

function InfoRow({ k, v }) {
  return (
    <div className="info-row">
      <span className="info-key">{k}</span>
      <span className="info-val">{v ?? '—'}</span>
    </div>
  );
}

export default function Hardware() {
  const ctx = useMetrics();
  const m   = ctx?.metrics;

  if (!m) return <div className="empty-state"><div className="empty-state-icon"><Icon name="refresh-cw" size={32} /></div><p>Waiting for data…</p></div>;

  const cpu  = m.cpu;
  const mem  = m.memory;
  const disk = m.disk;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* CPU */}
      <div className="card">
        <div className="card-title"><Icon name="cpu" /> CPU</div>
        <div className="section-grid-2">
          <div>
            <InfoRow k="Model"       v={cpu?.info?.model} />
            <InfoRow k="Threads"     v={cpu?.info?.threads} />
            <InfoRow k="Frequency"   v={`${cpu?.info?.frequency} MHz`} />
            <InfoRow k="Temperature" v={m.temperature?.current != null ? `${m.temperature.current.toFixed(1)}°C` : '—'} />
            <InfoRow k="Thermal Zone"v={m.temperature?.type || '—'} />
          </div>
          <div>
            <UsageBar label="CPU Usage" used={cpu?.usage || 0} total={100} color="var(--accent)" />
            <div style={{ marginTop: 8 }}>
              <InfoRow k="Load 1m"  v={cpu?.load?.['1']?.toFixed(2)} />
              <InfoRow k="Load 5m"  v={cpu?.load?.['5']?.toFixed(2)} />
              <InfoRow k="Load 15m" v={cpu?.load?.['15']?.toFixed(2)} />
            </div>
          </div>
        </div>
      </div>

      {/* Memory */}
      <div className="card">
        <div className="card-title"><Icon name="hard-drive" /> Memory</div>
        <div className="section-grid-2">
          <div>
            <InfoRow k="Total"     v={fmt(mem?.total)} />
            <InfoRow k="Used"      v={fmt(mem?.used)} />
            <InfoRow k="Available" v={fmt(mem?.available)} />
            <InfoRow k="Cached"    v={fmt(mem?.cached)} />
            <InfoRow k="Swap Total"v={fmt(mem?.swapTotal)} />
            <InfoRow k="Swap Used" v={fmt(mem?.swapUsed)} />
          </div>
          <div>
            <UsageBar label="RAM Used"  used={mem?.used}     total={mem?.total}     color="var(--purple)" />
            <UsageBar label="Swap Used" used={mem?.swapUsed} total={mem?.swapTotal} color="var(--yellow)" />
          </div>
        </div>
      </div>

      {/* Disk */}
      <div className="card">
        <div className="card-title"><Icon name="hard-drive" /> Disk</div>
        <div className="section-grid-2">
          <div>
            <InfoRow k="Filesystem"  v={disk?.usage?.filesystem} />
            <InfoRow k="Mount"       v={disk?.usage?.mountpoint} />
            <InfoRow k="Total"       v={fmt(disk?.usage?.total)} />
            <InfoRow k="Used"        v={fmt(disk?.usage?.used)} />
            <InfoRow k="Available"   v={fmt(disk?.usage?.avail)} />
            <InfoRow k="Usage"       v={`${disk?.usage?.usedPercent}%`} />
          </div>
          <div>
            <UsageBar label="Disk Used" used={disk?.usage?.used} total={disk?.usage?.total} color="var(--green)" />
            <div style={{ marginTop: 8 }}>
              <InfoRow k="Read Speed"  v={`${fmt(disk?.io?.readSpeed)}/s`} />
              <InfoRow k="Write Speed" v={`${fmt(disk?.io?.writeSpeed)}/s`} />
            </div>
          </div>
        </div>
      </div>

    </div>
  );
}
