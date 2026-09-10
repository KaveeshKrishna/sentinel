# Sentinel, architecture

Sentinel is a self-hosted AI infrastructure engineer for a single server. The core loop is:

```
OBSERVE → DIAGNOSE → PLAN → ACT → VERIFY
```

It watches your server, notices when something breaks, gathers the evidence that matters, proposes a cause and a fix, only runs that fix once you approve it, and then actually checks that the fix worked instead of assuming it did.

**The one rule I never break:** the AI never gets a shell. It can only call named tools from a fixed list, each with its own risk level and approval rule attached.

---

## How the two processes are split

```
Browser → sentinel-server (runs as an unprivileged user)
              │  UI, API, WebSocket, auth, incidents, AI, SQLite
              │  Unix socket + bearer token
              ▼
          sentinel-agent (runs as root)
              a fixed tool registry only, no "run a command" endpoint
              │
    /proc /sys · docker.sock · systemctl · git · logs · files
```

- **`server/`** is the unprivileged half. It holds auth, the database, the WebSocket broadcaster, and every API route. Every route is a thin wrapper that calls a named tool on the agent rather than touching the host directly. It also holds the incident engine, the AI layer, the evidence gatherer, post-action verification, a small resource graph, and settings (with AES-256-GCM encryption for the AI key and webhook URLs).
- **`agent/`** is the only process that touches the host. It owns the collectors, the tool registry, the risk policy, and the token check on its own socket.
- **`frontend/`** is a React 18 + Vite app, built and served by `server/`. Real client-side routing with one URL per section. A thin fetch wrapper handles every request and bounces to `/login` on a 401.
- **`cli/`** is the `sentinel` command: status, start, stop, restart, logs, doctor, config, update, uninstall.
- **`packaging/systemd/`** holds the two service files, and `install.sh` at the repo root wires all of this together on a fresh machine.

### Where things live once installed

```
/usr/lib/sentinel/{agent,server,frontend,cli}/   the code itself, root:root
/etc/sentinel/                                    root:sentinel, 0750
  ├── agent.env, server.env                       root:sentinel, 0640
  ├── agent.token, secret.key, jwt.key             root:sentinel, 0640
/var/lib/sentinel/sentinel.db{,-wal,-shm}         sentinel:sentinel
/var/log/sentinel/                                sentinel:sentinel, 0750
/run/sentinel/agent.sock                          root:sentinel, 0660 (dir 0750)
/usr/local/bin/sentinel -> .../cli/sentinel.js
```

`cli/lib/paths.js` is the one place these paths are defined on the CLI side, `install.sh` and the two systemd units all have to agree with it.

---

## How the two sides authenticate to each other

The agent's socket is `0660 root:sentinel` (a file permission stands in for `SO_PEERCRED`, which Node can't check without a native addon), plus a shared bearer token. That token lives in `SENTINEL_AGENT_TOKEN` for dev, or `/etc/sentinel/agent.token` in production. `server/src/agent/` is the client that talks to it, and it goes through a generic transport interface so a networked version later wouldn't need a rewrite.

### The wire protocol

- `GET /health`, no auth needed, just liveness
- `GET /tools`, the full catalog: name, description, params, risk level
- `POST /tools/:name`, actually runs a tool. The server can send an `X-Sentinel-Approved: true` header saying it already checked approval, but the agent never just believes that header, it looks the tool's real risk level up itself and decides again
- `POST /tools/:name/verify`, runs the tool's own "did this actually work" check, if it has one

---

## How login works

There's no admin password sitting in an env var or a config file anywhere.

**First run:** the server checks if the `users` table is empty, and if it is, generates a one-time token, prints it to the console along with a `/setup` link, and waits. A small setup page posts the token plus a chosen username and password, the server creates the account, deletes the token, and logs you in.

**Logging in:** a dummy bcrypt check runs even for usernames that don't exist, so the response time doesn't give away which usernames are real. Both real and dummy checks go through a shared concurrency limiter, since bcrypt itself runs on a shared thread pool and a burst of requests from many IPs could otherwise starve everything else. On top of that, `express-rate-limit` caps it at 5 attempts per 15 minutes per IP.

