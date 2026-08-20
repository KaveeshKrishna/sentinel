# ════════════════════════════════════════════════════
#  Sentinel — Multi-stage Dockerfile
#  Stage 1: Build React/Vite frontend
#  Stage 2: Production Node.js backend + frontend dist
# ════════════════════════════════════════════════════

# ── Stage 1: Frontend build ───────────────────────
FROM node:20-alpine AS frontend-build

WORKDIR /build

# Cache npm install separately from source copy
COPY frontend/package*.json ./
RUN npm install --no-audit

COPY frontend/ .
RUN npm run build

# ── Stage 2: Backend production image ────────────
FROM node:20-alpine AS production

# Native module build deps (for bcrypt, better-sqlite3)
RUN apk add --no-cache python3 make g++ linux-headers util-linux

WORKDIR /app

# Install backend dependencies (production only)
COPY backend/package*.json ./
RUN npm install --no-audit --omit=dev

# Copy backend source
COPY backend/src      ./src
COPY backend/scripts  ./scripts

# Copy frontend build output → served as static files
COPY --from=frontend-build /build/dist ./public

# Data directory for SQLite (overridden by volume mount)
RUN mkdir -p /app/data

# Non-root user for security
RUN addgroup -g 1001 sentinel && adduser -D -u 1001 -G sentinel sentinel
# Note: we skip chown here because the container needs docker socket access
# and some files are bind-mounted as root-owned. Running as root for this
# personal-use dashboard is an accepted tradeoff.

EXPOSE 3000

# Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "src/server.js"]
