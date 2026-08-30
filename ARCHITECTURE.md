# Sentinel — Architecture

Sentinel is an installable, self-hosted **AI-powered infrastructure
engineering platform** for a single server. Its reasoning loop is:

```
OBSERVE → DIAGNOSE → PLAN → ACT → VERIFY
```

It behaves like an AI infrastructure engineer — detecting incidents,
gathering relevant evidence, proposing a root cause and a remediation,
executing it only with approval, and verifying the fix actually worked
(not just that the action ran).

**Non-negotiable product principle:** the AI never gets shell access. It
can only request named, schema-validated tools from a fixed registry,
gated by a risk classification and an approval policy.

---

## Process model

```
Browser → sentinel-server (user: sentinel, unprivileged)
              │  UI, API, WS, auth, incidents, AI orchestration, SQLite
              │  AF_UNIX + bearer token
              ▼
          sentinel-agent (user: root)
              tool registry only — no generic "run command" endpoint
              │
    /proc /sys · docker.sock · systemctl · git · logs · files
```

- **`server/`** — the unprivileged control plane. Holds auth, SQLite,
  the WebSocket broadcaster, and every REST route. Each route is a thin
  proxy that calls a named tool on the agent rather than touching the
  host itself. Also home to the incident engine, evidence-gathering
  context engine, the provider-agnostic AI layer, post-action
  verification, the minimal resource/dependency graph, and settings
  (with AES-256-GCM encryption at rest for the AI key and webhook URLs).
- **`agent/`** — the only process with host privilege. Owns the
  collectors, the tool registry, the risk policy, and the bearer-token
  auth for its own socket.
- **`frontend/`** — React 18 + Vite SPA, built and served by `server/`.
  Real client-side routing (`react-router-dom`), one path per section. A
  thin `fetch` wrapper (`frontend/src/api/client.js`) is used by every
  section; a 401 anywhere redirects to `/login`.
- **`cli/`** — the `sentinel` management CLI (`status`, `start`, `stop`,
  `restart`, `logs`, `doctor`, `config`, `update`, `uninstall`).
- **`packaging/systemd/`** — the two unit files; `install.sh` at the repo
  root is the installer that wires everything together on a fresh host.

### Filesystem layout (installer-created)

```
/usr/lib/sentinel/{agent,server,frontend,cli}/   application code, root:root
/etc/sentinel/                                    root:sentinel, 0750
  ├── agent.env, server.env                       root:sentinel, 0640
  ├── agent.token, secret.key, jwt.key            root:sentinel, 0640
/var/lib/sentinel/sentinel.db{,-wal,-shm}         sentinel:sentinel
/var/log/sentinel/                                sentinel:sentinel, 0750
/run/sentinel/agent.sock                          root:sentinel, 0660 (dir 0750)
/usr/local/bin/sentinel -> .../cli/sentinel.js
```

`cli/lib/paths.js` is the single source of truth for these paths on the
CLI side; `install.sh` and the two systemd units must all agree with it.

---

## Component auth

The agent's Unix socket is `0660 root:sentinel` (a filesystem ACL
substitutes for `SO_PEERCRED`, which Node doesn't expose without a native
addon) **plus** a shared bearer token (`SENTINEL_AGENT_TOKEN` env for dev,
or `/etc/sentinel/agent.token` file in production). `server/src/agent/`
holds the client; `UnixSocketTransport` implements a generic transport
interface so a future networked transport (multi-server) doesn't require a
redesign.

### Wire protocol (agent HTTP over the socket)

- `GET /health` — unauthenticated liveness
- `GET /tools` — catalog: name / description / parameters / risk /
  `hasVerify` (no handlers)
- `POST /tools/:name` — body = params. An `X-Sentinel-Approved: true`
  header asserts the caller's own approval check passed — the agent
  independently re-derives whether that's sufficient from the tool's own
  fixed risk classification via `policy.isAuthorized`, never trusting the
  header alone for anything above `READ_ONLY`.
- `POST /tools/:name/verify` — runs the tool's post-action check if one is
  defined (404 otherwise). No approval gate, since verify never mutates.

---

## Auth model

No admin credentials in env vars or config files.

