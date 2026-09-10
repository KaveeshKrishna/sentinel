# Sentinel, architecture

Sentinel is a self-hosted AI infrastructure engineer for a single server.

When something breaks it works through it in stages. First it notices the problem, then it gathers the evidence that actually matters, then it works out a likely cause and a fix, then it runs that fix once you approve, and then it checks that the fix really worked instead of just assuming. That last part matters a lot to me, "the command ran" and "the problem is gone" are not the same thing.

The one rule I never break is that the AI never gets a shell. It can only call named tools from a fixed list, and each one has its own risk level and approval rule.

## The two processes

Sentinel is two programs with different levels of trust.

`sentinel-server` runs as a normal unprivileged user. It has the dashboard, the API, the WebSocket, auth, the incident engine, the AI layer, and the SQLite database. It never touches the host directly.

`sentinel-agent` runs as root. It's the only process that can read `/proc`, talk to the Docker socket, or call `systemctl`. But it only exposes a fixed list of named tools, there is no generic "run this command" endpoint. The server talks to it over a local Unix socket that's protected by a file permission and a shared token.

So the path for any request is: your browser talks to the server, the server asks the agent for a specific named tool, and the agent runs it against the real system after checking it itself.

A bit more on each piece:

- `server/` holds auth, the database, the WebSocket broadcaster, and every API route. Each route is a thin wrapper that calls a named tool on the agent instead of touching the host. It also has the incident engine, the AI layer, the evidence gatherer, the fix-verification code, a small resource graph, and settings (the AI key and webhook URLs are AES-256-GCM encrypted).
- `agent/` owns the collectors, the tool registry, the risk policy, and the token check on its own socket.
- `frontend/` is a React 18 + Vite app, built and served by `server/`. Client-side routing, one URL per section. A small fetch wrapper handles every request and sends you to `/login` on a 401.
- `cli/` is the `sentinel` command: status, start, stop, restart, logs, doctor, config, update, uninstall.
- `packaging/systemd/` has the two service files, and `install.sh` at the repo root ties it all together on a fresh machine.

## Where files go once it's installed

- `/usr/lib/sentinel/` has the code (`agent`, `server`, `frontend`, `cli`), owned by root.
- `/etc/sentinel/` has config and secrets, `root:sentinel` at `0750`. Inside are `agent.env` and `server.env`, plus `agent.token`, `secret.key` and `jwt.key`, all `0640`.
- `/var/lib/sentinel/sentinel.db` is the database (plus its `-wal` and `-shm` files), owned by the `sentinel` user.
- `/var/log/sentinel/` is the logs.
- `/run/sentinel/agent.sock` is the socket the two processes use, `0660 root:sentinel`, in a `0750` directory.
- `/usr/local/bin/sentinel` is a symlink to the CLI.

`cli/lib/paths.js` is the one place these are defined on the CLI side, and `install.sh` and the two systemd units all have to match it.

## How the two sides authenticate

The agent's socket is `0660 root:sentinel`. That file permission stands in for `SO_PEERCRED`, which Node can't check without a native addon. On top of that there's a shared token, which lives in `SENTINEL_AGENT_TOKEN` for dev or `/etc/sentinel/agent.token` in production. `server/src/agent/` is the client, and it goes through a generic transport interface so a networked version later wouldn't need a rewrite.

The wire protocol is small:

- `GET /health`, no auth, just liveness
- `GET /tools`, the full catalog: name, description, params, risk level
- `POST /tools/:name`, runs a tool. The server can send an `X-Sentinel-Approved: true` header saying it already checked approval, but the agent doesn't just trust that. It looks the tool's real risk level up itself and decides again.
- `POST /tools/:name/verify`, runs the tool's own "did this actually work" check, if it has one

## How login works

There's no admin password in an env var or a config file anywhere.

On first run, the server checks if the `users` table is empty, and if it is, it generates a one-time token, prints it to the console with a `/setup` link, and waits. The setup page posts that token plus a chosen username and password, the server makes the account, deletes the token, and logs you in.

