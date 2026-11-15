#!/usr/bin/env bash
# Deallocate calltap-vm when it has been idle (no active neko WebRTC session,
# no pending upload) for IDLE_MINUTES. Runs from the idleness.timer on the VM.
set -euo pipefail

IDLE_MINUTES="${IDLE_MINUTES:-15}"
STATE_FILE="${STATE_FILE:-/var/lib/calltap/idle-state}"

# 1. Active neko sessions?
#    /api/sessions returns 401 without auth, so authenticate like the dashboard does.
NEKO_HOST="${NEKO_HOST:-http://neko:8080}"
SESSIONS=""
if [ -n "${NEKO_USER_PASSWORD:-}" ]; then
  # Password auth: neko multiuser login endpoint.
  SESSIONS="$(curl -fsS --max-time 10 -X POST "${NEKO_HOST}/api/login" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"admin\",\"password\":\"${NEKO_USER_PASSWORD}\"}" 2>/dev/null || true)"
fi
if [ -z "$SESSIONS" ]; then
  # Fallback: unauthenticated request; a 401 means nobody is logged in.
  CODE="$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "${NEKO_HOST}/api/sessions" || true)"
  if [ "$CODE" = "401" ]; then
    SESSIONS=""
  else
    echo "neko /api/sessions returned HTTP $CODE; not idle-safe, skipping shutdown"
    exit 0
  fi
fi
# neko login returns member info; a successful login by the script does not mean
# a human has a session. Count active WebRTC peers from the metrics endpoint if
# available, else treat "login worked and no other members" as idle.
ACTIVE="$(echo "$SESSIONS" | jq '[.[]? | select(.connected)] | length' 2>/dev/null || echo 0)"

# 2. Pending uploads (calltap uploader still working)?
PENDING="$(curl -fsS --max-time 10 -H "X-Idle-Probe: 1" http://calltap:8090/api/status 2>/dev/null \
  | jq -r '.uploading // .pending_uploads // 0' 2>/dev/null || echo 0)"

if [ "${ACTIVE:-0}" -gt 0 ] || [ "${PENDING:-0}" -gt 0 ]; then
  echo "active(ACTIVE=$ACTIVE PENDING=$PENDING) -> reset idle timer"
  printf '0\n' > "$STATE_FILE"
  exit 0
fi

MINUTES="$(cat "$STATE_FILE" 2>/dev/null || echo 0)"
MINUTES=$((MINUTES + IDLE_CHECK_MINUTES))
printf '%s\n' "$MINUTES" > "$STATE_FILE"
echo "idle for ~${MINUTES} min"

if [ "$MINUTES" -ge "$IDLE_MINUTES" ]; then
  echo "idle threshold reached; deallocating VM"
  rm -f "$STATE_FILE"
  # From inside the VM we cannot deallocate ourselves; notify the wake Worker.
  if [ -n "${WAKE_WORKER_URL:-}" ]; then
    curl -fsS --max-time 10 -X POST "${WAKE_WORKER_URL}/sleep" >/dev/null 2>&1 || true
  fi
  exit 0
fi