**First run:** `server.js` calls `ensureSetupToken()` on boot, which —
only while the `users` table is empty — generates (or reuses across
restarts) a random token, stores it in `settings`, and prints it plus a
`/setup` URL to stdout. A minimal standalone page posts to
`POST /api/setup/complete` with `{token, username, password}`; on success
it creates the `users` row, deletes the setup token, and auto-logs-in.

**Login:** looks up the user, compares against a dynamically-generated
(not hardcoded) dummy bcrypt hash when the username doesn't exist, both
paths through `bcryptLimiter.js`'s `withBcryptSlot` (global concurrency
cap — bcrypt runs on libuv's shared threadpool, so per-IP rate limiting
alone doesn't stop a wide-IP burst from starving unrelated async I/O).
`express-rate-limit` caps it at 5 attempts / 15 min / IP on top of that.

**Sessions:** on success, `auth/sessions.js` creates an `auth_sessions`
row (`jti`, `user_id`, `expires_at`) and the JWT embeds that `jti`.
`verifyToken` checks both the JWT signature (HS256-pinned) *and* that the
session row still exists. Logout deletes the row — this is what makes
logout revoke access immediately, instead of the JWT staying valid for
its full lifetime after only the cookie was cleared.

---

## Communication / data layer

- **REST + one 1 Hz WebSocket broadcast.** Metrics and their 60-sample
  rolling history are collected and buffered **inside the agent**
  (`agent/src/tools/system.js`), since it's the process with `/proc`
  access. `server/`'s broadcaster polls `get_system_metrics` +
  `get_metric_history` once a second and relays to browser clients. JWT
  is verified at the WS upgrade handshake, plus an Origin check (the
  standard CSWSH mitigation on top of the `SameSite=Strict` cookie) and a
  30s ping/pong heartbeat that terminates dead connections.
- **Docker** is treated as a *detected capability*, not a dependency —
  accessed only from `agent/` via `dockerode`. `server/` has zero
  Docker-related imports. Container lifecycle events (die/oom/start/stop/
  restart) are watched inside the agent and exposed via a
  `get_docker_events` tool.
- **AI provider** is abstracted behind `AIProvider`
  (`chat({system, messages, responseSchema}) -> {text, toolCalls, usage}`),
  implemented by three adapters — `anthropic`, `gemini`,
  `openai-compatible` — all via Node's native `fetch`, no SDK dependency,
  so each is fixture-testable with an injectable `fetchImpl` and no live
  API calls in CI. The user supplies provider + key at runtime via
  `PUT /api/settings/ai` (or the multi-credential failover pool). Keys are
  AES-256-GCM encrypted at rest and never sent to the frontend —
  `GET /api/settings/ai` returns only a `keySuffix`. Every diagnosis
  attempt is recorded in `ai_runs`, redacted first via `ai/redact.js`.
- **DB access** goes through `db/connection.js`'s single shared
  `better-sqlite3` handle and `db/migrate.js`'s migration runner
  (`schema_migrations` table + numbered `.sql` files in `db/migrations/`,
  each applied in its own transaction).

---

## Architecture decisions

1. **Agent / control-plane split.** The AI must never hold host privilege.
   This also makes a future multi-server control plane possible without a
   redesign — a `Server` becomes `{identity, agent, capabilities, health}`.
2. **Native systemd over Docker for Sentinel itself.** A host-monitoring
   product that requires `privileged: true` + `pid: host` has no security
   boundary at all. Docker becomes a monitored capability like Caddy or
   nginx, not a hosting requirement.
3. **AF_UNIX + filesystem ACL + bearer token for agent auth.**
   `SO_PEERCRED` isn't available on Node's `net.Socket` without a native
   addon; the socket mode is the practical peer-identity control. Nothing
   privileged is ever network-reachable on a single-host install.
4. **Tool registry instead of shell access.** Dangerous operations are
   made *unrequestable*, not merely denied — there is no arbitrary
   file-write, firewall, SSH-config, user-management, or volume-delete
   tool in the registry, so the AI cannot ask for one regardless of
   prompt.
5. **Runtime-configurable AI provider, not hardcoded.** Users bring their
   own key via Settings. `openai-compatible` also serves OpenAI,
   OpenRouter, Groq, and local models through one base-URL field.
