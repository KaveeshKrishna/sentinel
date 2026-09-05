# Sentinel

> Self-hosted, AI-assisted infrastructure engineering platform —
> password-protected, real-time, installable on your own server.

Sentinel monitors your VPS and runs a full
**OBSERVE → DIAGNOSE → PLAN → ACT → VERIFY** loop: it detects incidents,
gathers evidence, asks an AI provider of your choice for a root cause and
a remediation, executes the fix only with your explicit approval, and
then verifies the problem is actually resolved — not just that the action
ran. The AI never gets shell access; it can only request named,
schema-validated tools from a fixed registry, gated by a risk
classification.

## Features

- **Incidents** — a 9-state incident engine with a rule-based detector
  (container exit/OOM/unhealthy, service inactive, sustained
  CPU/RAM/disk). Each incident gathers bounded evidence, gets an AI
  diagnosis (root cause + confidence + recommended tool calls), and
  waits for per-action human approval before anything executes.
  Verification is a separate claim from execution — a fix that runs but
  doesn't converge ends `FAILED`, not `RESOLVED`.
- **Settings → AI provider** — bring your own key. Three adapters
  (`anthropic`, `gemini`, `openai-compatible` — the last also covers
  OpenAI, OpenRouter, Groq, local models). Key is AES-256-GCM encrypted
  at rest and never returned to the browser; a one-token test-connection
  round trip validates it.
- **System Overview** — CPU, RAM, temperature, disk, network with 60-second sparklines
- **Hardware** — detailed CPU/memory/disk info with usage bars
- **Docker** — live container table with logs, start/stop/restart from the UI
- **Websites** — discovered from Caddyfile (brace-depth parser, handles nested `log {}` blocks) with response-time pinging
- **Network** — live bandwidth, Caddy JSON log analytics (req/min, 4xx/5xx, avg latency)
- **Storage** — disk usage + additional-disk I/O; SMART data once detected
- **Services** — Docker, Caddy, Cloudflared, SSH, UFW — status + systemctl control
- **Deployments** — git repos in `/srv/apps` with Pull & Deploy (dirty-check protected)
- **Activity Timeline** — persisted event log (crashes, deploys, restarts)
- **Recording Mode** — manual VPS health sessions stored in SQLite with analytics + CSV/JSON export
- **Installer + CLI** — `install.sh` sets up two systemd services on a
  fresh VPS; `sentinel status|doctor|logs|restart|uninstall` manages them afterward

---

## Quick Start

Sentinel installs as two systemd services on your own Ubuntu/Debian
VPS: an unprivileged `sentinel-server` (UI, API) talking to a
privileged `sentinel-agent` (the only process with host/systemctl/Docker
access) over a local Unix socket. See `ARCHITECTURE.md` for the full
architecture.

### Install

```bash
git clone <this-repo-url> sentinel && cd sentinel
sudo bash install.sh
```

*(There's no published release yet, so this is a local-checkout install
rather than a one-line `curl | bash` — `install.sh` documents why, and
what it takes once a release exists.)*

The installer is idempotent — re-run it any time to pick up new code
without touching your existing configuration or database. When it
finishes, it prints the web UI's address and how to find the one-time
setup token:

```bash
sentinel logs server | grep -A2 'Setup token'
```

Visit `http://<your-server>:3000/setup`, paste that token, and choose an
admin username/password — that's the whole setup flow, no config files
to hand-edit.

### Manage a running install

```bash
sentinel status      # are both services up?
sentinel doctor       # full health check — OS, Node, units, socket, DB, disk, capabilities
sentinel logs [agent|server] [--follow]
sentinel restart
sentinel uninstall [--purge]   # --purge also removes config + database
```

### For development

To run both processes by hand without the installer (e.g. to iterate on
source), see `ARCHITECTURE.md`'s development notes — in short, start `agent/`
and `server/` directly with `node`, pointing both at the same
`SENTINEL_AGENT_SOCKET`/`SENTINEL_AGENT_TOKEN` values. Some agent tools
(systemctl, Docker) will report "unknown" or fail gracefully if you're
not running as root / don't have Docker installed — expected outside a
real install.

---

## Architecture

Sentinel is split into two processes across a privilege boundary — see
`ARCHITECTURE.md` for the full rationale and diagram.

```
Browser → server/ (unprivileged: UI, API, WebSocket, auth, SQLite)
              │  Unix socket + bearer token
              ▼
          agent/ (privileged: the only process with host access)
              │  fixed, schema-validated tool registry — no shell access
              ▼
   /proc · /sys · systemctl · Docker socket · git · Caddy config/logs
```

AI orchestration, the incident engine, the bounded context/evidence
gatherer, and the post-action verification poller all live in `server/`
— they need no host privilege of their own, only READ_ONLY tool calls to
`agent/` plus one `verify` endpoint.

`server/` never touches `/proc`, systemctl, or the Docker socket
directly — every host-facing operation is a named tool call to `agent/`,
which independently validates the request's schema and risk level before
executing it. An AI-recommended action's claimed risk is display-only:
the orchestrator cross-checks every recommended tool name against the
agent's live catalog and uses the tool's *real* registered risk, and
every recommendation requires an explicit human approval regardless.

---

## Security

