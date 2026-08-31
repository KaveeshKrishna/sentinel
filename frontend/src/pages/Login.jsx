import { useState, lazy, Suspense } from 'react';
import { useAuth, apiLogin } from '../hooks/useAuth';
import sentinelLogoText from '../assets/logo/sentinel-logo-text-light.svg';

const DEMO = !!import.meta.env.VITE_DEMO;
const DemoBadge = DEMO
  ? lazy(() => import('../demo/DemoNotice.jsx').then(m => ({ default: m.DemoBadge })))
  : null;

export default function Login() {
  const { setAuth } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError]     = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!username || !password) return;
    setLoading(true);
    setError('');
    try {
      const data = await apiLogin(username, password);
      setAuth({ username: data.username });
    } catch (err) {
      setError(err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-header">
          <div className="login-logo">
            <img src={sentinelLogoText} alt="Sentinel" className="login-logo-img" />
          </div>
          <div className="login-subtitle">Your AI Infrastructure Engineer</div>
          {DemoBadge && <Suspense fallback={null}><DemoBadge /></Suspense>}
        </div>

        {error && <div className="error-msg">{error}</div>}

        <form onSubmit={handleSubmit} autoComplete="on">
          <div className="form-group">
            <label className="form-label" htmlFor="username">Username</label>
            <input
              id="username"
              className="form-input"
              type="text"
              autoComplete="username"
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="admin"
              disabled={loading}
            />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="password">Password</label>
            <input
              id="password"
              className="form-input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              disabled={loading}
            />
          </div>
          <button
            id="login-submit"
            type="submit"
            className="btn btn-primary btn-full"
            disabled={loading || !username || !password}
            style={{ marginTop: 8 }}
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>

          {DEMO && (
            <>
              <button
                type="button"
                className="btn btn-secondary btn-full"
                style={{ marginTop: 8 }}
                disabled={loading}
                onClick={() => { setUsername('demo'); setPassword('demo'); }}
              >
                Fill demo credentials
              </button>
              <div style={{ marginTop: 8, textAlign: 'center', fontSize: '0.72rem', color: 'var(--text-dim)' }}>
                Demo login — user <code>demo</code>, password <code>demo</code>
              </div>
            </>
          )}
        </form>

        <div style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--border)', textAlign: 'center' }}>
          <span style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>
            Sessions expire after 12 hours of inactivity
          </span>
        </div>
      </div>
    </div>
  );
}
