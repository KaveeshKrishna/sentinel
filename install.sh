#!/usr/bin/env bash
#
# Sentinel installer.
#
# Target usage (once a public release exists):
#   curl -fsSL https://raw.githubusercontent.com/<ORG>/<REPO>/main/install.sh | sudo bash
#
# That URL is a placeholder — there is no published release yet. Until
# then, run this from a local checkout:
#   cd sentinel && sudo bash install.sh
#
# Idempotent: running this a second time upgrades an existing install in
# place. It never touches an existing /etc/sentinel or /var/lib/sentinel
# beyond adding new files — your admin account and recordings survive.

set -euo pipefail

SENTINEL_USER="sentinel"
SENTINEL_GROUP="sentinel"
APP_DIR="/usr/lib/sentinel"
CONFIG_DIR="/etc/sentinel"
DATA_DIR="/var/lib/sentinel"
LOG_DIR="/var/log/sentinel"
SYSTEMD_DIR="/etc/systemd/system"
MIN_NODE_MAJOR=20

log()  { echo "[sentinel-install] $*"; }
warn() { echo "[sentinel-install] WARNING: $*" >&2; }
die()  { echo "[sentinel-install] ERROR: $*" >&2; exit 1; }

# A "safe" env-file reader: never fails the whole script under `set -e`
# even when the file or key is absent (bash function exit status is
# whatever the LAST command ran is, hence the trailing `true`).
env_get() {
  local file="$1" key="$2"
  if [ -f "$file" ]; then
    grep -E "^${key}=" "$file" 2>/dev/null | tail -n1 | cut -d= -f2-
  fi
  true
}

gen_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

[ "$(id -u)" -eq 0 ] || die "Must be run as root (try: sudo bash install.sh)"

# ── Resolve the source tree ─────────────────────────────────────────────────
# curl|bash mode has no real file for BASH_SOURCE to point at (stdin isn't
# a path) — until a release tarball exists to fetch, fail clearly instead
# of pretending this works.
if [ -n "${SENTINEL_SOURCE_DIR:-}" ]; then
  SOURCE_DIR="$SENTINEL_SOURCE_DIR"
elif [ -f "${BASH_SOURCE[0]}" ]; then
  SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
else
  die "No local source found (this looks like curl|bash with no release to fetch yet). Run from a checkout: cd sentinel && sudo bash install.sh — or set SENTINEL_SOURCE_DIR."
fi
[ -f "$SOURCE_DIR/packaging/systemd/sentinel-agent.service" ] || die "SENTINEL_SOURCE_DIR ($SOURCE_DIR) doesn't look like a Sentinel checkout"

log "Installing from: $SOURCE_DIR"

# ── 1. Detect OS / architecture ─────────────────────────────────────────────
[ -f /etc/os-release ] || die "Cannot detect OS (/etc/os-release missing) — unsupported system"
# shellcheck disable=SC1091
. /etc/os-release
OS_ID="${ID:-unknown}"
ARCH="$(uname -m)"

case "$OS_ID" in
  ubuntu|debian) ;;
  *) die "Unsupported OS: ${PRETTY_NAME:-$OS_ID}. Sentinel currently supports Ubuntu and Debian." ;;
esac
case "$ARCH" in
  x86_64|aarch64) ;;
  *) die "Unsupported architecture: $ARCH" ;;
esac
log "Detected: ${PRETTY_NAME:-$OS_ID} ($ARCH)"

command -v systemctl >/dev/null 2>&1 || die "systemd not found — Sentinel requires a systemd-managed host"

# ── 2. Base packages ─────────────────────────────────────────────────────────
log "Ensuring base packages are present (curl, openssl, rsync, ca-certificates)…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl openssl rsync ca-certificates gnupg >/dev/null

# ── 3. Node.js ────────────────────────────────────────────────────────────────
install_node() {
  log "Installing Node.js ${MIN_NODE_MAJOR}.x via NodeSource…"
  curl -fsSL "https://deb.nodesource.com/setup_${MIN_NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
}

