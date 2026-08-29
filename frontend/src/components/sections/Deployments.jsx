import { useState, useEffect, useRef } from 'react';
import { api } from '../../api/client';
import Icon from '../shared/Icon';

function timeAgo(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  const s = Math.floor((Date.now() - d) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
}

function RepoCard({ repo, onRefresh }) {
  const [deploying, setDeploying]   = useState(false);
  const [logs, setLogs]             = useState([]);
  const [showLogs, setShowLogs]     = useState(false);
  const logsEndRef = useRef(null);

  async function deploy() {
    setDeploying(true);
    setShowLogs(true);
    setLogs([]);

    const es = new EventSource(`/api/deployments/${encodeURIComponent(repo.name)}/deploy`);
    // EventSource doesn't support POST directly — use fetch with SSE
    es.close();

    // Use fetch + ReadableStream for SSE POST
    try {
      const resp = await fetch(`/api/deployments/${encodeURIComponent(repo.name)}/deploy`, { method: 'POST' });
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop();
        for (const part of parts) {
          const dataLine = part.split('\n').find(l => l.startsWith('data:'));
          if (dataLine) {
            try {
              const event = JSON.parse(dataLine.slice(5));
              setLogs(prev => [...prev, event]);
              logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
            } catch {}
          }
        }
      }
    } catch (err) {
      setLogs(prev => [...prev, { type: 'error', data: err.message }]);
    } finally {
      setDeploying(false);
      onRefresh();
    }
  }

  const isDirty = !repo.clean;
  const canDeploy = !deploying && !repo.error && repo.behind > 0 && !isDirty;

  return (
    <div id={`repo-card-${repo.name}`} className="repo-card">
      <div className="repo-header">
        <div>
          <div className="repo-name"><Icon name="folder" /> {repo.name}</div>
          {repo.branch && <span className="repo-branch"><Icon name="git-branch" size={12} /> {repo.branch}</span>}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {isDirty && (
            <span style={{ fontSize: '0.72rem', color: 'var(--yellow)', background: 'var(--yellow-dim)', padding: '2px 8px', borderRadius: 4 }}>
              <Icon name="alert-triangle" size={12} /> Dirty ({repo.uncommittedFiles} files)
            </span>
          )}
          {repo.behind > 0 && !isDirty && (
            <span style={{ fontSize: '0.72rem', color: 'var(--green)', background: 'var(--green-dim)', padding: '2px 8px', borderRadius: 4 }}>
              <Icon name="arrow-down" size={12} /> {repo.behind} behind
            </span>
          )}
          {repo.ahead > 0 && (
            <span style={{ fontSize: '0.72rem', color: 'var(--accent)', background: 'var(--accent-dim)', padding: '2px 8px', borderRadius: 4 }}>
              <Icon name="arrow-up" size={12} /> {repo.ahead} ahead
            </span>
          )}
        </div>
      </div>

      {repo.error ? (
        <div style={{ color: 'var(--red)', fontSize: '0.8rem' }}>{repo.error}</div>
      ) : (
        <>
          <div className="repo-commit">
            <span className="repo-hash">{repo.commit?.hash}</span>
            {' '}
            <span>{repo.commit?.message}</span>
            <div style={{ marginTop: 2, fontSize: '0.75rem', color: 'var(--text-dim)' }}>
              by {repo.commit?.author} · {timeAgo(repo.commit?.date)}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              id={`btn-deploy-${repo.name}`}
              className="btn btn-primary btn-sm"
              onClick={deploy}
              disabled={deploying || !!repo.error || isDirty}
              title={isDirty ? 'Cannot deploy: uncommitted changes' : repo.behind === 0 ? 'Already up to date' : 'Deploy'}
            >
              {deploying ? <><Icon name="refresh-cw" size={12} /> Deploying…</> : <><Icon name="rocket" size={12} /> Pull & Deploy</>}
            </button>
            <button
              id={`btn-toggle-logs-${repo.name}`}
              className="btn btn-secondary btn-sm"
              onClick={() => setShowLogs(v => !v)}
            >
              {showLogs ? 'Hide Logs' : 'Show Logs'}
            </button>
            {repo.composeFile && (
              <span style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>
                <Icon name="file" size={12} /> {repo.composeFile}
              </span>
            )}
          </div>

          {showLogs && logs.length > 0 && (
            <div className="deploy-log" id={`deploy-log-${repo.name}`}>
              {logs.map((l, i) => (
                <div key={i} className={`deploy-line ${l.type || ''}`}>
                  {l.data}
                </div>
              ))}
              <div ref={logsEndRef} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function Deployments() {
  const [repos, setRepos]     = useState([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    try {
      setRepos(await api.get('/deployments'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  if (loading) return <div className="empty-state"><div className="boot-spinner" /></div>;
  if (repos.length === 0) return (
    <div className="empty-state">
      <div className="empty-state-icon"><Icon name="folder" size={32} /></div>
      <p>No git repositories found in /srv/apps</p>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button id="btn-refresh-repos" className="btn btn-secondary btn-sm" onClick={load}><Icon name="refresh-cw" size={12} /> Refresh</button>
      </div>
      {repos.map(repo => (
        <RepoCard key={repo.name} repo={repo} onRefresh={load} />
      ))}
    </div>
  );
}