When you log in, a dummy bcrypt check runs even for usernames that don't exist, so the response time doesn't tell an attacker which usernames are real. Both the real and dummy checks go through a shared concurrency limiter, because bcrypt runs on a shared thread pool and a burst from lots of IPs could otherwise starve everything else. On top of that, `express-rate-limit` caps it at 5 attempts per 15 minutes per IP.

A successful login makes a row in `auth_sessions`, and the JWT carries that row's id. Every request checks both the JWT signature and that the session row still exists. Logging out deletes the row, and that's what makes logout actually revoke access right away instead of the token quietly staying valid until it expires on its own.

## Data and communication

There's one WebSocket, updating once a second. The metrics and their recent history are collected and kept inside the agent, since that's the process with `/proc` access. The server just polls the agent once a second and relays what it gets to the browsers. The connection is checked against the JWT and the request's origin at the handshake, and a heartbeat drops dead connections after 30 seconds.

Docker is optional, not required. It's only ever touched from inside `agent/`, and `server/` has no Docker code at all. Container events (crashed, restarted, went unhealthy) are watched from inside the agent.

The AI provider is swappable. There's one small interface that all three adapters implement, Anthropic, Gemini, and a generic OpenAI-compatible one that also covers OpenRouter, Groq and local models. All three use plain `fetch`, no SDK, so they're easy to test without hitting a real API. You set your provider and key in Settings, it's encrypted before it's stored, and the API only ever gives you back the last few characters of it. Every diagnosis attempt gets logged after being scrubbed for anything key-shaped.

The database is a single shared SQLite connection with a small migration runner: numbered `.sql` files, each run in its own transaction, with a table tracking which ones have already been applied.

## Some of the bigger decisions and why

1. The AI must never get host access, period. That's the whole reason the agent is a separate process. It also happens to leave room for a real multi-server version later without a rewrite.
2. Sentinel itself runs natively on systemd, not in Docker. A tool meant to watch a server has no real security boundary if it needs `privileged: true` and `pid: host` to even run. Docker is just another thing Sentinel watches, not something it needs.
3. The agent's socket uses a Unix socket, a file permission and a shared token, since `SO_PEERCRED` isn't reachable from plain Node. Nothing privileged is ever on the network on a single-host install.
4. There's no shell tool, on purpose. Dangerous actions aren't just denied, they aren't an option at all. There's no write-any-file, touch-the-firewall, or add-a-user tool in the registry, so the AI can't ask for one no matter how it's prompted.
5. The AI provider is something you configure, not something hardcoded. Bring your own key, and the OpenAI-compatible adapter alone covers most of what people want to use anyway.
6. "It ran" and "it's fixed" are always kept separate. A fix that runs but doesn't actually solve the problem ends up `FAILED`, never `RESOLVED`. I really don't want Sentinel telling anyone something's fine when it isn't.
7. SQLite, with a real migration system. It's the right fit for one self-hosted server, and the code is structured so moving to Postgres later is possible if it's ever needed.
8. Everything that spawns a process uses an argv array, never a shell string, anywhere in the codebase. There's a test that fails the build if that ever changes.
9. First-run setup is a token printed to the console plus a web form, not an env var or a CLI prompt, so no credential ever passes through a shell command or sits in a file.
10. Sessions are tracked server-side instead of trusting the JWT alone, because a bare JWT can't be revoked before it expires. Storing the session id and checking it every request is what makes "log out" mean something.
11. The AI's claimed risk level is only for display, it's not authoritative. Every recommended tool gets checked against the agent's real live catalog, and the agent's registered risk is what decides whether it needs approval, not whatever the model said.
12. Every AI-suggested action needs a human to approve it by default. Auto-remediation does exist, but it's opt-in per service and it has to pass four separate checks: the exact resource is explicitly opted in (no wildcards), the tool is on a short hardcoded list of restart-only operations, its real risk is medium or lower, and it hasn't hit its hourly rate limit. Only the first eligible action from a diagnosis ever runs on its own.
13. Checking whether a fix worked reuses the check the tool already has, instead of writing a second copy of "what does success look like" somewhere else. The single check lives in the agent, the "wait a few seconds and try again" logic lives in the server.
14. Duplicate incidents are blocked at the database level with a partial unique index, not just in app code. That closes the race where two things both open an incident for the same resource at once.
15. The one-click approve link doesn't grant any new power. It's just a second way to authenticate an approval that's already waiting. Signed, single use, expires in 30 minutes, off by default.
16. Ask Sentinel is read-only, checked twice. Once by name before the agent is even contacted, and again by the agent itself refusing anything above read-only no matter what it's asked.
17. If you add more than one AI key, Sentinel fails over between them automatically, trying each in priority order. Whichever key answers, the response goes through the exact same checks, failover never loosens anything.
18. Reading files is an allowlist you turn on yourself, not something the AI can ask for. Read-only, starts empty, and even inside folders you've allowed, things like SSH keys, `.env` files and `/etc/shadow` are blocked no matter what. Sentinel's own history (past incidents, recordings, activity) is served separately and never touches the agent at all.

