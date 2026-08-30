# Sentinel — public demo build

A shareable, **fully fabricated** version of the Sentinel dashboard — the
same React frontend, built with `VITE_DEMO=1`.

## What it is

That flag pulls in [`frontend/src/demo/`](../frontend/src/demo/), which
replaces `window.fetch` and `window.WebSocket` before the app mounts:

- every `/api/*` request is answered from fabricated state held in the
  browser
- the `/ws` telemetry stream is driven by a local simulator that
  random-walks CPU / RAM / temp / load / network so the dashboard *looks*
  live
- Ask Sentinel, incident approval, deploys and AI-provider errors are all
  scripted

**There is no backend.** The build output is static HTML/JS/CSS. It cannot
read or change anything on the host it is served from — it is safe to host
anywhere.

Per-visitor changes (stopping a service, approving the incident, editing
settings) persist in that browser's `localStorage`; the notice popup has a
**Reset demo** button.

Login: **user `demo` / password `demo`** (there's a "Fill demo
credentials" button on the login page).

## Build

```bash
bash sentinel-demo/build.sh      # → sentinel-demo/dist/
```

`sentinel-demo/dist/` is gitignored — it's a build artifact. Rebuild with
the same command after any frontend change.

## Serve

It's a static SPA, so any static host works. To check locally:

```bash
npx serve sentinel-demo/dist
# or:  cd sentinel-demo/dist && python3 -m http.server 4173
```

For a production reverse proxy you only need static file serving with an
SPA fallback. Example Caddy block (see
[`Caddyfile.snippet`](./Caddyfile.snippet)):

```
http://DEMO_DOMAIN {
    root * /path/to/sentinel/sentinel-demo/dist
    encode gzip
    try_files {path} /index.html
    file_server
}
```

nginx equivalent:

```nginx
server {
    server_name DEMO_DOMAIN;
    root /path/to/sentinel/sentinel-demo/dist;
    location / { try_files $uri /index.html; }
}
```
