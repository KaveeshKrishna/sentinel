#!/usr/bin/env bash
#
# Build the public, fully-fabricated demo of Sentinel.
#
# This is the normal frontend built with VITE_DEMO=1, which swaps every
# /api/* fetch and the /ws socket for in-browser mocks (frontend/src/demo/).
# The output is a static SPA with NO backend — it cannot reach a real host.
#
# Output: sentinel-demo/dist/  (served directly by Caddy — see README.md)

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
FRONTEND="$HERE/../frontend"

echo "→ Installing frontend deps"
( cd "$FRONTEND" && npm ci --no-audit --no-fund )

echo "→ Building demo bundle (VITE_DEMO=1)"
( cd "$FRONTEND" && VITE_DEMO=1 npx vite build --outDir "$HERE/dist" --emptyOutDir )

echo "✔ Built to $HERE/dist"
echo "  Serve locally to check:  npx serve $HERE/dist   (or: cd $HERE/dist && python3 -m http.server 4173)"
