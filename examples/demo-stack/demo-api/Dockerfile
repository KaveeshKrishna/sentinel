# Minimal demo image — not the pattern to follow for a real production
# Dockerfile (no multi-stage build, no non-root user); this exists purely
# to give the incident-detection rehearsal something real to react to.
FROM node:20-alpine

WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY index.js .

# This is the mechanism the container_unhealthy detector rule reacts to:
# once demo-db is unreachable, /health starts returning 503 and Docker
# flips this container's health status to "unhealthy" within a couple of
# checks — no Caddy or network-tool involvement needed.
HEALTHCHECK --interval=5s --timeout=3s --retries=2 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

EXPOSE 3000
CMD ["node", "index.js"]
