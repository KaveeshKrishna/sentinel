# Sentinel

Self-hosted AI infrastructure engineer for your own server. It keeps an eye on your VPS, and when something breaks it actually tries to fix it, but only after you say ok.

## About this repo's history

I rewrote the git history once, right before making this public. The early commits had a local `.env` file in them, my real server address, and a few other private things that honestly should never have been committed in the first place. So I cleaned all that out. The dates and commit messages are still real, I just replaced the private stuff with placeholders.

## How it works

When something on your server goes wrong, Sentinel deals with it kind of the way a person would. It notices the problem, goes digging through the logs and the metrics to figure out what actually happened, comes up with a fix, and then waits for you to approve it. Once you approve, it runs the fix, and then it checks again afterwards to make sure the problem is actually gone. Not just that some command ran without an error, but that the thing is genuinely working again.

The AI part never gets a shell or a terminal or anything like that. It can only pick from a fixed list of tools that I wrote, and each tool has a risk level on it. The dangerous stuff just isn't on the list at all, so it can't even ask for it.

## Features

- **Incidents.** When a container crashes, a service stops, or CPU/RAM/disk goes crazy, Sentinel opens an incident on its own. It collects evidence, gets an AI to diagnose it, and waits for you to approve a fix. If the fix runs but the problem is still there, it says `FAILED`, not `RESOLVED`. It won't pretend something's fixed when it isn't.
- **AI provider settings.** Bring your own API key. Works with Anthropic, Gemini, or anything OpenAI-compatible (so also OpenAI, OpenRouter, Groq, local models, whatever). The key gets encrypted before it's stored anywhere.
- **Overview dashboard.** CPU, RAM, temperature, disk, network, all updating live with little graphs.
- **Docker.** See your containers, read their logs, start/stop/restart them from the browser.
- **Websites.** Sentinel reads your Caddyfile, works out what sites you're running, and pings them to check response times.
- **Network.** Bandwidth graphs plus stats from Caddy's access logs.
- **Storage.** Disk usage and I/O, and SMART data if the disk gives it.
- **Services.** Status and control for Docker, Caddy, Cloudflared, SSH and UFW.
- **Deployments.** Pull and deploy your git repos with a live build log, and roll back if it breaks.
- **Activity log.** A running list of crashes, deploys and restarts.
- **Recording mode.** Record a health session of your VPS and export it as CSV or JSON later on.
- **Installer and CLI.** One script sets up the two services. After that theres a `sentinel` command for status, logs, restart, doctor and uninstall.

## Getting it running

Sentinel runs as two systemd services. `sentinel-server` has no special permissions, its just the web app, the API and the database. `sentinel-agent` runs as root and it's the only thing that actually touches your machine. They talk over a local socket. Why it's split like that is explained in ARCHITECTURE.md.

### Install

```bash
git clone <this-repo-url> sentinel && cd sentinel
sudo bash install.sh
```

There's no packaged release yet so for now you just install from a checkout instead of a one-line `curl | bash`. `install.sh` has more on why if you care.

You can run `install.sh` again whenever, it's safe. It updates the code and leaves your data alone. When it's done it prints a one-time setup token:

```bash
sentinel logs server | grep -A2 'Setup token'
```

Then go to `http://<your-server>:3000/setup`, paste the token, pick a username and password, and that's it. No config files to edit.

### Managing it once it's running

```bash
sentinel status      # are both services up?
sentinel doctor       # full health check: OS, Node, units, socket, DB, disk
sentinel logs [agent|server] [--follow]
sentinel restart
sentinel uninstall [--purge]   # --purge also wipes config + database
```

### If you want to work on the code

To run both processes by hand instead of using the installer, check the dev notes in ARCHITECTURE.md. Basically you start `agent/` and `server/` directly with `node`, both pointing at the same `SENTINEL_AGENT_SOCKET` and `SENTINEL_AGENT_TOKEN`. If you're not root or don't have Docker, some agent tools will just say "unknown" instead of crashing, which is fine outside a real install.

## How it's put together

Sentinel is two separate programs. One is the web server. It runs the dashboard, the API, the database, and all the incident and AI logic, and it has no direct access to the machine it's on. The other is a small agent that runs as root. That one is the only thing that can actually touch the system, and it only does it through a fixed set of named tools, there's no way to make it run a random command.

They talk over a local socket with a shared token. When the server needs something done on the host, it asks the agent for it by name, and the agent checks that request against its own tool list and risk rules before doing anything. It doesn't just assume the server already checked. The whole reasoning is in ARCHITECTURE.md.

## Security, quick version

- Sessions use a JWT in an http-only cookie, and they're tracked server-side, so logging out actually kills access straight away instead of just clearing a cookie
- Passwords are bcrypt hashed, logins are rate limited, and there's a global cap on how many bcrypt checks run at once so one person can't starve everyone else
- The WebSocket checks its origin at the handshake and drops dead connections with a heartbeat
- Normal security headers everywhere, and errors never send a stack trace or a raw message back to the browser
- The agent re-checks every single tool call's risk level itself, it never just trusts that the server already approved it
- AI keys are encrypted at rest and never sent to the browser, and anything that looks like a key or token gets scrubbed out before it's stored or sent to a provider
- No admin password sits in a config file, the first run gives you a one-time token instead
- The server process runs sandboxed under systemd as an extra layer under the agent boundary

## Environment variables

`install.sh` writes these for you at `/etc/sentinel/agent.env` and `/etc/sentinel/server.env`, you don't need to touch them for a normal install. If you're setting it up by hand for dev, `server/.env.example` and `agent/.env.example` list everything. Just remember to set your own `JWT_SECRET` (`openssl rand -hex 32` works) and make the admin account through the setup page on first boot.

## Performance

It's pretty light. It uses under 120 MB of RAM, sits under 2% CPU when nothing's happening, and starts up in under 2 seconds.

## Where things are in the repo

- `server/` is the web server: the API, the dashboard backend, the incident engine, the AI code. No direct machine access.
- `agent/` is the root process: the tool list, the risk rules, and the readers that pull numbers out of `/proc` and `/sys`.
- `frontend/` is the React app. It gets built and served by `server/`.
- `cli/` is the `sentinel` command.
- `install.sh` sets it all up, and `packaging/systemd/` has the two service files.

## License

Sentinel is source-available for noncommercial use under the [PolyForm Noncommercial License 1.0.0](./LICENSE). You can run it, read it, change it, and share it for personal projects, school, research, or anything else that isn't commercial. If you want to use it commercially, get in touch first, contact info is on the About page in the app.
