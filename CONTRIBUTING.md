# Contributing to Sentinel

Thanks for wanting to help out with this.

## Setting things up

There's a `server/` (the unprivileged half, so the API, the web backend, the AI stuff), an `agent/` (the privileged one, the only process with root, systemctl and Docker access), a `frontend/` (the React UI, built and served by `server/`), and `cli/` (the `sentinel` command).

Read ARCHITECTURE.md first if you're planning a bigger change. It covers how things are laid out and why, so you're not fighting the design.

## Rules I actually care about

- Never give the server or the AI a way to run a raw shell command. Every privileged thing goes through the agent's tool list, which is a fixed set of named tools, each with a schema and a risk level. If you need a new capability, add a new tool with an honest risk level instead of loosening one that already exists.
- Use `execFile` or `spawn` with an argv array, not a shell string, anywhere you spawn a process.
- Don't hardcode anything specific to one machine, so no domains, IPs or fixed paths. This has to work on a fresh VPS with none of my own setup baked in.
- Keep pull requests small and focused. If it's a big architectural change, open an issue first so we can talk about it before you write the code.

## Running tests

Run the tests for whatever you touched before opening a PR:

```bash
cd server && npm test
cd agent  && npm test
```

If you don't want to install Node locally, you can run them in a throwaway container instead:

```bash
docker run --rm -v "$PWD:/repo" -w /repo/server node:20-alpine node --test src
docker run --rm -v "$PWD:/repo" -w /repo/agent  node:20-alpine node --test src
```

If you touch `install.sh`, run it through shellcheck, and ideally actually run it somewhere. A systemd-capable container lets you test real `systemctl`/`journalctl` behavior without messing with your own machine:

```bash
docker run --rm -v "$PWD:/repo:ro" koalaman/shellcheck:stable /repo/install.sh

docker run -d --name sentinel-test --privileged --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw jrei/systemd-ubuntu:24.04
docker cp . sentinel-test:/opt/sentinel
docker exec sentinel-test bash -c "cd /opt/sentinel && bash install.sh"
docker exec sentinel-test sentinel doctor
docker rm -f sentinel-test
```

`cli/` doesn't have automated tests yet, just a syntax check. The installer run above is basically its real test right now.

## Commit messages

Doesn't need to be perfect, but prefixes like `feat:`, `fix:`, `refactor:`, `docs:`, and `security:` help when they fit.
