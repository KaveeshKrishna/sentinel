# Security Policy

## Reporting a vulnerability

Sentinel runs with elevated privileges on your infrastructure (it monitors and,
increasingly, acts on your servers), so we take security reports seriously.

Please **do not open a public GitHub issue** for a suspected vulnerability.

Instead, open a private security advisory via GitHub's "Report a vulnerability"
flow on this repository (Security tab → Report a vulnerability), or contact the
maintainers directly through the channel listed in the repository profile.

Include, where possible:
- A description of the issue and its impact
- Steps to reproduce, or a proof of concept
- The affected version/commit
- Any suggested remediation

We aim to acknowledge reports within 72 hours.

## Scope

Sentinel's architecture is split into two privilege domains:

- **`sentinel-server`** — unprivileged. Runs the web UI, API, AI orchestration,
  and incident engine. Never has direct host access.
- **`sentinel-agent`** — privileged (runs as root). Exposes a fixed, schema-
  validated **tool registry** over a local Unix socket. It has no generic
  "run a command" endpoint.

Reports about privilege escalation from the server into the agent, tool
registry validation bypasses, authentication/session handling, or the AI's
ability to invoke a tool outside its declared risk policy are all in scope
and especially valuable.

## Supported versions

Only the latest released version is supported with security fixes while the
project is pre-1.0.