if command -v node >/dev/null 2>&1; then
  CURRENT_NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
  if [ "$CURRENT_NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]; then
    warn "Node.js $(node -v) found, but Sentinel needs >= ${MIN_NODE_MAJOR}.x — installing a newer version."
    install_node
  else
    log "Node.js $(node -v) already installed."
  fi
else
  install_node
fi
command -v node >/dev/null 2>&1 || die "Node.js installation failed"

# ── 4. Detect existing install ───────────────────────────────────────────────
EXISTING_INSTALL=false
if [ -f "$SYSTEMD_DIR/sentinel-agent.service" ] || [ -d "$APP_DIR" ]; then
  EXISTING_INSTALL=true
  log "Existing installation detected — upgrading in place. Configuration and database are preserved."
fi

# ── 5. System user/group ─────────────────────────────────────────────────────
if ! getent group "$SENTINEL_GROUP" >/dev/null 2>&1; then
  groupadd --system "$SENTINEL_GROUP"
fi
if ! id "$SENTINEL_USER" >/dev/null 2>&1; then
  log "Creating system user '$SENTINEL_USER'…"
  useradd --system --no-create-home --shell /usr/sbin/nologin --gid "$SENTINEL_GROUP" "$SENTINEL_USER"
else
  log "System user '$SENTINEL_USER' already exists."
fi

# ── 6. Directories ────────────────────────────────────────────────────────────
install -d -m 0750 -o root -g "$SENTINEL_GROUP" "$CONFIG_DIR"
install -d -m 0750 -o "$SENTINEL_USER" -g "$SENTINEL_GROUP" "$DATA_DIR"
install -d -m 0750 -o "$SENTINEL_USER" -g "$SENTINEL_GROUP" "$LOG_DIR"
install -d -m 0755 -o root -g root "$APP_DIR"

# ── 7. Application code ──────────────────────────────────────────────────────
log "Installing application code to $APP_DIR…"
for d in agent server frontend cli; do
  rsync -a --delete \
    --exclude 'node_modules' --exclude 'data' --exclude '*.db' --exclude '*.db-*' \
    "$SOURCE_DIR/$d/" "$APP_DIR/$d/"
done

log "Installing production dependencies (this can take a minute)…"
( cd "$APP_DIR/agent"  && npm ci --omit=dev --no-audit --no-fund >/dev/null )
( cd "$APP_DIR/server" && npm ci --omit=dev --no-audit --no-fund >/dev/null )

if [ -d "$APP_DIR/frontend" ]; then
  log "Building the web UI…"
  ( cd "$APP_DIR/frontend" && npm ci --no-audit --no-fund >/dev/null && npm run build >/dev/null )
  rm -rf "$APP_DIR/server/public"
  cp -a "$APP_DIR/frontend/dist" "$APP_DIR/server/public"
fi

chown -R root:root "$APP_DIR"

# The CLI needs to run as different users depending on the command
# (doctor/status/config work unprivileged; start/stop/restart/uninstall
# require root) — the script itself enforces that per-command, so the
# installed binary can be world-executable.
chmod 0755 "$APP_DIR/cli/sentinel.js"
ln -sf "$APP_DIR/cli/sentinel.js" /usr/local/bin/sentinel

# ── 8. Secrets ────────────────────────────────────────────────────────────────
if [ ! -f "$CONFIG_DIR/secret.key" ]; then
  log "Generating encryption secret…"
  gen_secret > "$CONFIG_DIR/secret.key"
fi
if [ ! -f "$CONFIG_DIR/agent.token" ]; then
  log "Generating agent bearer token…"
  gen_secret > "$CONFIG_DIR/agent.token"
fi
if [ ! -f "$CONFIG_DIR/jwt.key" ]; then
  log "Generating JWT secret…"
  gen_secret > "$CONFIG_DIR/jwt.key"
fi
chown root:"$SENTINEL_GROUP" "$CONFIG_DIR/secret.key" "$CONFIG_DIR/agent.token" "$CONFIG_DIR/jwt.key"
chmod 0640 "$CONFIG_DIR/secret.key" "$CONFIG_DIR/agent.token" "$CONFIG_DIR/jwt.key"

# ── 9. Environment files (only written once — never overwrite existing config) ─
if [ ! -f "$CONFIG_DIR/agent.env" ]; then
  log "Writing $CONFIG_DIR/agent.env…"
  cat > "$CONFIG_DIR/agent.env" <<EOF
SENTINEL_AGENT_SOCKET=/run/sentinel/agent.sock
SENTINEL_AGENT_TOKEN_PATH=$CONFIG_DIR/agent.token
HOST_PROC=/proc
HOST_SYS=/sys
DISK_TARGET=/
APPS_PATH=/srv/apps
CADDY_FILE=/etc/caddy/Caddyfile
CADDY_LOG=/var/log/caddy/access.log
DOCKER_SOCKET=/var/run/docker.sock
EOF
else
  log "$CONFIG_DIR/agent.env already exists — leaving it untouched."
fi

if [ ! -f "$CONFIG_DIR/server.env" ]; then
  log "Writing $CONFIG_DIR/server.env…"
  cat > "$CONFIG_DIR/server.env" <<EOF
JWT_SECRET=$(cat "$CONFIG_DIR/jwt.key")
NODE_ENV=production
PORT=3000
DB_PATH=$DATA_DIR/sentinel.db
SENTINEL_AGENT_SOCKET=/run/sentinel/agent.sock
SENTINEL_AGENT_TOKEN_PATH=$CONFIG_DIR/agent.token
EOF
else
  log "$CONFIG_DIR/server.env already exists — leaving it untouched."
fi
chown root:"$SENTINEL_GROUP" "$CONFIG_DIR/agent.env" "$CONFIG_DIR/server.env"
chmod 0640 "$CONFIG_DIR/agent.env" "$CONFIG_DIR/server.env"

# ── 10. systemd units ───────────────────────────────────────────────────────
log "Installing systemd units…"
cp "$SOURCE_DIR/packaging/systemd/sentinel-agent.service" "$SYSTEMD_DIR/sentinel-agent.service"
cp "$SOURCE_DIR/packaging/systemd/sentinel-server.service" "$SYSTEMD_DIR/sentinel-server.service"
systemctl daemon-reload
systemctl enable sentinel-agent sentinel-server >/dev/null 2>&1

# ── 11. Start ─────────────────────────────────────────────────────────────────
log "Starting Sentinel…"
systemctl restart sentinel-agent
sleep 1
systemctl restart sentinel-server
sleep 1

# ── 12. Health check ────────────────────────────────────────────────────────
PORT="$(env_get "$CONFIG_DIR/server.env" PORT)"
PORT="${PORT:-3000}"

HEALTH_OK=false
for _ in $(seq 1 10); do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    HEALTH_OK=true
    break
  fi
  sleep 1
done

if [ "$HEALTH_OK" != true ]; then
  warn "Server did not respond to a health check after 10s. Check: sentinel logs server"
fi
if ! systemctl is-active --quiet sentinel-agent; then
  warn "sentinel-agent is not active. Check: sentinel logs agent"
fi

# ── 13. Done ──────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════════════"
if [ "$EXISTING_INSTALL" = true ]; then
  echo " Sentinel updated."
else
  echo " Sentinel installed."
fi
echo "════════════════════════════════════════════════════════════════"
echo " Web UI:  http://localhost:${PORT}"
echo " Manage:  sentinel status | doctor | logs | restart"
echo ""
echo " First run? The server prints a one-time setup token and a /setup"
echo " URL on its first boot — find it with:"
echo "   sentinel logs server | grep -A2 'Setup token'"
echo "════════════════════════════════════════════════════════════════"
