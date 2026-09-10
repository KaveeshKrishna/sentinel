# Security Policy

## Found a vulnerability?

Sentinel runs with real privileges on your infrastructure, and it's increasingly able to act on its own, so I take security reports seriously.

Please don't open a public GitHub issue about it.

Instead, use GitHub's private security advisory flow on this repo (the Security tab has a "Report a vulnerability" button), or reach out through the contact info in the repository profile.

If you can, include:
- What the issue is and what it lets someone do
- Steps to reproduce it, or a proof of concept
- Which version or commit you tested against
- Any fix you'd suggest, if you have one

I'll try to acknowledge reports within 72 hours.

## What's in scope

Sentinel is split into two halves with different levels of trust:

- **`sentinel-server`**, unprivileged. Runs the web UI, the API, the AI stuff, and the incident engine. Has no direct access to the host.
- **`sentinel-agent`**, privileged, runs as root. Exposes a fixed, schema-checked list of tools over a local socket. There's no generic "run a command" endpoint anywhere.

Reports about getting from the server into the agent, bypassing the tool registry's checks, breaking auth or session handling, or getting the AI to call a tool outside its declared risk level, all of that is exactly the kind of thing I want to hear about.

## Supported versions

Only the latest release gets security fixes right now, the project's still pre-1.0.

## About the git history

I rewrote the git history before making Sentinel public. The early commits had a local environment file, my real server's hostname, a LAN IP, and some internal notes in them, none of which should've been public. All of that's been removed, and anything pointing at my own machine got swapped for a placeholder. So commit hashes from before the public release won't match anything you might have seen earlier, but the dates and messages themselves are still the real ones.
