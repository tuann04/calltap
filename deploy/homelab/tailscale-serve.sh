#!/usr/bin/env bash
# Expose Neko (/) and CallTap dashboard (/calltap or separate port) over Tailscale HTTPS.
# Phone browsers require HTTPS for getUserMedia() microphone access.
set -euo pipefail

# Option A: Separate HTTPS ports on your tailnet hostname (cleanest, avoids subpath rewrites)
#   Neko:    https://<machine>.<tailnet>.ts.net/
#   CallTap: https://<machine>.<tailnet>.ts.net:8443/
tailscale serve --bg --https=443 http://127.0.0.1:8080
tailscale serve --bg --https=8443 http://127.0.0.1:8090

tailscale serve status
