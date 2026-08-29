import { useState, useEffect } from 'react';
import { api } from '../../api/client';

// Labels/units for each tunable. The server owns the defaults and the
// valid range (settings/detectorConfig.js) and ships both with every
// response, so this list only carries presentation.
const FIELDS = [
  { id: 'cpuThresholdPercent', label: 'CPU threshold', unit: '%', hint: 'Raise an incident when host CPU stays at or above this' },
  { id: 'ramThresholdPercent', label: 'Memory threshold', unit: '%', hint: 'Raise an incident when host memory stays at or above this' },
  { id: 'diskThresholdPercent', label: 'Disk threshold', unit: '%', hint: 'Raise an incident when disk usage reaches this (no sustain window — disks fill slowly)' },
  { id: 'resourceStreak', label: 'Sustain window', unit: 'polls', hint: 'Consecutive 5s polls CPU/memory must stay over threshold' },
  { id: 'unhealthyStreak', label: 'Unhealthy streak', unit: 'polls', hint: 'Consecutive polls a container must report unhealthy' },
  { id: 'cooldownMs', label: 'Cooldown', unit: 'ms', hint: 'After a resource resolves, wait this long before raising another for it' },
  { id: 'deployCorrelationWindowMs', label: 'Deploy correlation window', unit: 'ms', hint: 'How far back to look for a deploy to the same repo when gathering incident evidence' }
];

export default function DetectorSettings() {
  const [state, setState]   = useState(null);   // { config, defaults, limits }
  const [draft, setDraft]   = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg]       = useState(null);

  async function load() {
    try {
      const data = await api.get('/settings/detector');
      setState(data);
      setDraft(data.config);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    try {
      // Send numbers, not the raw input strings — the server rejects
      // anything non-numeric rather than coercing it.
      const patch = Object.fromEntries(FIELDS.map(f => [f.id, Number(draft[f.id])]));
      const data = await api.put('/settings/detector', patch);
      setState(data);
      setDraft(data.config);
      setMsg({ ok: true, text: 'Saved — applies on the next detector poll.' });
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    if (!confirm('Reset all detector thresholds to their defaults?')) return;
    setSaving(true);
    try {
      const data = await api.del('/settings/detector');
      setState(data);
      setDraft(data.config);
      setMsg({ ok: true, text: 'Reset to defaults.' });
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="boot-spinner" />;
  if (!state) return null;

  const isDefault = FIELDS.every(f => Number(state.config[f.id]) === Number(state.defaults[f.id]));

  return (
    <div>
      <p className="settings-help">
        When Sentinel raises an incident. Changes take effect on the next 5-second poll — no restart.
        {isDefault && <span style={{ color: 'var(--text-dim)' }}> Currently using defaults.</span>}
      </p>

      <form onSubmit={handleSave}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
          {FIELDS.map(f => {
            const limit = state.limits[f.id] || {};
            return (
              <div key={f.id}>
                <label htmlFor={`detector-${f.id}`} style={{ display: 'block', fontSize: '0.8rem', marginBottom: 4 }}>
                  {f.label} <span style={{ color: 'var(--text-dim)' }}>({f.unit})</span>
                </label>
                <input
                  id={`detector-${f.id}`}
                  type="number"
                  className="input"
                  min={limit.min}
                  max={limit.max}
                  value={draft[f.id] ?? ''}
                  onChange={e => setDraft({ ...draft, [f.id]: e.target.value })}
                  style={{ width: '100%' }}
                />
                <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', marginTop: 3 }}>
                  {f.hint}. Default {state.defaults[f.id]}.
                </div>
              </div>
            );
          })}
        </div>

        {msg && (
          <div style={{ marginTop: 12, fontSize: '0.82rem', color: msg.ok ? 'var(--green)' : 'var(--red)' }}>
            {msg.text}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button id="btn-save-detector-settings" type="submit" className="btn btn-primary btn-sm" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button id="btn-reset-detector-settings" type="button" className="btn btn-secondary btn-sm" onClick={handleReset} disabled={saving || isDefault}>
            Reset to defaults
          </button>
        </div>
      </form>
    </div>
  );
}