## Security, in more detail

Login is a signed JWT in an http-only, same-site cookie, with the cookie's secure flag matching the real request protocol even behind a proxy. Passwords are bcrypt at cost 12, made only through the setup wizard, never from an env var. Sessions can be revoked because they're in the database.

Rate limiting is 5 attempts per 15 minutes per IP, plus a separate global cap on concurrent bcrypt operations so a distributed burst can't starve it.

Every tool has a risk level, one of `READ_ONLY`, `LOW_RISK`, `MEDIUM_RISK`, `HIGH_RISK` or `DESTRUCTIVE`. Only `READ_ONLY` runs without approval, and `DESTRUCTIVE` can never be set to auto-approve. Both the server and the agent check this on their own.

Anything that spawns a process uses an allowlisted name and an argv array, never a shell string.

Secrets on disk live under `/etc/sentinel/`, `0640 root:sentinel`, directory `0750`. AI keys and webhook URLs are AES-256-GCM encrypted and never sent to the browser. Anything key-shaped gets scrubbed before it's stored or sent to a provider.

The server process runs sandboxed under systemd (no new privileges, restricted filesystem access, and so on), as an extra layer since it's the process making outbound calls. The agent isn't sandboxed the same way because it genuinely needs root, its safety comes from the tool list instead.

Nothing privileged is network-reachable. The agent's socket is local only, and the server listens behind your own reverse proxy.

Docker's socket is basically root on the host, so it's confined to the agent and never reachable from the server or the AI path directly.

Errors never leak internals. A catch-all handler logs the real error on the server and sends only a generic message to the browser.

AI output that drives an action has to be valid structured JSON, checked against a schema, with one retry if it fails before it falls back to raw text for a human. Free text never triggers a tool call on its own, every suggested action is checked against the real tool list first, and every one still needs a human approval no matter its risk.

## The database, roughly

- `users`, `settings`, `auth_sessions`, `activity_events`
- `resources` and `resource_relationships` for the dependency graph
- `incidents`, `incident_evidence`, `incident_actions` for the state machine (a unique index keeps one open incident per resource), and `incident_timeline` records every step so the whole thing can be replayed
- `tool_executions` logs every agent call made on an incident's behalf
- `ai_runs` logs every model call, including failed and retried ones
- `ai_credentials` and `ai_credential_calls` for the failover pool and its rate limits
- `chat_sessions` and `chat_messages` for Ask Sentinel
- `deployments` for deploy and rollback history

`activity_events` is just a short recent-events feed. The real record of what happened is in `incident_timeline`, `tool_executions`, `ai_runs` and `incident_actions`.

## Testing

Both `agent/` and `server/` have real `node --test` suites: the tool registry, the risk policy, auth, migrations, the AI layer against fixtures, the whole incident pipeline, every API route, and a test that specifically checks no shell command ever sneaks in.

```bash
( cd agent  && node --test )
( cd server && node --test )
```

`frontend/` doesn't have an automated test suite yet.
