# Sentinel

Self-hosted AI infrastructure engineer for your own server. It watches your VPS around the clock, and when something breaks, it actually tries to fix it, but only after you say yes.

## A note on this repo's history

I rewrote the git history once, right before making this public. The early commits had a local `.env` file, my real server's address, and some other private stuff in them that should never have been pushed in the first place. All of that got cleaned out. The commit dates and messages are still the real ones, I only swapped out the private bits for placeholders.

## How it works

Sentinel runs a loop: **OBSERVE → DIAGNOSE → PLAN → ACT → VERIFY**. It watches your server, and when something goes wrong it figures out what happened, gathers logs and evidence, asks an AI what it thinks the cause and fix are, and then waits for you to approve before doing anything. Once you approve, it runs the fix and checks again afterward to make sure the problem is actually gone, not just that a command ran.

The AI side of this never gets a real shell or terminal. It can only call from a fixed list of tools that I wrote myself, and every one of those tools has a risk level attached to it.

## Features

- **Incidents.** When a container crashes, a service stops, or CPU/RAM/disk goes out of control, Sentinel opens an incident automatically. It gathers evidence, gets an AI diagnosis, and waits for you to approve a fix. If a fix runs but the problem's still there, it shows `FAILED`, not `RESOLVED`. No pretending something's fixed when it isn't.
- **AI provider settings.** Bring your own API key. Works with Anthropic, Gemini, or anything OpenAI-compatible, which covers OpenAI itself, OpenRouter, Groq, and local models too. Your key is encrypted before it's stored anywhere.
- **Overview dashboard.** CPU, RAM, temperature, disk, network, all updating live with small graphs.
- **Docker.** See your containers, read their logs, start/stop/restart them right from the browser.
- **Websites.** Sentinel reads your Caddyfile, figures out what sites you're running, and pings them to track response times.
- **Network.** Bandwidth graphs plus stats pulled straight from Caddy's access logs.
- **Storage.** Disk usage and I/O, plus SMART data if a disk reports it.
- **Services.** Status and control for Docker, Caddy, Cloudflared, SSH, and UFW.
- **Deployments.** Pull and deploy your git repos with a live build log, roll back if something breaks.
- **Activity log.** A running history of crashes, deploys, and restarts.
- **Recording mode.** Record a health session of your VPS and export it as CSV or JSON later.
- **Installer and CLI.** One script sets up two systemd services on a clean VPS. After that you get a `sentinel` command for status, logs, restart, doctor, and uninstall.

---

## Getting it running

Sentinel runs as two systemd services. `sentinel-server` has no special permissions, it's just the web app, the API, and the database. `sentinel-agent` runs as root, and it's the only thing that actually touches your machine. They talk to each other over a local socket. The full reasoning behind splitting it this way is in `ARCHITECTURE.md`.

### Install

```bash
git clone <this-repo-url> sentinel && cd sentinel
sudo bash install.sh
```

*(There's no packaged release yet, so this is a checkout install rather than a one-line `curl | bash`. `install.sh` explains more if you're curious why.)*

You can re-run `install.sh` any time, it's safe, it just updates the code and leaves your data alone. When it finishes it prints a one-time setup token:

```bash
sentinel logs server | grep -A2 'Setup token'
```

Go to `http://<your-server>:3000/setup`, paste in the token, pick a username and password, and you're done. Nothing to hand-edit.

### Managing a running install

```bash
sentinel status      # are both services up?
sentinel doctor       # a full health check: OS, Node, units, socket, DB, disk
sentinel logs [agent|server] [--follow]
sentinel restart
sentinel uninstall [--purge]   # --purge also wipes config + database
```

### If you want to hack on the code

To run both processes by hand instead of using the installer, see the dev notes in `ARCHITECTURE.md`. Short version: start `agent/` and `server/` directly with `node`, both pointing at the same `SENTINEL_AGENT_SOCKET`/`SENTINEL_AGENT_TOKEN`. If you're not running as root or don't have Docker, some agent tools will just report "unknown" instead of crashing, that's expected outside a real install.

---

## Architecture, the short version

```
Browser → server/ (no host access: UI, API, WebSocket, auth, database)
              │  Unix socket + bearer token
              ▼
          agent/ (root, but only exposes a fixed list of named tools, no shell)
              │
   /proc · /sys · systemctl · Docker socket · git · Caddy config/logs
```

