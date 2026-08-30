import Icon from '../shared/Icon';

/**
 * Static "About" page — the project's purpose, how it works, and who
 * built it. No data fetch; renders identically in the real app and the
 * demo.
 */

function Step({ n, title, children }) {
  return (
    <div className="about-step">
      <div className="about-step-n">{n}</div>
      <div>
        <div className="about-step-title">{title}</div>
        <div className="about-step-body">{children}</div>
      </div>
    </div>
  );
}

export default function About() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 860 }}>

      <div className="card">
        <div className="card-title"><Icon name="shield" /> What Sentinel is</div>
        <p className="settings-help" style={{ marginBottom: 10 }}>
          Sentinel is a self-hosted, AI-assisted infrastructure engineer for a single server.
          It watches the host, and when something breaks it gathers the relevant evidence,
          asks a language model for a root cause and a fix, and — only with your approval —
          carries that fix out and verifies it actually worked.
        </p>
        <p className="settings-help" style={{ marginBottom: 0 }}>
          The whole product is one loop:
        </p>
        <div className="about-loop">
          {['OBSERVE', 'DIAGNOSE', 'PLAN', 'ACT', 'VERIFY'].map((s, i) => (
            <span key={s} className="about-loop-stage">
              {s}{i < 4 && <span className="about-loop-arrow">→</span>}
            </span>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card-title"><Icon name="alert-triangle" /> Why it was built</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Step n="1" title="Incident triage is manual and stressful">
            When a service goes down you SSH in, pull logs from three places, read metrics,
            guess a cause, run a command, and hope. At 3 a.m. that is slow and error-prone,
            and it leans entirely on one person's experience.
          </Step>
          <Step n="2" title="AI dev tools stop at the IDE">
            Assistants help you write code. Almost nothing helps you safely operate the code
            once it is running on a real server.
          </Step>
          <Step n="3" title="An AI on a server needs a hard boundary">
            Handing a model a shell is unacceptable. Sentinel's non-negotiable principle is
            that <strong>the AI never gets shell access</strong> — it can only request named,
            schema-validated tools from a fixed registry, each gated by a risk level and an
            approval policy. Dangerous operations aren't merely denied, they're
            unrequestable.
          </Step>
        </div>
      </div>

      <div className="card">
        <div className="card-title"><Icon name="layers" /> How it works</div>
        <div className="info-row"><span className="info-key">Two processes</span><span className="info-val">An unprivileged control plane (UI, API, incidents, AI orchestration, SQLite) talks over a local socket to a small privileged agent that owns the tool registry — the only component with host access.</span></div>
        <div className="info-row"><span className="info-key">Incident engine</span><span className="info-val">A 9-state machine detects anomalies, gathers bounded evidence through read-only tools, and drives the reasoning loop. Dedup is a database constraint, not just a check.</span></div>
        <div className="info-row"><span className="info-key">Bring your own key</span><span className="info-val">Anthropic, Gemini or any OpenAI-compatible provider. Keys are AES-256-GCM encrypted at rest and tried as an ordered failover pool.</span></div>
        <div className="info-row"><span className="info-key">Human in the loop</span><span className="info-val">Every AI-recommended action needs an explicit approval by default; the tool's real registered risk — never the model's own claim — is what the gate checks. Auto-remediation is opt-in per resource and narrower still.</span></div>
        <div className="info-row"><span className="info-key">Verify ≠ execute</span><span className="info-val">"The action ran" and "the problem is fixed" are kept as separate outcomes — a tool that runs but never converges ends at FAILED, not RESOLVED.</span></div>
      </div>

      <div className="card">
        <div className="card-title"><Icon name="cpu" /> Tech stack</div>
        <div className="info-row"><span className="info-key">Frontend</span><span className="info-val">React 18 + Vite, react-router-dom, a 1 Hz WebSocket for live telemetry</span></div>
        <div className="info-row"><span className="info-key">Backend</span><span className="info-val">Node.js + Express + ws; provider-agnostic AI layer over native fetch (no SDK)</span></div>
        <div className="info-row"><span className="info-key">Storage</span><span className="info-val">SQLite (better-sqlite3) with a real migration runner</span></div>
        <div className="info-row"><span className="info-key">Runs as</span><span className="info-val">Native systemd units — Docker is a monitored capability, not a requirement</span></div>
      </div>

      <div className="card" style={{ borderColor: 'var(--accent)' }}>
        <div className="card-title"><Icon name="key" /> Developer</div>
        <div style={{ fontSize: '1.05rem', fontWeight: 700, marginBottom: 4 }}>Kaveesh Krishna Pandey</div>
        <p className="settings-help" style={{ marginBottom: 10 }}>
          Sentinel is built and maintained by Kaveesh Krishna Pandey — designed, developed and
          run in production on a personal VPS, and submitted here as a hackathon project.
        </p>
        <div className="info-row">
          <span className="info-key">GitHub</span>
          <span className="info-val"><a href="https://github.com/KaveeshKrishna" target="_blank" rel="noreferrer noopener">github.com/KaveeshKrishna</a></span>
        </div>
        <div className="info-row">
          <span className="info-key">Website</span>
          <span className="info-val"><a href="https://kaveeshkrishna.in" target="_blank" rel="noreferrer noopener">kaveeshkrishna.in</a> — about me and my other projects</span>
        </div>
        <div className="info-row">
          <span className="info-key">Contact</span>
          <span className="info-val"><a href="mailto:kaveeshkrishnabusiness@gmail.com">kaveeshkrishnabusiness@gmail.com</a></span>
        </div>
      </div>

    </div>
  );
}
