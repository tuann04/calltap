#!/usr/bin/env bash
# One-time VM setup for the Cloudflare deployment. Run from the repo root on the VM:
#   sudo ./deploy/cloudflare/setup-vm.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "== 1. cloudflared token"
TOKEN_FILE=/etc/calltap/cloudflared-token
mkdir -p /etc/calltap
if [ ! -s "$TOKEN_FILE" ]; then
  echo "Paste the tunnel token (cf tunnels token calltap):"
  read -r TOKEN
  printf '%s' "$TOKEN" > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
fi

echo "== 2. TURN key credentials"
TURN_FILE=/etc/calltap/turn-key.env
if [ ! -s "$TURN_FILE" ]; then
  echo "Paste TURN_KEY_ID and TURN_API_TOKEN lines (cf realtime turn keys list):"
  cat > "$TURN_FILE"
  chmod 600 "$TURN_FILE"
fi
. "$TURN_FILE"

echo "== 3. install scripts and units"
install -m 755 "$REPO_DIR/deploy/cloudflare/turn-rotate.sh" /usr/local/bin/turn-rotate.sh
install -m 755 "$REPO_DIR/deploy/cloudflare/idleness.sh" /usr/local/bin/idleness.sh
install -m 644 "$REPO_DIR/deploy/cloudflare/turn-rotate.service" /etc/systemd/system/turn-rotate.service
install -m 644 "$REPO_DIR/deploy/cloudflare/turn-rotate.timer" /etc/systemd/system/turn-rotate.timer
install -m 644 "$REPO_DIR/deploy/cloudflare/idleness.service" /etc/systemd/system/idleness.service
install -m 644 "$REPO_DIR/deploy/cloudflare/idleness.timer" /etc/systemd/system/idleness.timer

echo "== 4. idle config"
if [ ! -s /etc/calltap/idle.env ]; then
  if [ -z "${WAKE_WORKER_URL:-}" ]; then
    echo "Wake worker URL (e.g. https://call.example.com):"
    read -r WAKE_WORKER_URL
  fi
  if [ -z "${SLEEP_SECRET:-}" ]; then
    echo "Paste SLEEP_SECRET (must match calltap-wake Worker secret):"
    read -rs SLEEP_SECRET
    echo ""
  fi
  cat > /etc/calltap/idle.env <<EOF
IDLE_MINUTES=15
IDLE_CHECK_MINUTES=5
NEKO_HOST=http://127.0.0.1:8080
CALLTAP_HOST=http://127.0.0.1:8090
WAKE_WORKER_URL=${WAKE_WORKER_URL}
SLEEP_SECRET=${SLEEP_SECRET}
EOF
  chmod 600 /etc/calltap/idle.env
fi

echo "== 5. boot without network wait deadlock"
mkdir -p /etc/systemd/system/systemd-networkd-wait-online.service.d
cat > /etc/systemd/system/systemd-networkd-wait-online.service.d/override.conf <<'EOF'
[Service]
TimeoutStartSec=20
EOF

systemctl daemon-reload
systemctl enable --now turn-rotate.timer idleness.timer
systemctl start turn-rotate.service

echo "== 6. start cloudflared container"
cd "$REPO_DIR"
CLOUDFLARED_TOKEN="$(cat "$TOKEN_FILE")" docker compose up -d cloudflared
docker compose ps cloudflared
echo "done; check: docker logs calltap-cloudflared-1"