**Sessions:** a successful login creates a row in `auth_sessions`, and the JWT carries that row's id. Every request checks both the JWT signature and that the session row still exists. Logging out deletes the row, which is what makes logout actually revoke access right away instead of the token quietly staying valid until it expires on its own.

---

## Data and communication

- **One WebSocket, updating once a second.** Metrics and their recent history are collected and kept inside the agent, since that's the process with `/proc` access. The server just polls the agent once a second and relays whatever it gets to connected browsers. The connection is checked against the JWT and the request's origin at the handshake, and a heartbeat drops dead connections after 30 seconds.
- **Docker is optional, not required.** It's only ever touched from inside `agent/`, `server/` has no Docker code at all. Container events (crashed, restarted, went unhealthy) are watched from inside the agent.
- **The AI provider is swappable.** There's one small interface all three adapters implement (Anthropic, Gemini, and a generic OpenAI-compatible one that also covers OpenRouter, Groq, and local models). All three use plain `fetch`, no SDK, so they're easy to test without hitting a real API. You set your provider and key from Settings, and it's encrypted before it's stored, the API only ever returns the last few characters of it back to you. Every attempt at a diagnosis gets logged, after being scrubbed for anything key-shaped.
- **The database** is a single shared SQLite connection with a small migration runner: numbered `.sql` files, each one run in its own transaction, with a table tracking which ones have already applied.

---

## Some of the bigger decisions and why

1. **The AI must never get host access, period.** That's the whole reason the agent exists as a separate process. It also happens to make a real multi-server version possible down the line without a rewrite.
2. **Sentinel itself runs natively on systemd, not in Docker.** A tool meant to monitor a server has no real security boundary if it needs `privileged: true` and `pid: host` to run. Docker becomes just another thing Sentinel watches, not something it depends on.
3. **The agent's socket uses a Unix socket, a file permission, and a shared token**, since `SO_PEERCRED` isn't reachable from plain Node. Nothing privileged is ever exposed on the network on a single-host install.
4. **There's no shell tool, on purpose.** Dangerous actions aren't just blocked, they don't exist as an option at all. There's no arbitrary write-a-file, touch-the-firewall, or add-a-user tool anywhere in the registry, so the AI literally cannot ask for one no matter what it's prompted with.
5. **The AI provider is something you configure, not something hardcoded.** Bring your own key, and the OpenAI-compatible adapter alone covers most of what people actually want to use.
6. **"It ran" and "it's fixed" are always kept separate.** A fix that executes but doesn't actually solve the problem ends up `FAILED`, never `RESOLVED`. I don't want Sentinel lying to anyone about whether something's actually okay.
7. **SQLite, with a real migration system.** It's the right fit for a single self-hosted server, and the way the code's structured leaves room to move to Postgres later if that's ever needed.
8. **Every spawned process uses an argv array, never a shell string**, anywhere in the whole codebase. There's an automated test that fails the build if that ever changes.
9. **First-run setup is a token printed to the console plus a web form**, not an env var or a CLI prompt, so no credential ever has to pass through a shell command or sit in a file.
10. **Sessions are tracked server-side instead of relying on the JWT alone**, because a bare JWT can't be revoked before it expires. Storing the session id and checking it every request is what makes "log out" mean something.
11. **The AI's own claimed risk level is just for display, it's not authoritative.** Every recommended tool gets checked against the agent's real, live catalog, and the agent's actual registered risk is what decides whether it needs approval, not whatever the model said about itself.
12. **Every AI-suggested action needs a human to approve it by default.** Auto-remediation exists, but it's opt-in per service, and it has to pass four separate checks: the exact resource is explicitly opted in (no wildcards), the tool is on a short hardcoded list of restart-only operations, its real risk is medium or lower, and it hasn't hit its hourly rate limit. Only the first eligible action from a diagnosis ever runs on its own.
13. **Checking whether a fix worked reuses the same check the tool already has**, instead of writing a second copy of "what does success look like" somewhere else. The single check lives in the agent, the "give it a few seconds and try again" logic lives in the server.
14. **Duplicate incidents are blocked at the database level**, not just in application code, with a partial unique index. That closes the race condition where two things could both open an incident for the same resource at once.
15. **The one-click approve link doesn't grant any new power.** It's just a second way to authenticate an approval that's already waiting, signed, single-use, and expires in 30 minutes. It's off by default.
16. **Ask Sentinel can only ever be read-only, checked twice.** Once by name, before the agent is even contacted, and once again by the agent itself refusing anything above read-only regardless of what it's asked to run.
17. **If you add more than one AI key, Sentinel fails over between them automatically**, trying each in priority order. Whichever key actually answers, the response goes through the exact same checks either way, failover never loosens anything.
18. **Reading files is an allowlist you turn on yourself, not something the AI can ask for.** It's read-only, starts empty, and even inside folders you've allowed, things like SSH keys, `.env` files, and `/etc/shadow` are blocked no matter what. Sentinel's own history (past incidents, recordings, activity) is served separately and never touches the agent at all.

