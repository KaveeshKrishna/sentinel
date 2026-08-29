import MetricCard from '../shared/MetricCard';
import Icon from '../shared/Icon';
import { useMetrics } from '../../hooks/useWebSocket';

function fmt(bytes, dp = 1) {
  if (!bytes) return '0 B';
  const k = 1024;
  const s = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k));
  return `${(bytes / k**i).toFixed(dp)} ${s[Math.min(i, 4)]}`;
}

function fmtUptime(sec) {
  if (!sec) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m`;
}

export default function Overview() {
  const ctx = useMetrics();
  const m   = ctx?.metrics;
  const h   = ctx?.metrics?.history || {};

  if (!m) {
    return <div className="empty-state"><div className="empty-state-icon"><Icon name="refresh-cw" size={32} /></div><p>Waiting for data…</p></div>;
  }

  const cpuColor   = m.cpu?.usage > 80 ? 'red' : m.cpu?.usage > 60 ? 'yellow' : 'blue';
  const ramColor   = m.memory?.usedPercent > 85 ? 'red' : m.memory?.usedPercent > 70 ? 'yellow' : 'purple';
  const tempColor  = m.temperature?.current > 75 ? 'red' : m.temperature?.current > 60 ? 'yellow' : 'cyan';
  const diskColor  = m.disk?.usage?.usedPercent > 85 ? 'red' : m.disk?.usage?.usedPercent > 70 ? 'yellow' : 'green';

  const ramUsed  = fmt(m.memory?.used);
  const ramTotal = fmt(m.memory?.total);
  const swapUsed = fmt(m.memory?.swapUsed);
  const diskUsed = fmt(m.disk?.usage?.used);
  const diskTotal= fmt(m.disk?.usage?.total);

  return (
    <div className="metrics-grid">
      <MetricCard
        title="CPU Usage" icon="zap"
        value={m.cpu?.usage?.toFixed(1)} unit="%"
        color={cpuColor}
        sub={`${m.cpu?.info?.threads} threads · ${m.cpu?.info?.frequency} MHz`}
        sparklineData={h.cpu}
      />
      <MetricCard
        title="Load Average" icon="bar-chart"
        value={m.cpu?.load?.['1']?.toFixed(2)}
        color="blue"
        sub={`5m: ${m.cpu?.load?.['5']?.toFixed(2)} · 15m: ${m.cpu?.load?.['15']?.toFixed(2)}`}
        sparklineData={h.load1}
      />
      <MetricCard
        title="CPU Temp" icon="thermometer"
        value={m.temperature?.current?.toFixed(1)} unit="°C"
        color={tempColor}
        sub={m.temperature?.type || 'thermal'}
        sparklineData={h.temperature}
      />
      <MetricCard
        title="RAM" icon="hard-drive"
        value={m.memory?.usedPercent?.toFixed(1)} unit="%"
        color={ramColor}
        sub={`${ramUsed} / ${ramTotal}`}
        sparklineData={h.memory}
      />
      <MetricCard
        title="Swap" icon="refresh-cw"
        value={fmt(m.memory?.swapUsed)}
        color={m.memory?.swapPercent > 20 ? 'yellow' : 'gray'}
        sub={`${m.memory?.swapPercent?.toFixed(1)}% of ${fmt(m.memory?.swapTotal)}`}
        sparklineData={h.swap}
      />
      <MetricCard
        title="Root Disk" icon="hard-drive"
        value={m.disk?.usage?.usedPercent} unit="%"
        color={diskColor}
        sub={`${diskUsed} / ${diskTotal}`}
      />
      <MetricCard
        title="Upload" icon="arrow-up"
        value={fmt(m.network?.txSpeed, 0)} unit="/s"
        color="cyan"
        sub={`Total: ${fmt(m.network?.txTotal)}`}
        sparklineData={h.netUp}
      />
      <MetricCard
        title="Download" icon="arrow-down"
        value={fmt(m.network?.rxSpeed, 0)} unit="/s"
        color="green"
        sub={`Total: ${fmt(m.network?.rxTotal)}`}
        sparklineData={h.netDown}
      />
      <MetricCard
        title="Uptime" icon="arrow-up"
        value={fmtUptime(m.uptime)}
        color="blue"
        sub="System uptime"
      />
    </div>
  );
}
