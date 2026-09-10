# Sentinel, the public demo build

A shareable version of the Sentinel dashboard that's completely made up, same real React frontend, just built with `VITE_DEMO=1`.

## What's actually happening

That flag pulls in [`frontend/src/demo/`](../frontend/src/demo/), which swaps out `window.fetch` and `window.WebSocket` before the app even mounts:

- every `/api/*` call gets answered from fake state sitting in the browser
- the `/ws` stream is driven by a little simulator that randomly walks CPU, RAM, temp, load, and network numbers so the dashboard looks alive
- Ask Sentinel, approving incidents, deploys, and AI-provider errors are all scripted ahead of time

There's no backend at all. The whole thing is just static HTML, JS and CSS. It can't read or touch anything on whatever machine it's hosted on, so it's safe to put anywhere.

Anything you do on it (stopping a service, approving an incident, changing settings) gets saved in that browser's `localStorage` only. There's a Reset demo button in the notice popup if you want to start over.

Login is user `demo`, password `demo`. There's also a "Fill demo credentials" button right on the login page.

## Building it

```bash
bash sentinel-demo/build.sh      # outputs to sentinel-demo/dist/
```

`sentinel-demo/dist/` is gitignored since it's just a build output. Run the same command again any time you change the frontend.

## Serving it

It's a static SPA, so basically any static host works. To check it locally:

```bash
npx serve sentinel-demo/dist
# or:  cd sentinel-demo/dist && python3 -m http.server 4173
```

For a real reverse proxy you just need static file serving with an SPA fallback. Here's a Caddy block (also in [`Caddyfile.snippet`](./Caddyfile.snippet)):

```
http://DEMO_DOMAIN {
    root * /path/to/sentinel/sentinel-demo/dist
    encode gzip
    try_files {path} /index.html
    file_server
}
```

Same thing in nginx:

```nginx
server {
    server_name DEMO_DOMAIN;
    root /path/to/sentinel/sentinel-demo/dist;
    location / { try_files $uri /index.html; }
}
```
