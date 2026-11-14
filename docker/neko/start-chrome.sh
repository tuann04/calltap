#!/usr/bin/env bash
set -euo pipefail

PROFILE_DIR="/home/neko/.config/calltap-chrome"
DEFAULT_DIR="${PROFILE_DIR}/Default"
PREFS_FILE="${DEFAULT_DIR}/Preferences"
SEED_FILE="/etc/neko/chrome-preferences.seed.json"

mkdir -p "${DEFAULT_DIR}"

# Clean stale Chromium singleton locks if container restarted or changed hostname
rm -f "${PROFILE_DIR}/SingletonLock" "${PROFILE_DIR}/SingletonCookie" "${PROFILE_DIR}/SingletonSocket"

if [ ! -f "${PREFS_FILE}" ] && [ -f "${SEED_FILE}" ]; then
  cp "${SEED_FILE}" "${PREFS_FILE}"
elif [ -f "${PREFS_FILE}" ]; then
  python3 - "${PREFS_FILE}" <<'PY'
import json, sys
path = sys.argv[1]
try:
    data = json.load(open(path, "r", encoding="utf-8"))
except Exception:
    data = {}
prof = data.setdefault("profile", {})
vals = prof.setdefault("default_content_setting_values", {})
vals["cookies"] = 1
vals["media_stream_mic"] = 1
data.setdefault("signin", {})["allowed"] = True
with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f)
PY
fi

exec /usr/bin/google-chrome \
  --no-sandbox \
  --window-position=0,0 \
  --display="${DISPLAY:-:99.0}" \
  --user-data-dir="${PROFILE_DIR}" \
  --no-first-run \
  --no-default-browser-check \
  --start-maximized \
  --autoplay-policy=no-user-gesture-required \
  --remote-debugging-address=0.0.0.0 \
  --remote-debugging-port=9222 \
  --remote-allow-origins=* \
  --disable-gpu \
  --disable-software-rasterizer \
  --disable-dev-shm-usage \
  "https://app.sesame.com"