The AI, the incident engine, and everything else in `server/` never touch the host directly. Every host operation is a named call to `agent/`, which checks the request against its own tool list and risk levels again, independently, before it does anything. It doesn't just trust what `server/` tells it. Full writeup with reasoning is in `ARCHITECTURE.md`.

---

## Security, quick version

- Sessions use a JWT in an HTTP-only cookie, tracked server-side, so logging out actually revokes access right away instead of just clearing a cookie
- Passwords are bcrypt hashed, login attempts are rate limited, and a global cap on concurrent bcrypt checks stops one attacker from starving everyone else
- The WebSocket connection checks its origin at the handshake and drops dead connections with a heartbeat
- Standard security headers everywhere; errors never leak a stack trace or raw message back to the browser
- The agent independently re-checks every tool call's risk level itself, it never just trusts that the server already approved it
- AI provider keys are encrypted at rest and never sent to the browser; anything that looks like a key or a token gets scrubbed before it's stored or sent to an AI provider
- No admin password ever lives in a config file, the first run gives you a one-time token instead
- The server process runs sandboxed under systemd for an extra layer of safety underneath the agent boundary

---

## Environment variables

`install.sh` writes these out for you at `/etc/sentinel/agent.env` and `/etc/sentinel/server.env`, you don't need to touch them for a normal install. If you're setting things up by hand for development, `server/.env.example` and `agent/.env.example` list everything, just make sure to set your own `JWT_SECRET` (`openssl rand -hex 32` works fine) and create the admin account through the setup page on first boot.

---

## Performance

| Metric | Target |
|---|---|
| RAM usage | under 120 MB |
| CPU idle | under 2% |
| Startup time | under 2 seconds |

---

## How the code is laid out

```
sentinel/
├── server/                    # the unprivileged control plane
│   └── src/
│       ├── server.js          # starts Express + the WebSocket
│       ├── app.js             # the Express app itself, kept separate so it's testable
│       ├── auth/               # JWT + bcrypt login, sessions, rate limiting
│       ├── setup/              # the first-run setup wizard
│       ├── db/                 # the shared DB connection + migration runner
│       ├── agent/              # the client that talks to agent/ over its socket
│       ├── routes/             # the REST API, mostly thin wrappers around agent tools
│       ├── websocket/          # the once-a-second live broadcast loop
│       ├── incidents/          # the incident state machine, detector, and engine
│       ├── context/            # gathers evidence for a diagnosis, read-only only
│       ├── ai/                 # the AI layer: providers, schema checking, redaction
│       ├── verify/             # checks whether a fix actually worked
│       ├── graph/              # a simple resource/dependency graph
│       ├── crypto/             # AES-256-GCM encryption for stored keys
│       ├── settings/           # runtime config for the AI provider
│       ├── recording/          # the recording-mode engine
│       └── activity/           # the persisted event log
├── agent/                     # the privileged host agent, runs as root in production
│   └── src/
│       ├── index.js           # the Unix-socket server itself
│       ├── registry.js        # where every tool is registered + validated
│       ├── policy.js          # risk levels and what needs approval
│       ├── auth.js            # the bearer-token check on the socket
│       ├── collectors/        # readers for /proc and /sys
│       └── tools/             # everything the agent can actually do
├── frontend/                  # React 18 + Vite, built and served by server/
│   └── src/
│       ├── pages/             # Login and the main Dashboard
│       ├── components/sections/  # Overview, Docker, Incidents, Settings, etc.
│       ├── api/client.js      # a small fetch wrapper
│       └── hooks/             # the WebSocket connection + auth context
├── cli/                        # the `sentinel` command
│   ├── sentinel.js
│   └── lib/
├── packaging/systemd/          # the two systemd unit files
├── install.sh                  # the installer
├── examples/Caddyfile.example
├── sentinel-demo/              # the public, fully fabricated demo build
└── .env.example
```

---

## License

Sentinel is source-available for noncommercial use under the [PolyForm Noncommercial License 1.0.0](./LICENSE). You can run it, study it, change it, and share it for personal projects, school, research, or anything else that isn't commercial. If you want to use it commercially, reach out first, contact details are on the About page in the app.
