#!/usr/bin/env bash
# Takes a Raspberry Pi with Signal K installed to a running Data Hub.
# Safe to re-run: every step checks before it changes anything.
#
#   sudo deploy/install.sh            (run from a checkout of this repo)
#
# Internet is needed at install time only (apt and npm packages). The running
# Data Hub makes no internet calls.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_USER=datahub
DATA_DIR=/var/lib/data-hub
APP_DIR=/opt/data-hub
ETC_DIR=/etc/data-hub
NODE_MAJOR=22
HOST="$(hostname)"

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root (sudo)"
[[ "$(uname -m)" == "aarch64" ]] || echo "warning: expected a 64-bit Pi (aarch64), found $(uname -m)"

if ! systemctl list-unit-files signalk.service >/dev/null 2>&1; then
  echo "warning: signalk.service not found. Install Signal K first; Data Hub will keep retrying until it is up."
fi

log "System packages"
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg chrony gpiod debian-keyring debian-archive-keyring apt-transport-https >/dev/null

if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt $NODE_MAJOR ]]; then
  log "Node.js $NODE_MAJOR"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y -qq nodejs >/dev/null
fi
command -v pnpm >/dev/null || npm install -g pnpm@10 >/dev/null

if ! command -v caddy >/dev/null; then
  log "Caddy"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
fi

log "User and directories"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$APP_USER"
usermod -aG gpio "$APP_USER" 2>/dev/null || true
install -d -o "$APP_USER" -g "$APP_USER" -m 0750 "$DATA_DIR" "$DATA_DIR/files" "$DATA_DIR/backups"
install -d -o "$APP_USER" -g "$APP_USER" -m 0700 "$DATA_DIR/config"
install -d -m 0755 "$APP_DIR/releases" "$ETC_DIR" "$ETC_DIR/public"

if [[ ! -f "$ETC_DIR/data-hub.env" ]]; then
  cat > "$ETC_DIR/data-hub.env" <<EOF
SIGNALK_URL=http://127.0.0.1:3000
HOST=127.0.0.1
PORT=8080
DATA_DIR=$DATA_DIR
CONFIG_DIR=$DATA_DIR/config
WEB_DIST=$APP_DIR/current/web
NODE_ENV=production
EOF
fi

log "Build and install the release"
VERSION="$(node -p "require('$REPO_DIR/package.json').version || '0.1.0'")-$(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M)"
RELEASE="$APP_DIR/releases/$VERSION"
if [[ ! -d "$RELEASE" ]]; then
  (cd "$REPO_DIR" && pnpm install --frozen-lockfile && pnpm --filter @watchkeeper/server build && pnpm --filter @watchkeeper/web build)
  install -d "$RELEASE"
  (cd "$REPO_DIR" && pnpm --filter @watchkeeper/server deploy --legacy --prod "$RELEASE/server")
  cp -r "$REPO_DIR/apps/server/dist" "$RELEASE/server/dist"
  cp -r "$REPO_DIR/apps/web/dist" "$RELEASE/web"
fi
ln -sfn "$RELEASE" "$APP_DIR/current"

log "systemd service"
install -m 0644 "$REPO_DIR/deploy/systemd/data-hub.service" /etc/systemd/system/data-hub.service
systemctl daemon-reload
systemctl enable data-hub.service >/dev/null
systemctl restart data-hub.service

log "Caddy (HTTPS on $HOST.local)"
sed "s/HOSTNAME/$HOST/g" "$REPO_DIR/deploy/caddy/Caddyfile" > /etc/caddy/Caddyfile.datahub
if ! cmp -s /etc/caddy/Caddyfile.datahub /etc/caddy/Caddyfile; then
  [[ -f /etc/caddy/Caddyfile && ! -f /etc/caddy/Caddyfile.orig ]] && cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.orig
  mv /etc/caddy/Caddyfile.datahub /etc/caddy/Caddyfile
  systemctl reload caddy || systemctl restart caddy
else
  rm /etc/caddy/Caddyfile.datahub
fi

CA=/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt
for _ in $(seq 1 20); do [[ -f "$CA" ]] && break; sleep 1; done
[[ -f "$CA" ]] && install -m 0644 "$CA" "$ETC_DIR/public/ca.crt"

log "Hardware watchdog"
CONFIG_TXT=/boot/firmware/config.txt
[[ -f $CONFIG_TXT ]] || CONFIG_TXT=/boot/config.txt
grep -q '^dtparam=watchdog=on' "$CONFIG_TXT" 2>/dev/null || echo 'dtparam=watchdog=on' >> "$CONFIG_TXT"
install -d /etc/systemd/system.conf.d
cat > /etc/systemd/system.conf.d/watchdog.conf <<EOF
[Manager]
RuntimeWatchdogSec=15
RebootWatchdogSec=2min
EOF

log "Clock"
systemctl enable --now chrony >/dev/null
echo "chrony is installed. Configure the GPS refclock for your receiver (see DECISIONS.md) and fit the Pi 5 RTC battery."

log "Done"
cat <<EOF
Data Hub:      https://$HOST.local
Root CA:       https://$HOST.local/ca.crt  (install and trust it once on each phone and laptop)
               or copy $ETC_DIR/public/ca.crt
Service logs:  journalctl -u data-hub -f
Signal K:      approve "Data Hub (backend)" and "Data Hub (browsers, read only)" under
               Security > Access Requests in the Signal K admin UI if security is enabled.
EOF