6. **Verification is a separate claim from execution.** "Action executed"
   and "problem resolved" must never be conflated — a failed post-action
   check produces `FAILED`, not `RESOLVED`.
7. **SQLite stays, with a real migration runner.** Correct for
   single-server self-hosted deployments; a repository layer keeps a
   PostgreSQL path open without committing to it now.
8. **`execFile`/`spawn` with argv arrays everywhere a process is
   spawned.** No shell-string interpolation anywhere in `agent/` or
   `server/` — enforced by an automated regression test
   (`agent/src/no-shell.test.js`).
9. **First-run setup via a token-gated web page**, not an env var or CLI
   wizard. A one-time token printed to the process's own console plus a
   browser form means no credential passes through a shell command or an
   env file.
10. **Server-side session table (`auth_sessions`), not JWT-only auth.** A
    bare JWT can't be revoked before it expires; storing the `jti`
    server-side and checking it on every request makes logout mean
    something.
11. **An AI-recommended action's `risk` field is display-only; the tool
    registry's own registered risk is authoritative.** The orchestrator
    cross-checks each recommended tool name against the agent's live
    catalog and uses *that* risk to gate approval, keeping the AI's own
    claim only as `claimedRisk` for the UI. An unrecognized tool name is
    dropped, never passed through.
12. **Every AI-recommended action requires human approval by default;
    auto-remediation is opt-in per resource, and narrower than the
    general approval policy.** Four independent conditions must all pass:
    the exact `type:externalId` is on an opt-in list that is empty by
    default and has no wildcard; the tool is in `AUTO_REMEDIABLE_TOOLS`, a
    code-level allowlist of *restorative* operations only (start/restart);
    the tool's real registered risk is at or below `MEDIUM_RISK`; and the
    resource is under a persisted per-resource rate limit. Only the first
    eligible action of a diagnosis is ever auto-run.
13. **Verification reuses each tool's existing `verify` function** instead
    of re-implementing "what does success look like" in `server/`. The
    single point-in-time check stays in the agent; the "give it a moment
    and retry" policy stays in `server/`.
14. **Incident dedup is a database constraint, not just application
    logic.** A partial unique index on `incidents(resource_id) WHERE
    status NOT IN (terminal)` closes the check-then-insert race.
15. **The one-click approve link grants no new capability** — it is a
    second authentication path to an action already in the approval
    queue. `POST /a/:token` calls the exact same `engine.approve()` the UI
    button calls; the link changes only how that approval is
    authenticated (an HMAC-signed, single-action, 30-minute token instead
    of a session). Off by default.
16. **Ask Sentinel is read-only by two independent gates** and escalates
    into the existing incident state machine rather than building a
    second one. `ai/chat.js` refuses any tool whose registered catalog
    risk isn't `READ_ONLY` before the agent is contacted, and separately
    calls the agent unapproved so its own `isAuthorized()` would reject
    anything above `READ_ONLY` regardless.
17. **AI credentials are an ordered pool with automatic failover**, tried
    by ascending `priority`, per-credential, raising only once every
    enabled credential has failed. Failing over never widens capability —
    a diagnosis served by the third credential goes through the identical
    catalog cross-check and approval gate as one served by the first.
18. **Filesystem reading is a per-path allowlist the operator opens, not a
    capability the AI can request into existence.** Only *reading*
    (`list_directory`, `read_file`, `search_files`, all `READ_ONLY`);
    confined to roots the operator adds in Settings (empty by default);
    narrowed again by `DENIED_PATTERNS` in `agent/src/tools/files.js`
    (keys, `.env`, `/root`, `~/.ssh`, `/etc/shadow`, `/proc/*/environ`)
    which the caller cannot influence; symlinks resolved *before* the
    containment check. Sentinel's own records (recordings, incidents,
    activity) are served by `ai/localTools.js`, which never contacts the
    agent at all.

---

## Security decisions

- **Authentication:** JWT (HS256-pinned) in an HTTP-only,
  `SameSite=Strict` cookie, `secure` flag reflecting the real request
  protocol (including behind a proxy via `X-Forwarded-Proto`). Credentials
  live in a `users` table (bcrypt cost 12), created via the token-gated
  first-run `/setup` wizard — never in env vars. Session revocation is
  implemented via `auth_sessions`.
