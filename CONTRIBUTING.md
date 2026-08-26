# Contributing to Sentinel

Thanks for your interest in contributing.

## Development setup

Sentinel is split into three packages:

```
server/     unprivileged control plane — API, web UI backend, AI orchestration
agent/      privileged host agent — the only process with root/systemctl/Docker access
frontend/   React UI, built and served by server/
cli/        the `sentinel` management CLI
```

See `ARCHITECTURE.md` for the current architecture, implementation status, and
in-flight decisions before making structural changes.

## Ground rules

- **Never add a way for the server or the AI to run an arbitrary shell
  command.** All privileged operations go through the agent's tool registry —
  a fixed, schema-validated set of named tools with a declared risk level.
  If your change needs a new privileged capability, add a new tool with an
  explicit risk classification rather than widening an existing one.
- Prefer `execFile`/`spawn` with an argv array over shell-string
  interpolation anywhere a process is spawned.
- Don't hardcode host-specific values (domains, IPs, paths). Sentinel must
  work on a freshly provisioned VPS with no assumptions about the installer's
  own infrastructure.
- Keep PRs focused. Large architectural changes should be discussed in an
  issue first.

## Tests

Run the test suite for the package you touched before opening a PR:

```bash
cd server && npm test
cd agent  && npm test
```

## Commit style

Use conventional prefixes where it helps: `feat:`, `fix:`, `refactor:`,
`docs:`, `security:`.
