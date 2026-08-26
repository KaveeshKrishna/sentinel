# Sentinel

> Personal VPS Operations Dashboard — Self-hosted, password-protected, real-time.

## Features

- **System Overview** — CPU, RAM, temperature, disk, network with 60-second sparklines
- **Hardware** — detailed CPU/memory/disk info with usage bars
- **Docker** — live container table with logs, start/stop/restart from the UI
- **Websites** — auto-discovered from Caddyfile with response-time pinging
- **Network** — live bandwidth, Caddy JSON log analytics (req/min, 4xx/5xx, avg latency)
- **Storage** — disk usage, with support for additional-disk SMART data once detected
- **Services** — Docker, Caddy, Cloudflared, SSH, UFW — status + systemctl control
- **Deployments** — git repos in `/srv/apps` with Pull & Deploy (dirty-check protected)
- **Activity Timeline** — 500-event ring buffer (crashes, deploys, restarts)
- **Recording Mode** — manual VPS health sessions stored in SQLite with analytics + CSV/JSON export

---

## Quick Start

> **Sentinel is mid-migration** to a two-process architecture — an
> unprivileged `server/` (UI, API, AI orchestration) talking to a
> privileged `agent/` (the only process with host/systemctl/Docker access)
> over a local Unix socket. See `ARCHITECTURE.md` for the full architecture and
> status. **The old single-container `docker compose up` path (below) no
> longer works on its own** — `server/` now requires a running `agent/`
> and there is no compose service for it yet. A one-line installer for
> the native systemd deployment is coming in the next phase.
>
> Until then, to run Sentinel locally for development, start both
> processes by hand from the repo root (each needs `npm install` in its
> own directory first):
>
> ```bash
> # terminal 1 — the privileged agent
> cd agent && npm install
> SENTINEL_AGENT_SOCKET=/tmp/sentinel-agent.sock \
> SENTINEL_AGENT_TOKEN=dev-only-token \
> node src/index.js
>
> # terminal 2 — the control plane
> cd server && npm install
> node scripts/setup.js   # generates server/.env with admin credentials
> SENTINEL_AGENT_SOCKET=/tmp/sentinel-agent.sock \
> SENTINEL_AGENT_TOKEN=dev-only-token \
> node src/server.js
> ```
>
> Then visit `http://localhost:3000` (or wherever `PORT` in `server/.env`
> points). Some tools (systemctl, Docker) will report "unknown" or fail
> gracefully if you're not running as root / don't have Docker installed
> — that's expected outside a real install.

### Legacy Docker Compose path (currently non-functional, kept for reference)

```bash
sudo mkdir -p /var/log/caddy
sudo chown caddy:caddy /var/log/caddy
sudo systemctl reload caddy

cd server && npm install && node scripts/setup.js   # generates server/.env
docker compose up -d --build                        # from the repo root
```

Visit `http://localhost:8888`, or your own domain if you've put Sentinel
behind a reverse proxy (see `examples/Caddyfile.example`).

---

## Architecture

Sentinel is split into two processes across a privilege boundary — see
`ARCHITECTURE.md` for the full rationale and diagram.

```
Browser → server/ (unprivileged: UI, API, WebSocket, auth, AI, SQLite)
              │  Unix socket + bearer token
              ▼
          agent/ (privileged: the only process with host access)
              │  fixed, schema-validated tool registry — no shell access
              ▼
   /proc · /sys · systemctl · Docker socket · git · Caddy config/logs
```

`server/` never touches `/proc`, systemctl, or the Docker socket
directly — every host-facing operation is a named tool call to `agent/`,
which independently validates the request's schema and risk level before
executing it.

---

## Security

- All routes behind JWT (HTTP-only cookie, 12h expiry)
- Passwords stored as bcrypt hashes (cost=12)
- WebSocket validated at upgrade handshake
- Constant-time username comparison (timing-attack resistant)
- Helmet.js headers on all responses
- Strict service/action allowlists for systemctl commands

---

## Environment Variables

Configuration is per-package: see `server/.env.example` and
`agent/.env.example`. Run `cd server && node scripts/setup.js` to
generate `server/.env` (admin credentials, JWT secret) interactively.

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
│   ├── src/
│   │   ├── server.js          # Express + WebSocket bootstrap
│   │   ├── auth/              # JWT + bcrypt auth
│   │   ├── agent/             # client for talking to agent/ over its socket
│   │   ├── routes/            # REST API routes (thin proxies to agent tools)
│   │   ├── websocket/         # 1-second broadcast loop (polls agent/)
│   │   ├── recording/         # SQLite engine + schema
│   │   └── activity/          # Event log + Docker-event poller
│   └── scripts/setup.js       # Interactive credential setup
├── agent/                     # privileged host agent (root in production)
│   └── src/
│       ├── index.js           # Unix-socket HTTP server + bootstrap
│       ├── registry.js        # tool registration + JSON Schema validation
│       ├── policy.js          # risk levels + approval policy
│       ├── auth.js            # bearer-token auth for the socket
│       ├── collectors/        # /proc, /sys readers (cpu, mem, disk, net, temp)
│       └── tools/             # the entire executable surface: system, docker,
│                               # services, storage, process, network, git
├── frontend/
│   └── src/
│       ├── pages/             # Login, Dashboard
│       ├── components/        # Shared + per-section components
│       └── hooks/             # WebSocket + Auth context
├── cli/                       # planned: the `sentinel` management CLI
├── packaging/                 # planned: systemd units + install.sh
├── examples/Caddyfile.example
├── compose.yml                # legacy — see Quick Start note above
├── Dockerfile                 # legacy — see Quick Start note above
└── .env.example
```
