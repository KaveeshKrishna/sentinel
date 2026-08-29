import { useState, useEffect } from 'react';
import { api } from '../../api/client';
import Icon from '../shared/Icon';

export const PROVIDERS = [
  { id: 'anthropic',         label: 'Anthropic',         modelHint: 'e.g. claude-sonnet-5',  needsBaseUrl: false },
  { id: 'gemini',            label: 'Google Gemini',     modelHint: 'e.g. gemini-2.0-flash', needsBaseUrl: false },
  { id: 'openai-compatible', label: 'OpenAI-compatible', modelHint: 'e.g. gpt-4o, or a model id from OpenRouter/Groq/a local server', needsBaseUrl: true }
];

const providerLabel = id => PROVIDERS.find(p => p.id === id)?.label || id;

function relativeTime(ts) {
  if (!ts) return '';
  const seconds = Math.round((Date.now() - ts) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

const EMPTY_FORM = { label: '', provider: 'anthropic', model: '', baseUrl: '', apiKey: '', rpmLimit: '', rpdLimit: '' };

/**
 * Known free-tier ceilings, offered as placeholders so an operator does
 * not have to go and look them up. Only hints — the field stays empty
 * (no local cap) unless they choose to set one.
 */
const LIMIT_HINTS = {
  gemini: { rpm: '5', rpd: '20' },
  anthropic: { rpm: '', rpd: '' },
  'openai-compatible': { rpm: '', rpd: '' }
};

/**
 * The credential form, used for both "add" and "edit". On edit the API
 * key field may be left blank to keep the stored one — the same
 * semantics the server has (settings/aiCredentials.js).
 */
function CredentialForm({ initial, isEdit, busy, onSubmit, onCancel }) {
  const [form, setForm] = useState(initial || EMPTY_FORM);
  const info = PROVIDERS.find(p => p.id === form.provider) || PROVIDERS[0];
  const set = (key, value) => setForm(f => ({ ...f, [key]: value }));

  return (
    <form
      className="cred-form"
      onSubmit={e => { e.preventDefault(); onSubmit(form); }}
    >
      <div className="cred-form-grid">
        <div className="form-group">
          <label className="form-label">Name</label>
          <input
            className="form-input" placeholder="e.g. Anthropic (work)"
            value={form.label} onChange={e => set('label', e.target.value)}
          />
        </div>
        <div className="form-group">
          <label className="form-label">Provider</label>
          <select className="form-input" value={form.provider} onChange={e => set('provider', e.target.value)}>
            {PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">Model</label>
          <input
            className="form-input" placeholder={info.modelHint}
            value={form.model} onChange={e => set('model', e.target.value)}
          />
        </div>
        <div className="form-group">
          <label className="form-label">
            API Key {isEdit && <span className="form-label-hint">(blank keeps the saved key)</span>}
          </label>
          <input
            className="form-input" type="password" autoComplete="off"
            placeholder={isEdit ? '••••••••' : 'sk-…'}
            value={form.apiKey} onChange={e => set('apiKey', e.target.value)}
          />
        </div>
        {info.needsBaseUrl && (
          <div className="form-group cred-form-wide">
            <label className="form-label">Base URL</label>
            <input
              className="form-input"
              placeholder="https://api.openai.com/v1 (or OpenRouter/Groq/local)"
              value={form.baseUrl} onChange={e => set('baseUrl', e.target.value)}
            />
          </div>
        )}
        <div className="form-group">
          <label className="form-label">
            Requests / minute <span className="form-label-hint">(blank = no cap)</span>
          </label>
          <input
            className="form-input" inputMode="numeric"
            placeholder={LIMIT_HINTS[form.provider]?.rpm || 'no limit'}
            value={form.rpmLimit ?? ''} onChange={e => set('rpmLimit', e.target.value)}
          />
        </div>
        <div className="form-group">
          <label className="form-label">
            Requests / day <span className="form-label-hint">(blank = no cap)</span>
          </label>
          <input
            className="form-input" inputMode="numeric"
            placeholder={LIMIT_HINTS[form.provider]?.rpd || 'no limit'}
            value={form.rpdLimit ?? ''} onChange={e => set('rpdLimit', e.target.value)}
          />
        </div>
        <p className="settings-footnote cred-form-wide" style={{ marginTop: 0 }}>
          Sentinel counts its own requests and skips this credential once a limit is reached,
          rather than spending one to be told 429. It also pauses a credential automatically for
          5 minutes whenever the provider itself returns a rate-limit error.
        </p>
      </div>
      <div className="cred-form-actions">
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
          {busy ? 'Saving…' : (isEdit ? 'Save changes' : 'Add provider')}
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * The AI provider pool: an ordered list of credentials tried top-first on
 * every AI call, with automatic failover to the next one. Each row shows
 * why it last failed, which is the whole point of the ordering being
 * visible — an operator should be able to see "key 1 is out of quota, so
 * key 2 is doing the work" without reading a log.
 */
export default function AIProvidersSettings() {
  const [credentials, setCredentials] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [adding, setAdding]     = useState(false);
  const [editingId, setEditing] = useState(null);
  const [busy, setBusy]         = useState(false);
  const [msg, setMsg]           = useState(null);
  const [testingId, setTesting] = useState(null);

  async function load() {
    try {
      const { credentials: list } = await api.get('/settings/ai/credentials');
      setCredentials(list);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function run(fn, successText) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      await load();
      if (successText) setMsg({ ok: true, text: successText });
      return true;
    } catch (err) {
      setMsg({ ok: false, text: err.message });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function handleAdd(form) {
    const ok = await run(
      () => api.post('/settings/ai/credentials', {
        label: form.label || undefined, provider: form.provider,
        model: form.model || undefined, baseUrl: form.baseUrl || undefined,
        apiKey: form.apiKey,
        rpmLimit: form.rpmLimit || null, rpdLimit: form.rpdLimit || null
      }),
      'Provider added.'
    );
    if (ok) setAdding(false);
  }

  async function handleEdit(id, form) {
    const ok = await run(
      () => api.put(`/settings/ai/credentials/${id}`, {
        label: form.label, provider: form.provider,
        model: form.model || null, baseUrl: form.baseUrl || null,
        apiKey: form.apiKey || undefined,
        rpmLimit: form.rpmLimit || null, rpdLimit: form.rpdLimit || null
      }),
      'Saved.'
    );
    if (ok) setEditing(null);
  }

  async function handleDelete(cred) {
    if (!confirm(`Remove "${cred.label}" from the failover chain? Its API key is deleted.`)) return;
    run(() => api.del(`/settings/ai/credentials/${cred.id}`));
  }

  function move(index, delta) {
    const next = [...credentials];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    // Optimistic: the list reorders under the cursor immediately, then
    // reloads from the server's own authoritative ordering.
    setCredentials(next);
    run(() => api.put('/settings/ai/credentials/order', { ids: next.map(c => c.id) }));
  }

  async function handleTest(cred) {
    setTesting(cred.id);
    setMsg(null);
    try {
      const result = await api.post(`/settings/ai/credentials/${cred.id}/test`, {});
      setMsg({ ok: true, text: `${cred.label} replied: "${result.sample}"` });
    } catch (err) {
      setMsg({ ok: false, text: `${cred.label}: ${err.message}` });
    } finally {
      setTesting(null);
      load();
    }
  }

  if (loading) return <div className="boot-spinner" />;

  const active = credentials.filter(c => c.enabled);

  return (
    <div>
      <p className="settings-help">
        Sentinel tries these in order on every AI call — diagnosis, Ask Sentinel and incident
        reports. If one returns an error (quota exhausted, revoked key, provider outage) it
        automatically falls through to the next and carries on without interruption. The exact
        error is shown on the credential below and pushed as a notification.
      </p>

      {credentials.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon"><Icon name="cpu" size={32} /></div>
          <p>No AI provider configured — incident diagnosis and Ask Sentinel are disabled.</p>
        </div>
      ) : (
        <ol className="cred-list">
          {credentials.map((cred, index) => {
            const failing = !!cred.lastError;
            const cooling = cred.cooldownUntil && cred.cooldownUntil > Date.now();
            return (
              <li
                key={cred.id}
                className={`cred-row${cred.enabled ? '' : ' cred-row-off'}${failing ? ' cred-row-failing' : ''}`}
              >
                <div className="cred-rank" title={`Priority ${index + 1} of ${credentials.length}`}>
                  {index + 1}
                </div>

                <div className="cred-main">
                  <div className="cred-head">
                    <span className="cred-label">{cred.label}</span>
                    <span className="badge badge-gray">{providerLabel(cred.provider)}</span>
                    {cred.model && <span className="cred-model">{cred.model}</span>}
                    {!cred.enabled && <span className="badge badge-gray">Disabled</span>}
                    {cred.enabled && index === 0 && !failing && (
                      <span className="badge badge-green">
                        <span className="badge-dot" style={{ background: 'var(--green)' }} />
                        Primary
                      </span>
                    )}
                    {failing && (
                      <span className="badge badge-red">
                        <span className="badge-dot" style={{ background: 'var(--red)' }} />
                        Failing
                      </span>
                    )}
                  </div>

                  <div className="cred-meta">
                    <span>Key ends in <code>{cred.keySuffix || '????'}</code></span>
                    {cred.baseUrl && <span>· {cred.baseUrl}</span>}
                    {cred.rpdLimit && (
                      <span>· {cred.usage?.lastDay ?? 0}/{cred.rpdLimit} today</span>
                    )}
                    {cred.rpmLimit && (
                      <span>· {cred.usage?.lastMinute ?? 0}/{cred.rpmLimit} this minute</span>
                    )}
                    {cred.lastOkAt && !failing && <span>· last worked {relativeTime(cred.lastOkAt)}</span>}
                  </div>

                  {cooling && (
                    <div className="cred-note">
                      <Icon name="pause" size={13} /> Paused until {new Date(cred.cooldownUntil).toLocaleTimeString()} — the provider
                      returned a rate-limit error, so Sentinel is skipping this key rather than
                      spending more of its allowance being refused.
                    </div>
                  )}

                  {failing && (
                    <div className="cred-error" title={cred.lastError}>
                      <strong>Last error{cred.lastErrorAt ? ` (${relativeTime(cred.lastErrorAt)})` : ''}:</strong>{' '}
                      {cred.lastError}
                    </div>
                  )}

                  {cred.keySuffix === null && (
                    <div className="cred-error">
                      This credential can no longer be decrypted — re-enter its API key.
                    </div>
                  )}

                  {editingId === cred.id && (
                    <CredentialForm
                      isEdit
                      busy={busy}
                      initial={{
                        label: cred.label, provider: cred.provider,
                        model: cred.model || '', baseUrl: cred.baseUrl || '', apiKey: '',
                        rpmLimit: cred.rpmLimit ?? '', rpdLimit: cred.rpdLimit ?? ''
                      }}
                      onSubmit={form => handleEdit(cred.id, form)}
                      onCancel={() => setEditing(null)}
                    />
                  )}
                </div>

                <div className="cred-actions">
                  <div className="cred-move">
                    <button
                      className="btn btn-secondary btn-icon" title="Try earlier"
                      onClick={() => move(index, -1)} disabled={index === 0 || busy}
                    >▲</button>
                    <button
                      className="btn btn-secondary btn-icon" title="Try later"
                      onClick={() => move(index, 1)} disabled={index === credentials.length - 1 || busy}
                    >▼</button>
                  </div>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => handleTest(cred)} disabled={testingId === cred.id}
                  >
                    {testingId === cred.id ? 'Testing…' : 'Test'}
                  </button>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => { setEditing(editingId === cred.id ? null : cred.id); setAdding(false); }}
                  >
                    {editingId === cred.id ? 'Close' : 'Edit'}
                  </button>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => run(() => api.put(`/settings/ai/credentials/${cred.id}`, { enabled: !cred.enabled }))}
                    disabled={busy}
                    title={cred.enabled ? 'Skip this credential without deleting it' : 'Put it back in the chain'}
                  >
                    {cred.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button className="btn btn-danger btn-sm" onClick={() => handleDelete(cred)} disabled={busy}>
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {msg && (
        <div className="inline-msg" data-ok={msg.ok ? 'true' : 'false'}>{msg.text}</div>
      )}

      {adding ? (
        <CredentialForm busy={busy} onSubmit={handleAdd} onCancel={() => setAdding(false)} />
      ) : (
        <button
          id="btn-add-ai-credential"
          className="btn btn-primary btn-sm"
          style={{ marginTop: 12 }}
          onClick={() => { setAdding(true); setEditing(null); }}
        >
          + Add provider
        </button>
      )}

      {credentials.length > 1 && (
        <p className="settings-footnote">
          {active.length} of {credentials.length} in the failover chain. Keys are AES-256-GCM
          encrypted at rest and never sent back to this page — only the last 4 characters.
        </p>
      )}
    </div>
  );
}
