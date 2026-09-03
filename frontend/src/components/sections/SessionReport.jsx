import { useState, useEffect } from 'react';
import { api } from '../../api/client';
import Icon from '../shared/Icon';
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, PointElement, LineElement,
  Title, Tooltip, Legend, Filler
} from 'chart.js';
import { Line } from 'react-chartjs-2';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, Filler);

const CHART_OPTS = (label, color, yMax) => ({
  responsive: true,
  maintainAspectRatio: false,
  plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false } },
  scales: {
    x: { ticks: { color: '#8b949e', maxTicksLimit: 8, font: { size: 10 } }, grid: { color: '#21262d' } },
    y: { ticks: { color: '#8b949e', font: { size: 10 } }, grid: { color: '#21262d' }, max: yMax, min: 0 }
  }
});

function mkDataset(samples, key, color, label) {
  return {
    labels: samples.map(s => new Date(s.timestamp).toLocaleTimeString('en-GB', { hour12: false })),
    datasets: [{
      label,
      data: samples.map(s => s[key] ?? 0),
      borderColor: color,
      backgroundColor: `${color}20`,
      borderWidth: 2,
      fill: true,
      tension: 0.3,
      pointRadius: 0,
      pointHoverRadius: 4
    }]
  };
}

function SmallChart({ data, opts, height = 140 }) {
  return <div style={{ height }}><Line data={data} options={opts} /></div>;
}

function fmt(bytes) {
  if (!bytes) return '0 B';
  const k = 1024; const s = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k));
  return `${(bytes / k**i).toFixed(1)} ${s[Math.min(i,4)]}`;
}

function fmtDate(ts) {
  return ts ? new Date(ts).toLocaleString('en-GB', { hour12: false }) : '—';
}

function fmtDur(ms) {
  if (!ms) return '—';
  const s=Math.floor(ms/1000), m=Math.floor(s/60), h=Math.floor(m/60), d=Math.floor(h/24);
  return d > 0 ? `${d}d ${h%24}h ${m%60}m` : h > 0 ? `${h}h ${m%60}m` : `${m}m`;
}

export default function SessionReport({ sessionId, onBack, onDeleted }) {
  const [data, setData]     = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get(`/recordings/${sessionId}`)
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [sessionId]);

  if (loading) return <div className="empty-state"><div className="boot-spinner" /></div>;
  if (!data)   return <div className="empty-state"><p>Failed to load session</p></div>;

  const { session, samples, analytics } = data;
  const a = analytics || {};

  const scoreColor = a.healthScore >= 90 ? '#22c55e' : a.healthScore >= 75 ? '#86efac' : a.healthScore >= 60 ? '#f59e0b' : '#ef4444';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Back button */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button id="btn-back-sessions" className="btn btn-secondary btn-sm" onClick={onBack}><Icon name="chevron-left" size={12} /> Back</button>
        <div style={{ fontSize: '1rem', fontWeight: 600 }}>{session.name}</div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {!import.meta.env.VITE_DEMO && (
            <>
              <a
                id="btn-export-csv"
                href={`/api/recordings/${sessionId}/export/csv`}
                className="btn btn-secondary btn-sm"
                download
              ><Icon name="arrow-down" size={12} /> CSV</a>
              <a
                id="btn-export-json"
                href={`/api/recordings/${sessionId}/export/json`}
                className="btn btn-secondary btn-sm"
                download
              ><Icon name="arrow-down" size={12} /> JSON</a>
            </>
          )}
          <button
            id="btn-delete-session-detail"
            className="btn btn-danger btn-sm"
            onClick={async () => {
              if (!confirm('Delete this session permanently?')) return;
              await api.del(`/recordings/${sessionId}`);
              onDeleted();
            }}
          ><Icon name="trash" size={12} /> Delete</button>
        </div>
      </div>

      {/* Health score */}
      <div className="card" style={{ borderColor: scoreColor }}>
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Overall Health</div>
            <div style={{ fontSize: '2rem', fontWeight: 800, color: scoreColor, fontFamily: 'var(--mono)' }}>
              {a.healthScore}/100
            </div>
            <div style={{ fontSize: '0.9rem', color: scoreColor, fontWeight: 600 }}>{a.healthLabel}</div>
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            {a.positives?.map((p, i) => (
              <div key={i} style={{ fontSize: '0.8rem', color: 'var(--green)', marginBottom: 2 }}><Icon name="check" size={12} /> {p}</div>
            ))}
            {a.issues?.map((p, i) => (
              <div key={i} style={{ fontSize: '0.8rem', color: 'var(--red)', marginBottom: 2 }}><Icon name="x" size={12} /> {p}</div>
            ))}
          </div>
        </div>
      </div>

      {/* Summary grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
        {[
          { label: 'Duration',    val: fmtDur(session.end_time ? session.end_time - session.start_time : null) },
          { label: 'Samples',     val: session.sample_count },
          { label: 'Avg CPU',     val: `${a.avgCpu}%` },
          { label: 'Avg RAM',     val: `${a.avgRam}%` },
          { label: 'Avg Load',    val: a.avgLoad },
          { label: 'Avg Temp',    val: a.avgTemp ? `${a.avgTemp}°C` : '—' },
          { label: 'Peak Temp',   val: a.maxTemp ? `${a.maxTemp}°C` : '—' },
          { label: 'Max Load',    val: a.maxLoad },
          { label: 'Max RAM',     val: `${a.maxRam}%` },
          { label: 'Disk Growth', val: fmt(a.diskGrowth || 0) }
        ].map(({ label, val }) => (
          <div key={label} style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--r)', padding: '10px 14px' }}>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{label}</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: '0.95rem', fontWeight: 600 }}>{val ?? '—'}</div>
          </div>
        ))}
      </div>

      {/* Charts */}
      {samples.length > 1 && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {[
            { key: 'cpu_usage',  label: 'CPU %',       color: '#3b82f6', max: 100 },
            { key: 'ram_percent',label: 'RAM %',        color: '#a855f7', max: 100 },
            { key: 'cpu_temp',   label: 'Temperature °C',color: '#06b6d4' },
            { key: 'load_1',     label: 'Load (1m)',    color: '#f59e0b' },
            { key: 'net_up_speed',label:'Upload B/s',   color: '#22c55e' },
            { key: 'disk_read_speed',label:'Disk Read', color: '#8b5cf6' }
          ].map(({ key, label, color, max }) => (
            <div key={key} className="card">
              <div className="card-title">{label}</div>
              <SmallChart
                data={mkDataset(samples, key, color, label)}
                opts={CHART_OPTS(label, color, max)}
              />
            </div>
          ))}
        </div>
      )}

      {/* Container timeline */}
      {a.containerStats?.length > 0 && (
        <div className="card">
          <div className="card-title"><Icon name="box" /> Container Summary</div>
          <table className="data-table">
            <thead>
              <tr><th>Name</th><th>Avg CPU</th><th>Avg RAM</th><th>Restarts</th><th>Unhealthy Samples</th></tr>
            </thead>
            <tbody>
              {a.containerStats.map(c => (
                <tr key={c.name}>
                  <td style={{ fontWeight: 500 }}>{c.name}</td>
                  <td className="mono">{c.avgCpu.toFixed(2)}%</td>
                  <td className="mono">{fmt(c.avgRam)}</td>
                  <td className="mono" style={{ color: c.restarts > 0 ? 'var(--red)' : 'inherit' }}>{c.restarts}</td>
                  <td className="mono" style={{ color: c.downtime > 0 ? 'var(--yellow)' : 'inherit' }}>{c.downtime}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