- All routes behind JWT (HTTP-only cookie, 12h expiry, HS256-pinned),
  with server-side session revocation — logout actually invalidates the
  token immediately rather than only clearing the browser's copy
- Passwords stored as bcrypt hashes (cost=12); login is rate-limited
  (5 attempts/15min per IP) with a global bcrypt-concurrency cap and a
  fixed-cost dummy comparison on unknown usernames so response time
  doesn't leak which usernames exist
- Session cookie's `secure` flag reflects the actual request protocol
  (including behind a reverse proxy via `X-Forwarded-Proto`)
- WebSocket validated at the upgrade handshake, with a cross-site
  `Origin` check (403 before the cookie is looked at) and a 30s
  ping/pong heartbeat that reaps dead connections
- Helmet.js headers on all responses; a catch-all error handler returns
  a generic `{error}` and never a raw message or stack trace
- The agent (see Architecture) independently validates every tool call's
  schema and risk level — `server/` cannot execute a privileged operation
  the agent itself wouldn't also approve
- AI provider keys are AES-256-GCM encrypted at rest and never sent to
  the frontend; a redaction pass scrubs key/token-shaped strings from
  anything persisted or sent to a provider
- No admin credentials in environment variables or config files — the
  first-run `/setup` wizard is gated by a one-time token printed to the
  server's own console, and the admin account lives in SQLite (bcrypt-hashed)
- `sentinel-server.service` runs under systemd sandboxing
  (`NoNewPrivileges`, `ProtectHome`, `ProtectKernelModules`, explicit
  `ReadWritePaths`, etc.) as an additional layer beneath the agent
  boundary — see `packaging/systemd/`

---

## Environment Variables

`install.sh` generates and writes these for you at `/etc/sentinel/agent.env`
and `/etc/sentinel/server.env` (0640, root:sentinel) — you don't need to
hand-edit them for a normal install. For manual/development setups, see
`server/.env.example` and `agent/.env.example` for the full variable
list; set `JWT_SECRET` yourself (e.g. `openssl rand -hex 32`), then
create the admin account through the one-time `/setup` wizard the server
prints on first boot.

---

## Performance Targets

| Metric       | Target |
|---|---|
| RAM usage    | < 120 MB |
| CPU idle     | < 2% |
| Startup time | < 2 seconds |

---

## Project Structure

```
sentinel/
├── server/                    # unprivileged control plane
│   └── src/
│       ├── server.js          # Express + WebSocket bootstrap
│       ├── app.js             # Express app factory (testable without a bound port)
│       ├── auth/               # JWT + bcrypt auth, users, sessions, rate limit
│       ├── setup/              # first-run web wizard (one-time setup token)
│       ├── db/                 # shared connection + numbered-migration runner
│       ├── agent/              # client for talking to agent/ over its socket
│       ├── routes/             # REST API routes (thin proxies to agent tools)
│       ├── websocket/          # 1-second broadcast loop (polls agent/)
│       ├── incidents/          # state machine, store, detector, engine
│       ├── context/            # bounded evidence gathering (READ_ONLY tools)
│       ├── ai/                 # provider-agnostic diagnosis: schema, redact, 3 adapters, orchestrator
│       ├── verify/             # post-action convergence polling
│       ├── graph/              # minimal resource/dependency graph
│       ├── crypto/             # AES-256-GCM key encryption at rest
│       ├── settings/           # runtime AI-provider config
│       ├── recording/          # SQLite engine + schema
│       └── activity/           # persisted event log + Docker-event poller
├── agent/                     # privileged host agent (root in production)
│   └── src/
│       ├── index.js           # Unix-socket HTTP server + bootstrap
│       ├── registry.js        # tool registration + JSON Schema validation
│       ├── policy.js          # risk levels + approval policy
│       ├── auth.js            # bearer-token auth for the socket
│       ├── collectors/        # /proc, /sys readers (cpu, mem, disk, net, temp)
│       └── tools/             # the entire executable surface: system, docker,
│                               # services, storage, process, network, git
├── frontend/                  # React 18 + Vite, react-router-dom, built into server/public
│   └── src/
│       ├── pages/             # Login, Dashboard (nested <Routes>, one path per section)
│       ├── components/sections/  # Overview, Docker, Incidents, IncidentDetail, Settings, …
│       ├── api/client.js      # thin fetch wrapper (JSON, error surfacing, 401 → /login)
│       └── hooks/             # WebSocket + Auth context
├── cli/                        # the `sentinel` management CLI
│   ├── sentinel.js             # status/start/stop/restart/logs/doctor/config/uninstall
│   └── lib/                    # systemd wrapper, doctor checks, install paths
├── packaging/systemd/          # sentinel-agent.service, sentinel-server.service
├── install.sh                  # the installer (see Quick Start above)
├── examples/Caddyfile.example
├── sentinel-demo/              # the public, fully-fabricated demo build
└── .env.example
```

---

## License

Sentinel is **source-available for noncommercial use** under the
[PolyForm Noncommercial License 1.0.0](./LICENSE). You may run, study,
modify and share it for personal projects, research, education, and other
noncommercial purposes. Commercial use requires a separate license from
the author — contact details are on the About page and in
`frontend/src/components/sections/About.jsx`.
