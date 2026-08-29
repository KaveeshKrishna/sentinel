import { useState, useEffect } from 'react';
import { api } from '../../api/client';

const CHANNELS = [
  { id: 'slack',   label: 'Slack webhook',   hint: 'Slack → Apps → Incoming Webhooks. Approve buttons work with no Slack app.' },
  { id: 'discord', label: 'Discord webhook', hint: 'Channel → Edit → Integrations → Webhooks.' },
  { id: 'webhook', label: 'Generic webhook', hint: 'Any endpoint that accepts a JSON POST (ntfy, a bot, an email bridge).' }
];

const EVENT_LABELS = {
  INCIDENT_DETECTED:          'Incident detected',
  INCIDENT_AWAITING_APPROVAL: 'Approval needed',
  INCIDENT_AUTO_REMEDIATE:    'Auto-remediating',
  INCIDENT_RESOLVED:          'Incident resolved',
  INCIDENT_FAILED:            'Remediation failed'
};

export default function NotifySettings() {
  const [config, setConfig] = useState(null);
  const [urls, setUrls]     = useState({ slack: '', discord: '', webhook: '' });
  const [baseUrl, setBaseUrl] = useState('');
  const [events, setEvents]   = useState([]);
  const [approveLinks, setApproveLinks] = useState(false);
  const [saving, setSaving]   = useState(false);
  const [testing, setTesting] = useState(false);
  const [msg, setMsg]         = useState(null);

  async function load() {
    try {
      const c = await api.get('/settings/notify');
      setConfig(c);
      setBaseUrl(c.baseUrl || '');
      setEvents(c.events || []);
      setApproveLinks(!!c.approveLinks);
    } catch { /* section degrades to its empty state */ }
  }

  useEffect(() => { load(); }, []);

  function toggleEvent(id) {
    setEvents(prev => prev.includes(id) ? prev.filter(e => e !== id) : [...prev, id]);
  }

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    try {
      // A blank URL field means "keep what's stored" — the server never
      // sends the real URL back, only a masked form.
      const patch = { baseUrl, events, approveLinks };
      for (const { id } of CHANNELS) {
        if (urls[id].trim()) patch[`${id}Url`] = urls[id].trim();
      }
      setConfig(await api.put('/settings/notify', patch));
      setUrls({ slack: '', discord: '', webhook: '' });
      setMsg({ ok: true, text: 'Saved.' });
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    } finally {
      setSaving(false);
    }
  }

  async function clearChannel(id) {
    if (!confirm(`Remove the ${id} webhook?`)) return;
    try {
      setConfig(await api.put('/settings/notify', { [`${id}Url`]: '' }));
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    }
  }

  async function test() {
    setTesting(true);
    setMsg(null);
    try {
      const { results } = await api.post('/settings/notify/test');
      const failed = Object.entries(results).filter(([, r]) => !r.ok);
      setMsg(failed.length === 0
        ? { ok: true, text: `Test sent to ${Object.keys(results).join(', ')}.` }
        : { ok: false, text: failed.map(([c, r]) => `${c}: ${r.error}`).join(' · ') });
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    } finally {
      setTesting(false);
    }
  }

  if (!config) return null;

  return (
    <div>
      <p className="settings-help">
        Push incident events to a channel so Sentinel pages you instead of waiting to be watched.
      </p>

      <form onSubmit={save}>
        {CHANNELS.map(ch => (
          <div className="form-group" key={ch.id}>
            <label className="form-label" htmlFor={`notify-${ch.id}`}>{ch.label}</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                id={`notify-${ch.id}`}
                className="form-input"
                type="url"
                placeholder={config.channels[ch.id].configured ? `Saved: ${config.channels[ch.id].masked}` : 'https://…'}
                value={urls[ch.id]}
                onChange={e => setUrls(u => ({ ...u, [ch.id]: e.target.value }))}
              />
              {config.channels[ch.id].configured && (
                <button type="button" className="btn btn-danger btn-sm" onClick={() => clearChannel(ch.id)}>Remove</button>
              )}
            </div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', marginTop: 4 }}>{ch.hint}</div>
          </div>
        ))}

        <div className="form-group">
          <label className="form-label" htmlFor="notify-base-url">Public URL of this Sentinel</label>
          <input
            id="notify-base-url"
            className="form-input"
            type="url"
            placeholder="https://sentinel.example.com"
            value={baseUrl}
            onChange={e => setBaseUrl(e.target.value)}
          />
          <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', marginTop: 4 }}>
            Used to build the links in a notification. Without it, messages carry no links.
          </div>
        </div>

        <div className="form-group">
          <label className="form-label">Notify on</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {config.availableEvents.map(id => (
              <label key={id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.8rem', cursor: 'pointer' }}>
                <input type="checkbox" checked={events.includes(id)} onChange={() => toggleEvent(id)} />
                {EVENT_LABELS[id] || id}
              </label>
            ))}
          </div>
        </div>

        <div className="form-group">
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
            <input
              id="notify-approve-links"
              type="checkbox"
              checked={approveLinks}
              onChange={e => setApproveLinks(e.target.checked)}
              style={{ marginTop: 3 }}
            />
            <span>
              <span style={{ fontSize: '0.85rem', fontWeight: 500 }}>One-click approval links</span>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.5, marginTop: 2 }}>
                Adds an <strong>Approve</strong> button to the "approval needed" message so you can approve
                a remediation from your phone. The link is signed, expires after 30 minutes, works once, and
                covers only that one action — opening it shows a confirmation page first, so a link preview
                can't approve anything. Anyone with the link can approve that action, so only enable this for
                a channel you trust.
              </div>
            </span>
          </label>
        </div>

        {msg && (
          <div style={{
            fontSize: '0.8rem', marginBottom: 10,
            color: msg.ok ? 'var(--green)' : 'var(--red)'
          }}>
            {msg.text}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button id="btn-save-notify" type="submit" className="btn btn-primary btn-sm" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button id="btn-test-notify" type="button" className="btn btn-secondary btn-sm" onClick={test} disabled={testing}>
            {testing ? 'Sending…' : 'Send test'}
          </button>
        </div>
      </form>
    </div>
  );
}