- **Login hardening:** `express-rate-limit` caps attempts at
  5 / 15 min / IP. Independently, `bcryptLimiter.js` caps *global*
  concurrent bcrypt operations. The dummy hash used for unknown-username
  comparisons is generated at boot, not a hardcoded string.
- **Authorization / tool permissions:** every tool declares
  `risk ∈ READ_ONLY | LOW_RISK | MEDIUM_RISK | HIGH_RISK | DESTRUCTIVE`.
  Default policy: `READ_ONLY` auto-executes, everything else requires
  explicit approval, `DESTRUCTIVE` can never be set to auto-approve. Both
  the server (intent/policy) and the agent (independent re-validation)
  check risk and schema — the agent never trusts the caller.
- **Command allowlists:** service and container control are allowlisted by
  name; `systemctl` calls use `execFile` with an argv array, not a shell
  string.
- **Secrets:** `/etc/sentinel/{secret.key,agent.token,jwt.key,agent.env,
  server.env}` — all `0640 root:sentinel`, directory `0750 root:sentinel`.
  AI provider keys and notification webhook URLs are AES-256-GCM encrypted
  at rest (`crypto/aesGcm.js`, key from `secret.key`) and never returned
  to the frontend. A redaction pass (`ai/redact.js`) scrubs key/
  token-shaped substrings from anything persisted to
  `incident_evidence` / `ai_runs` or sent to a provider.
- **Process sandboxing:** `sentinel-server.service` runs under
  `NoNewPrivileges`, `ProtectHome`, `ProtectKernelModules`,
  `ProtectControlGroups`, `RestrictSUIDSGID`, `LockPersonality`, and an
  explicit `ReadWritePaths`/`ReadOnlyPaths` allowlist — defense in depth
  underneath the agent boundary, since this is the process that makes
  outbound calls to AI providers. `sentinel-agent.service` is
  deliberately **not** sandboxed this way — it needs real root; its
  safety boundary is the tool registry, not systemd confinement.
- **Network exposure:** the agent's Unix socket is local-only; nothing
  privileged is ever bound to a network interface. The server listens on
  loopback behind the user's own reverse proxy.
- **Docker socket risk:** read-write access to `docker.sock` is
  root-equivalent on the host. It is confined to `agent/` and never
  reachable from `server/` or the AI path directly.
- **Error responses never echo internals:** a catch-all Express error
  handler logs the real error server-side and returns only a generic
  `{error: "Bad request"}` or `{error: "Internal server error"}` to the
  client.
- **AI safety boundaries:** structured JSON only for anything that drives
  a machine action (ajv schema-validated, one retry feeding the
  validation error back, then falls back to `INVESTIGATING` with raw text
  preserved for a human). No free-form text ever triggers a tool call
  directly — every recommended action is cross-checked against the
  agent's live tool catalog before it becomes an `incident_actions` row,
  and every one of those rows requires explicit human approval regardless
  of risk before the agent ever sees `X-Sentinel-Approved: true` for it.

---

## Data model highlights

- `users`, `settings`, `auth_sessions`, `activity_events`
- `resources` / `resource_relationships` — the dependency graph
- `incidents` / `incident_evidence` / `incident_actions` — the state
  machine (a partial unique index enforces one open incident per
  resource); `incident_timeline` records every state transition so the
  loop is replayable
- `tool_executions` — every agent call made on an incident's behalf,
  populated by one shared wrapper so the audit trail is complete by
  construction
- `ai_runs` — every model round trip (including failed/retried attempts)
- `ai_credentials` / `ai_credential_calls` — the failover pool + its
  per-credential rate-limit accounting
- `chat_sessions` / `chat_messages` — Ask Sentinel
- `deployments` — durable deploy/rollback rows for incident correlation

`activity_events` is a *recent-events view* (capped, pruned on write) —
the real audit trail is `incident_timeline`, `tool_executions`,
`ai_runs` and `incident_actions`.

---

## Testing

`agent/` and `server/` have `node --test` suites (registry, policy, auth,
migrations, the AI provider layer against fixtures, the incident state
machine/store/engine/detector, HTTP-level integration for every route, and
a no-shell regression guard). Run them in a Node 20 environment:

```bash
( cd agent  && node --test )
( cd server && node --test )
```

`frontend/` has no automated test suite yet.
