import { useState, useEffect } from 'react';
import { api } from '../../api/client';

// Only these resource types can host an auto-remediable action (the
// server's tool allowlist covers services and containers only).
const ELIGIBLE_TYPES = ['service', 'container'];

export default function AutoRemediateSettings() {
  const [policy, setPolicy]       = useState(null);  // { resources, allowedTools, maxRisk, maxPerHour }
  const [resources, setResources] = useState([]);
  const [selected, setSelected]   = useState([]);
  const [loading, setLoading]     = useState(true);
  const [saving, setSaving]       = useState(false);
  const [msg, setMsg]             = useState(null);

  async function load() {
    try {
      const [p, all] = await Promise.all([
        api.get('/settings/auto-remediate'),
        api.get('/resources').catch(() => [])
      ]);
      setPolicy(p);
      setSelected(p.resources);
      setResources((all || []).filter(r => ELIGIBLE_TYPES.includes(r.type)));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  function toggle(key) {
    setSelected(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);
  }

  async function handleSave() {
    setSaving(true);
    setMsg(null);
    try {
      const saved = await api.put('/settings/auto-remediate', { resources: selected });
      setPolicy(saved);
      setSelected(saved.resources);
      setMsg({ ok: true, text: saved.resources.length ? `Auto-remediation on for ${saved.resources.length} resource(s).` : 'Auto-remediation off for everything.' });
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="boot-spinner" />;
  if (!policy) return null;

  const dirty = JSON.stringify([...selected].sort()) !== JSON.stringify([...policy.resources].sort());
  // A resource that was opted in but is no longer visible (container
  // removed, say) would otherwise vanish silently and stay in the list.
  const orphans = policy.resources.filter(k => !resources.some(r => `${r.type}:${r.external_id}` === k));

  return (
    <div>
      <p className="settings-help" style={{ marginBottom: 4 }}>
        Normally every AI-recommended action waits for you to click approve. For the resources ticked
        below, Sentinel will run a <strong>restorative</strong> action by itself — start or restart —
        then verify it worked, exactly as if you had approved it. If a service goes inactive or a
        container exits and the AI diagnosis proposes no restart, Sentinel restarts it anyway — for
        these triggers, "it stopped, so start it" isn't a judgement call.
      </p>
      <p style={{ fontSize: '0.76rem', color: 'var(--text-dim)', marginBottom: 12 }}>
        Limits, enforced in code and not settable here: only {policy.allowedTools.join(', ')}; nothing above{' '}
        {policy.maxRisk.replace('_', ' ').toLowerCase()}; at most {policy.maxPerHour} per resource per hour,
        after which it escalates to you. Stopping something from Sentinel's own UI is not undone
        immediately — but once that grace window lapses, an opted-in resource will be restarted, so turn
        it off here first if you need something to stay down.
      </p>

      {resources.length === 0 ? (
        <p style={{ fontSize: '0.82rem', color: 'var(--text-dim)' }}>
          No services or containers observed yet. They appear here once Sentinel has seen them.
        </p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 6 }}>
          {resources.map(r => {
            const key = `${r.type}:${r.external_id}`;
            return (
              <label key={key} htmlFor={`auto-${key}`} style={{
                display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.84rem',
                padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 'var(--r)',
                cursor: 'pointer'
              }}>
                <input
                  id={`auto-${key}`}
                  type="checkbox"
                  checked={selected.includes(key)}
                  onChange={() => toggle(key)}
                />
                <span style={{ fontWeight: 500 }}>{r.name || r.external_id}</span>
                <span style={{ color: 'var(--text-dim)', fontSize: '0.74rem', marginLeft: 'auto' }}>{r.type}</span>
              </label>
            );
          })}
        </div>
      )}

      {orphans.length > 0 && (
        <p style={{ fontSize: '0.76rem', color: 'var(--yellow)', marginTop: 10 }}>
          Enabled but not currently observed: {orphans.join(', ')} — still active if they reappear.
        </p>
      )}

      {msg && (
        <div style={{ marginTop: 12, fontSize: '0.82rem', color: msg.ok ? 'var(--green)' : 'var(--red)' }}>
          {msg.text}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <button id="btn-save-auto-remediate" className="btn btn-primary btn-sm" onClick={handleSave} disabled={saving || !dirty}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {selected.length > 0 && (
          <button id="btn-clear-auto-remediate" className="btn btn-secondary btn-sm" onClick={() => setSelected([])} disabled={saving}>
            Untick all
          </button>
        )}
      </div>
    </div>
  );
}
