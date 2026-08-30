import { useState, useEffect } from 'react';
import { api } from '../../api/client';

const SUGGESTIONS = [
  { path: '/var/log', label: 'System & service logs' },
  { path: '/etc/caddy', label: 'Reverse proxy config' },
  { path: '/srv/apps', label: 'Application code & deploys' }
];

/**
 * How much of the host Ask Sentinel may look at.
 *
 * Deliberately two separate switches. Sentinel's own records carry no
 * host risk and are on by default. Host directories start closed and are
 * added one at a time — this is the setting that widens what the AI can
 * see, so it should never be a single "allow everything" toggle.
 */
export default function AccessSettings() {
  const [scope, setScope]   = useState(null);
  const [newPath, setPath]  = useState('');
  const [busy, setBusy]     = useState(false);
  const [msg, setMsg]       = useState(null);

  async function load() {
    try { setScope(await api.get('/settings/access')); } catch { /* section renders empty */ }
  }
  useEffect(() => { load(); }, []);

  async function save(patch) {
    setBusy(true);
    setMsg(null);
    try {
      setScope({ ...(await api.put('/settings/access', patch)), maxPaths: scope.maxPaths });
      setPath('');
    } catch (err) {
      setMsg(err.message);
    } finally {
      setBusy(false);
    }
  }

  function addPath(value) {
    const path = (value ?? newPath).trim();
    if (!path) return;
    if (scope.paths.some(p => p.path === path)) { setMsg('That directory is already allowed.'); return; }
    save({ paths: [...scope.paths, { path }] });
  }

  function removePath(path) {
    save({ paths: scope.paths.filter(p => p.path !== path) });
  }

  if (!scope) return <div className="boot-spinner" />;

  const unused = SUGGESTIONS.filter(s => !scope.paths.some(p => p.path === s.path));

  return (
    <div>
      <p className="settings-help">
        Controls what Ask Sentinel can look at when answering. It can never change anything —
        these are read-only — and never returns keys, credentials, <code>/etc/sentinel</code>,{' '}
        <code>/root</code> or SSH material, whatever you allow below.
      </p>

      <label className="access-toggle">
        <input
          type="checkbox"
          checked={scope.ownData}
          disabled={busy}
          onChange={e => save({ ownData: e.target.checked })}
        />
        <span>
          <strong>Sentinel's own records</strong>
          <span className="access-toggle-desc">
            Recording sessions, incident history and the activity timeline. Lets you ask things like
            "summarise the recording session from this morning". No host access involved.
          </span>
        </span>
      </label>

      <div className="access-section">
        <div className="access-section-title">Host directories</div>
        <p className="settings-footnote" style={{ marginTop: 0, marginBottom: 10 }}>
          Nothing on the filesystem is readable until you add a directory here. Sentinel can then
          list, read and search inside it — useful for application logs, config and deploy
          artifacts it can't otherwise see.
        </p>

        {scope.paths.length === 0 ? (
          <div className="access-empty">No directories allowed — filesystem access is off.</div>
        ) : (
          <ul className="access-path-list">
            {scope.paths.map(p => (
              <li key={p.path} className="access-path">
                <code>{p.path}</code>
                {p.label && <span className="access-path-label">{p.label}</span>}
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => removePath(p.path)}
                  disabled={busy}
                >Remove</button>
              </li>
            ))}
          </ul>
        )}

        <form
          className="access-add"
          onSubmit={e => { e.preventDefault(); addPath(); }}
        >
          <input
            id="input-access-path"
            className="form-input"
            placeholder="/var/log"
            value={newPath}
            onChange={e => setPath(e.target.value)}
          />
          <button className="btn btn-primary btn-sm" type="submit" disabled={busy || !newPath.trim()}>
            Allow
          </button>
        </form>

        {unused.length > 0 && (
          <div className="access-suggestions">
            <span>Common:</span>
            {unused.map(s => (
              <button
                key={s.path}
                className="chat-suggestion"
                onClick={() => addPath(s.path)}
                disabled={busy}
                title={s.label}
              >{s.path}</button>
            ))}
          </div>
        )}
      </div>

      {msg && <div className="inline-msg" data-ok="false">{msg}</div>}
    </div>
  );
}
