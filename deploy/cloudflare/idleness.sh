#!/usr/bin/env bash
# Deallocate calltap-vm when it has been idle (no active neko WebRTC media
# listeners/pipelines, no active recording, no pending upload) for IDLE_MINUTES.
# Runs from idleness.timer on the VM host.
set -euo pipefail

IDLE_MINUTES="${IDLE_MINUTES:-15}"
IDLE_CHECK_MINUTES="${IDLE_CHECK_MINUTES:-5}"
STATE_FILE="${STATE_FILE:-/run/calltap/idle-state}"
NEKO_HOST="${NEKO_HOST:-http://127.0.0.1:8080}"
CALLTAP_HOST="${CALLTAP_HOST:-http://127.0.0.1:8090}"

mkdir -p "$(dirname "$STATE_FILE")"

# 1. Active neko WebRTC listeners / capture pipelines?
#    Neko uses Cloudflare Access OAuth in production (/api/sessions always returns
#    401 without a session), whereas /metrics on localhost is unauthenticated.
if ! NEKO_METRICS="$(curl -fsS --max-time 10 "${NEKO_HOST}/metrics" 2>/dev/null)"; then
  echo "neko ${NEKO_HOST}/metrics unreachable; not idle-safe, skipping shutdown"
  exit 0
fi

NEKO_PARSED="$(printf '%s\n' "$NEKO_METRICS" | awk '
  /^neko_capture_streamsink_listeners[{ ]/ { seen=1; if ($NF + 0 > 0) active += $NF + 0 }
  /^neko_webrtc_video_listeners[{ ]/        { seen=1; if ($NF + 0 > 0) active += $NF + 0 }
  /^neko_capture_pipelines_active[{ ]/     { seen=1; if ($NF + 0 > 0) active += $NF + 0 }
  END { printf "%d %d\n", seen+0, active+0 }
')"
read -r NEKO_SEEN NEKO_ACTIVE <<< "$NEKO_PARSED"
if [ "$NEKO_SEEN" -eq 0 ]; then
  echo "neko metrics missing expected gauges; not idle-safe, skipping shutdown"
  exit 0
fi

# 2. Active call recording or pending cloud uploads?
if ! CALLTAP_METRICS="$(curl -fsS --max-time 10 "${CALLTAP_HOST}/metrics" 2>/dev/null)"; then
  echo "calltap ${CALLTAP_HOST}/metrics unreachable; not idle-safe, skipping shutdown"
  exit 0
fi

CALLTAP_PARSED="$(printf '%s\n' "$CALLTAP_METRICS" | awk '
  /^calltap_calls_active([ {]|$)/    { seen_calls=1; calls = $NF + 0 }
  /^calltap_pending_uploads([ {]|$)/ { seen_uploads=1; pending = $NF + 0 }
  END { printf "%d %d %d %d\n", seen_calls+0, seen_uploads+0, calls+0, pending+0 }
')"
read -r SEEN_CALLS SEEN_UPLOADS ACTIVE_CALLS PENDING_UPLOADS <<< "$CALLTAP_PARSED"
if [ "$SEEN_CALLS" -eq 0 ] || [ "$SEEN_UPLOADS" -eq 0 ]; then
  echo "calltap metrics missing expected gauges; not idle-safe, skipping shutdown"
  exit 0
fi

if [ "$NEKO_ACTIVE" -gt 0 ] || [ "$ACTIVE_CALLS" -gt 0 ] || [ "$PENDING_UPLOADS" -gt 0 ]; then
  echo "active(neko=$NEKO_ACTIVE calls=$ACTIVE_CALLS pending_uploads=$PENDING_UPLOADS) -> reset idle timer"
  printf '0\n' > "$STATE_FILE"
  exit 0
fi

MINUTES="$(cat "$STATE_FILE" 2>/dev/null || echo 0)"
MINUTES=$((MINUTES + IDLE_CHECK_MINUTES))
printf '%s\n' "$MINUTES" > "$STATE_FILE"
echo "idle for ~${MINUTES} min (threshold ${IDLE_MINUTES} min)"

if [ "$MINUTES" -ge "$IDLE_MINUTES" ]; then
  if [ -z "${WAKE_WORKER_URL:-}" ]; then
    echo "idle threshold reached, but WAKE_WORKER_URL is unset; skipping shutdown"
    exit 0
  fi
  if [ -z "${SLEEP_SECRET:-}" ]; then
    echo "idle threshold reached, but SLEEP_SECRET is unset; skipping shutdown"
    exit 0
  fi
  echo "idle threshold reached; calling ${WAKE_WORKER_URL}/sleep"
  if RESP="$(curl -fsS --max-time 15 -X POST \
    -H "Authorization: Bearer ${SLEEP_SECRET}" \
    "${WAKE_WORKER_URL}/sleep")"; then
    echo "deallocate response: ${RESP}"
    rm -f "$STATE_FILE"
  else
    echo "warning: ${WAKE_WORKER_URL}/sleep failed; will retry on next check"
  fi
fi
