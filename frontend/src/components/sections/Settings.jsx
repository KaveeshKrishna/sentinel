import { useState, useEffect } from 'react';
import { api } from '../../api/client';
import DetectorSettings from './DetectorSettings';
import AutoRemediateSettings from './AutoRemediateSettings';
import NotifySettings from './NotifySettings';

const PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic', modelHint: 'e.g. claude-sonnet-5', needsBaseUrl: false },
  { id: 'gemini', label: 'Google Gemini', modelHint: 'e.g. gemini-2.0-flash', needsBaseUrl: false },
  { id: 'openai-compatible', label: 'OpenAI-compatible', modelHint: 'e.g. gpt-4o, or a model id from OpenRouter/Groq/a local server', needsBaseUrl: true }
];

export default function Settings() {
  const [config, setConfig]     = useState(null);
  const [loading, setLoading]   = useState(true);
  const [provider, setProvider] = useState('anthropic');
  const [model, setModel]       = useState('');
  const [baseUrl, setBaseUrl]   = useState('');
  const [apiKey, setApiKey]     = useState('');
  const [saving, setSaving]     = useState(false);
  const [testing, setTesting]   = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [saveMsg, setSaveMsg]   = useState(null);

  async function load() {
    try {
      const c = await api.get('/settings/ai');
      setConfig(c);
      if (c.provider) setProvider(c.provider);
      if (c.model) setModel(c.model);
      if (c.baseUrl) setBaseUrl(c.baseUrl);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  const providerInfo = PROVIDERS.find(p => p.id === provider) || PROVIDERS[0];

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setSaveMsg(null);
    try {
      const updated = await api.put('/settings/ai', {
        provider, model: model || undefined, baseUrl: baseUrl || undefined, apiKey: apiKey || undefined
      });
      setConfig(updated);
      setApiKey('');
      setSaveMsg({ ok: true, text: 'Saved.' });
    } catch (err) {
      setSaveMsg({ ok: false, text: err.message });
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const body = { provider, model: model || undefined, baseUrl: baseUrl || undefined };
      if (apiKey) body.apiKey = apiKey;
      const result = await api.post('/settings/ai/test-connection', body);
      setTestResult({ ok: true, text: `Connected — model replied: "${result.sample}"` });
    } catch (err) {
      setTestResult({ ok: false, text: err.message });
    } finally {
      setTesting(false);
    }
  }

  async function handleClear() {
    if (!confirm('Remove the saved AI provider configuration? The incident engine will stop diagnosing new incidents until reconfigured.')) return;
    await api.del('/settings/ai');
    setApiKey('');
    setModel('');
    setBaseUrl('');
    await load();
  }

  if (loading) return <div className="empty-state"><div className="boot-spinner" /></div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 720 }}>
      <div className="card">
        <div className="card-title">🤖 AI Provider</div>
        <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 16 }}>
          Powers incident diagnosis (OBSERVE → DIAGNOSE). Your API key is encrypted at rest
          and never sent back to the browser — only the last 4 characters are shown once saved.
        </div>

        <div style={{ marginBottom: 16 }}>
          <span className={`badge ${config?.configured ? 'badge-green' : 'badge-gray'}`}>
            <span className="badge-dot" style={{ background: config?.configured ? 'var(--green)' : 'var(--text-dim)' }} />
            {config?.configured ? `Configured (key ends in ${config.keySuffix || '????'})` : 'Not configured'}
          </span>
        </div>

        <form onSubmit={handleSave}>
          <div className="form-group">
            <label className="form-label">Provider</label>
            <select
              id="input-ai-provider"
              className="form-input"
              value={provider}
              onChange={e => setProvider(e.target.value)}
            >
              {PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </div>

          <div className="form-group">
            <label className="form-label">Model</label>
            <input
              id="input-ai-model"
              className="form-input"
              placeholder={providerInfo.modelHint}
              value={model}
              onChange={e => setModel(e.target.value)}
            />
          </div>

          {providerInfo.needsBaseUrl && (
            <div className="form-group">
              <label className="form-label">Base URL</label>
              <input
                id="input-ai-base-url"
                className="form-input"
                placeholder="https://api.openai.com/v1 (or OpenRouter/Groq/local)"
                value={baseUrl}
                onChange={e => setBaseUrl(e.target.value)}
              />
            </div>
          )}

          <div className="form-group">
            <label className="form-label">API Key {config?.configured && <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>(leave blank to keep the saved key)</span>}</label>
            <input
              id="input-ai-api-key"
              className="form-input"
              type="password"
              placeholder={config?.configured ? '••••••••' : 'sk-…'}
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              autoComplete="off"
            />
          </div>

          {testResult && (
            <div className="error-msg" style={{ color: testResult.ok ? 'var(--green)' : 'var(--red)', borderColor: testResult.ok ? 'var(--green)' : 'var(--red)' }}>
              {testResult.text}
            </div>
          )}
          {saveMsg && (
            <div className="error-msg" style={{ color: saveMsg.ok ? 'var(--green)' : 'var(--red)', borderColor: saveMsg.ok ? 'var(--green)' : 'var(--red)' }}>
              {saveMsg.text}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <button id="btn-save-ai-settings" type="submit" className="btn btn-primary btn-sm" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button id="btn-test-ai-settings" type="button" className="btn btn-secondary btn-sm" onClick={handleTest} disabled={testing}>
              {testing ? 'Testing…' : 'Test Connection'}
            </button>
            {config?.configured && (
              <button id="btn-clear-ai-settings" type="button" className="btn btn-danger btn-sm" style={{ marginLeft: 'auto' }} onClick={handleClear}>
                Remove
              </button>
            )}
          </div>
        </form>
      </div>

      <DetectorSettings />
      <AutoRemediateSettings />
      <NotifySettings />
    </div>
  );
}
