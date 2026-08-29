import { useState, useEffect } from 'react';
import { api } from '../../api/client';
import Icon from '../shared/Icon';
import { useMetrics } from '../../hooks/useWebSocket';
import Sparkline from '../shared/Sparkline';

function fmt(bytes) {
  if (!bytes && bytes !== 0) return '—';
  if (bytes === 0) return '0 B';
  const k = 1024; const s = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k));
  return `${(bytes / k**i).toFixed(1)} ${s[Math.min(i,4)]}`;
}

function InfoRow({ k, v }) {
  return <div className="info-row"><span className="info-key">{k}</span><span className="info-val">{v ?? '—'}</span></div>;
}

function StatusDot({ ok }) {
  return (
    <span style={{
      display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
      background: ok ? 'var(--green)' : 'var(--red)',
      boxShadow: ok ? '0 0 6px var(--green)' : 'none',
      marginRight: 6
    }} />
  );
}

export default function Network() {
  const ctx     = useMetrics();
  const m       = ctx?.metrics;
  const h       = ctx?.metrics?.history || {};
  const [stats, setStats] = useState(null);

  useEffect(() => {
    async function load() {
      try { setStats(await api.get('/network/stats')); } catch {}
    }
    load();
    const poll = setInterval(load, 10000);
    return () => clearInterval(poll);
  }, []);

  const ifaces = m?.network?.interfaces || {};
  const primary = m?.network?.primary;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Live bandwidth */}
      <div className="card">
        <div className="card-title"><Icon name="radio" /> Live Bandwidth ({primary || 'eth0'})</div>
        <div className="section-grid-2">
          <div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>Upload</div>
            <div style={{ fontSize: '1.8rem', fontWeight: 700, fontFamily: 'var(--mono)', color: 'var(--cyan)' }}>
              {fmt(m?.network?.txSpeed)}<span style={{ fontSize: '0.8rem', fontWeight: 400 }}>/s</span>
            </div>
            <div style={{ height: 50, marginTop: 8 }}><Sparkline data={h.netUp} color="#06b6d4" height={50} /></div>
          </div>
          <div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>Download</div>
            <div style={{ fontSize: '1.8rem', fontWeight: 700, fontFamily: 'var(--mono)', color: 'var(--green)' }}>
              {fmt(m?.network?.rxSpeed)}<span style={{ fontSize: '0.8rem', fontWeight: 400 }}>/s</span>
            </div>
            <div style={{ height: 50, marginTop: 8 }}><Sparkline data={h.netDown} color="#22c55e" height={50} /></div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 24, marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
          <InfoRow k="Total Sent"     v={fmt(m?.network?.txTotal)} />
          <InfoRow k="Total Received" v={fmt(m?.network?.rxTotal)} />
        </div>
      </div>

      {/* Network info */}
      <div className="section-grid-2">
        <div className="card">
          <div className="card-title"><Icon name="globe" /> IP Addresses</div>
          <InfoRow k="LAN IP"    v={stats?.lanIp || '—'} />
          <InfoRow k="Public IP" v={stats?.publicIp || '—'} />
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 8 }}>Cloudflare Tunnel</div>
            <span>
              <StatusDot ok={stats?.cloudflareTunnel === 'running'} />
              <span style={{ fontSize: '0.85rem' }}>
                {stats?.cloudflareTunnel === 'running' ? 'Active' : 'Stopped'}
              </span>
            </span>
          </div>
          <div style={{ marginTop: 12 }}>
            <InfoRow k="Active SSH Sessions" v={stats?.sshSessions ?? '—'} />
          </div>
        </div>

        <div className="card">
          <div className="card-title"><Icon name="bar-chart" /> Caddy Analytics (last 5 min)</div>
          {stats?.caddy?.available ? (
            <>
              <InfoRow k="Requests/min"     v={stats.caddy.requestsPerMinute} />
              <InfoRow k="Total Requests"   v={stats.caddy.totalRequests} />
              <InfoRow k="Avg Response"     v={`${stats.caddy.avgResponseTime} ms`} />
              <InfoRow k="4xx Errors"       v={stats.caddy.errors4xx} />
              <InfoRow k="5xx Errors"       v={stats.caddy.errors5xx} />
              {Object.keys(stats.caddy.domains || {}).length > 0 && (
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', marginBottom: 6 }}>TOP DOMAINS</div>
                  {Object.entries(stats.caddy.domains)
                    .sort((a,b) => b[1]-a[1])
                    .slice(0, 4)
                    .map(([d,n]) => (
                      <div key={d} className="info-row">
                        <span className="info-key">{d}</span>
                        <span className="info-val">{n} req</span>
                      </div>
                    ))
                  }
                </div>
              )}
            </>
          ) : (
            <div style={{ color: 'var(--text-muted)', fontSize: '0.82rem', padding: '8px 0' }}>
              Caddy access log not found.<br/>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>
                Enable JSON logging in your Caddyfile to see analytics.
              </span>
            </div>
          )}
        </div>
      </div>

      {/* All interfaces */}
      {Object.keys(ifaces).length > 0 && (
        <div className="card">
          <div className="card-title"><Icon name="plug" /> Network Interfaces</div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr><th>Interface</th><th>RX Speed</th><th>TX Speed</th><th>Total RX</th><th>Total TX</th></tr>
              </thead>
              <tbody>
                {Object.entries(ifaces).map(([name, s]) => (
                  <tr key={name}>
                    <td style={{ fontWeight: 500 }}>{name}{name === primary && <span style={{ marginLeft:6, fontSize:'0.7rem', color:'var(--accent)' }}>primary</span>}</td>
                    <td className="mono">{fmt(s.rxSpeed)}/s</td>
                    <td className="mono">{fmt(s.txSpeed)}/s</td>
                    <td className="mono">{fmt(s.rxTotal)}</td>
                    <td className="mono">{fmt(s.txTotal)}</td>
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
