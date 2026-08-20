# Sentinel

> Personal VPS Operations Dashboard — Self-hosted, password-protected, real-time.

## Features

- **System Overview** — CPU, RAM, temperature, disk, network with 60-second sparklines
- **Hardware** — detailed CPU/memory/disk info with usage bars
- **Docker** — live container table with logs, start/stop/restart from the UI
- **Websites** — auto-discovered from Caddyfile with response-time pinging
- **Network** — live bandwidth, Caddy JSON log analytics (req/min, 4xx/5xx, avg latency)
- **Storage** — disk usage with future SSD placeholder
- **Services** — Docker, Caddy, Cloudflared, SSH, UFW — status + systemctl control
- **Deployments** — git repos in `/srv/apps` with Pull & Deploy (dirty-check protected)
- **Activity Timeline** — 500-event ring buffer (crashes, deploys, restarts)
- **Recording Mode** — manual VPS health sessions stored in SQLite with analytics + CSV/JSON export

---

## Quick Start

### 1. Create the log directory (first time)

```bash
sudo mkdir -p /var/log/caddy
sudo chown caddy:caddy /var/log/caddy
sudo systemctl reload caddy
```

### 2. Run setup wizard (generates bcrypt hash + JWT secret)

```bash
cd /srv/apps/sentinel-kkp-node/backend
npm install
node scripts/setup.js
```

This creates `backend/.env` with hashed credentials. **Never commit this file.**

### 3. Build and start

```bash
cd /srv/apps/sentinel-kkp-node
docker compose up -d --build
```

### 4. Access

Visit: `http://sentinel.your-domain.example` (via Cloudflare Tunnel)
Or locally: `http://localhost:8888`

---

## Architecture

```
Host OS
├── /proc      → bind-mounted read-only → CPU, memory, network stats
├── /sys       → bind-mounted read-only → CPU temperature
├── /          → bind-mounted read-only → accurate disk usage (df)
├── /dev/disk  → bind-mounted read-only → future SMART data
├── /var/log/caddy → bind-mounted r/o  → Caddy JSON access logs
├── /etc/caddy → bind-mounted r/o      → Caddyfile website discovery
├── /srv/apps  → bind-mounted r/w      → Git repos for deployments
└── /var/run/docker.sock → Docker API

Container: node:20-alpine
├── src/server.js      → Express + WebSocket
├── src/collectors/    → Direct /proc reads (no systeminformation dep)
├── src/routes/        → REST API
├── src/recording/     → SQLite + 60s sampling engine
└── public/            → Vite-built React frontend (served by Express)
```

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

See `.env.example` for all required variables.
Run `node scripts/setup.js` to generate them interactively.

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
sentinel-kkp-node/
├── backend/
│   ├── src/
│   │   ├── server.js          # Express + WebSocket bootstrap
│   │   ├── auth/              # JWT + bcrypt auth
│   │   ├── collectors/        # /proc readers (cpu, mem, disk, net, temp)
│   │   ├── routes/            # REST API routes
│   │   ├── websocket/         # 1-second broadcast loop
│   │   ├── recording/         # SQLite engine + schema
│   │   └── activity/          # Event ring buffer + Docker watcher
│   └── scripts/setup.js       # Interactive credential setup
├── frontend/
│   └── src/
│       ├── pages/             # Login, Dashboard
│       ├── components/        # Shared + per-section components
│       └── hooks/             # WebSocket + Auth context
├── compose.yml
├── Dockerfile
└── .env.example
```