---

## Security, in more detail

- **Login:** a signed JWT in an HTTP-only, same-site cookie, with the cookie's secure flag matching the real request protocol even behind a proxy. Passwords are bcrypt (cost 12), created only through the setup wizard, never from an env var. Sessions can be revoked because they're tracked in the database.
- **Rate limiting:** 5 attempts per 15 minutes per IP, plus a separate global cap on concurrent bcrypt operations so it can't be starved by a distributed burst.
- **Tool risk levels:** every tool is one of `READ_ONLY`, `LOW_RISK`, `MEDIUM_RISK`, `HIGH_RISK`, or `DESTRUCTIVE`. Only `READ_ONLY` ever runs without approval, and `DESTRUCTIVE` can never be set to auto-approve, period. Both the server and the agent check this independently.
- **Everything that spawns a process** uses an allowlisted name and an argv array, never a shell string.
- **Secrets on disk** live under `/etc/sentinel/`, `0640 root:sentinel`, directory `0750`. AI keys and webhook URLs are AES-256-GCM encrypted and never sent back to the browser. Anything key-shaped gets scrubbed out before it's stored or sent to a provider.
- **The server process runs sandboxed under systemd** (no new privileges, restricted filesystem access, and so on), as an extra layer since it's the process making outbound calls. The agent isn't sandboxed the same way, since it genuinely needs root, its safety comes from the tool list instead.
- **Nothing privileged is ever network-reachable.** The agent's socket is local-only, and the server itself only listens behind your own reverse proxy.
- **Docker's socket is root-equivalent access**, so it's confined entirely to the agent and never reachable from the server or the AI layer directly.
- **Errors never leak internals.** A catch-all handler logs the real error on the server and returns only a generic message to the browser.
- **AI output that drives an action has to be valid, structured JSON**, checked against a schema, with one retry if it fails before falling back to raw text for a human to read. Free text never triggers a tool call on its own, every suggested action is checked against the real tool list first, and every single one still needs a human's approval no matter its risk level.

---

## The database, roughly

- `users`, `settings`, `auth_sessions`, `activity_events`
- `resources` / `resource_relationships` for the dependency graph
- `incidents` / `incident_evidence` / `incident_actions` for the state machine (a unique index keeps one open incident per resource), and `incident_timeline` records every step so the whole thing can be replayed later
- `tool_executions` logs every single agent call made on an incident's behalf
- `ai_runs` logs every model call, including failed and retried ones
- `ai_credentials` / `ai_credential_calls` for the failover pool and its rate limits
- `chat_sessions` / `chat_messages` for Ask Sentinel
- `deployments` for deploy and rollback history

`activity_events` is just a short recent-events feed, the real record of what happened lives in `incident_timeline`, `tool_executions`, `ai_runs`, and `incident_actions`.

---

## Testing

Both `agent/` and `server/` have real `node --test` suites (the tool registry, the risk policy, auth, migrations, the AI layer against fixtures, the whole incident pipeline, every API route, and a test that specifically checks no shell command ever sneaks in):

```bash
( cd agent  && node --test )
( cd server && node --test )
```

`frontend/` doesn't have an automated test suite yet.
