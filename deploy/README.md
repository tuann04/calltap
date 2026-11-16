# CallTap Deployment & Troubleshooting Runbook

Detailed deployment layout, secret/config inventory, deploy procedures, and symptom-based troubleshooting runbooks for CallTap.

For Cloudflare-specific setup scripts and Worker configuration, also see [`deploy/cloudflare/README.md`](cloudflare/README.md).

---

## 1. Architecture & Where Everything Lives

### Production Topology (Cloudflare + Azure VM)

| Layer | Component | Host / Path | Purpose |
|---|---|---|---|
| **Edge Auth** | Cloudflare Access (`tuann04.cloudflareaccess.com`) | Apps: `CallTap Neko`, `CallTap Neko OIDC`, `CallTap Dashboard`, `CallTap Grafana`, `CallTap Wake`, `CallTap Wake Sleep` | Passkey / OTP gate in front of all endpoints + OIDC provider for Neko (`NEKO_MEMBER_PROVIDER=oauth`) + auth proxy header (`Cf-Access-Authenticated-User-Email`) for Grafana. |
| **Edge Compute & Serverless UI** | Cloudflare Worker `calltap-wake` | [`deploy/cloudflare/wake-worker.js`](cloudflare/wake-worker.js), [`deploy/cloudflare/cloudflare.config.ts`](cloudflare.config.ts) | Routes `call.tuann04.cloud/*` (VM wake/sleep), `neko.tuann04.cloud/` & `grafana.tuann04.cloud/` (wake redirect when VM sleeps), and `calltap.tuann04.cloud/*` (edge KV/R2 audio & waveform fast-path + serverless SPA from `web/dist` when VM sleeps). |
| **Edge Storage** | Cloudflare KV (`CALLS_KV`) + optional R2 (`CALLS_BUCKET`) | KV namespace bound in `cloudflare.config.ts` | Stores synced `calls/<YYYY>/<MM>/<DD>/<id>/{meta.json,peaks.json,mix.opus}` for `$0/hr` playback when the VM is deallocated. |
| **Tunnel** | Cloudflare Tunnel `calltap` (`8286d507-38f0-43e4-a53b-b093a9a10f42`) | Container `calltap-cloudflared-1` | Routes `neko.tuann04.cloud -> http://neko:8080`, `calltap.tuann04.cloud -> http://calltap:8090`, and `grafana.tuann04.cloud -> http://grafana:3000`. |
| **VM Compute** | Azure VM `calltap-vm` (`CALLTAP-RG`, Tailscale `100.73.14.5`, no public IP) | SSH: `azureuser@100.73.14.5`, Repo: `~/calltap` | Runs Docker Compose stack (`neko`, `calltap`, `cloudflared`, `loki`, `tempo`, `mimir`, `alloy`, `grafana`). Auto-deallocates after 15m idle. |

### VM-Only State (Not in Git — Never Overwrite!)

| Location on `calltap-vm` | Contents | Owner / Notes |
|---|---|---|
| `/home/azureuser/calltap/.env` | `NEKO_USER_PASSWORD`, `NEKO_ADMIN_PASSWORD`, `NEKO_WEBRTC_NAT1TO1=100.73.14.5`, **`NEKO_MEMBER_PROVIDER=oauth`**, **`NEKO_SESSION_COOKIE_ENABLED=true`**, **`NEKO_OAUTH_*`**, **`CALLTAP_CF_ACCESS_*`** | **CRITICAL:** Local `.env` may differ (`NAT1TO1`, missing OAuth vars). Always `--exclude='.env'` when syncing! |
| `/etc/calltap/cloudflared-token` | Cloudflare Tunnel token | Read at setup / manual `cloudflared` recreate (`root:root 600`). |
| `/etc/calltap/turn-key.env` | `TURN_KEY_ID`, `TURN_API_TOKEN` | Used by `/usr/local/bin/turn-rotate.sh` (`root:root 600`). |
| `/etc/calltap/idle.env` | `IDLE_MINUTES=15`, `WAKE_WORKER_URL`, `SLEEP_SECRET` | Used by `/usr/local/bin/idleness.sh` (`root:root 600`). `SLEEP_SECRET` must match Worker secret. |
| `/var/lib/calltap/turn.env` | `NEKO_TURN_FRONTEND`, `NEKO_TURN_BACKEND` | Rotated daily at `03:10 UTC` + boot by `turn-rotate.timer` (`root:root 600`). Requires `sudo docker compose ...` to read! |
| Docker volumes | `chrome_profile`, `pulse_sock`, `loki_data`, `tempo_data`, `mimir_data`, `alloy_data`, `grafana_data` | Persistent Chrome login + PulseAudio socket + GLTM telemetry data. |
| Bind mounts | `./data` (`/data/calls`, `/data/calltap.db`), `./rclone` (`/config/rclone/rclone.conf`) | Local recordings, SQLite outbox, rclone storage config. |

### Observability Stack (GLTM)

All five observability containers run inside [`docker-compose.yml`](../docker-compose.yml) using configs in [`deploy/observability/`](observability/):

- **Grafana (`calltap-grafana-1`)**: Publicly routed at **`https://grafana.tuann04.cloud`** behind Cloudflare Access (Passkeys) with auto-wake when the VM sleeps and SSO via `GF_AUTH_PROXY_*` (`Cf-Access-Authenticated-User-Email`), and also bound to `127.0.0.1:3000` on `calltap-vm` (`admin` / `calltap-grafana` for SSH tunnel fallback). Pre-provisioned dashboard: [`calltap-neko.json`](observability/grafana/provisioning/dashboards/calltap-neko.json).
- **Alloy (`calltap-alloy-1`)**: Configured in [`config.alloy`](observability/alloy/config.alloy). Ships Docker container JSON logs to **Loki**, scrapes `vm-host`, `neko:8080/metrics`, `calltap:8090/metrics`, and `alloy:12345` to **Mimir**, and receives OTLP traces (`4317`/`4318`) from `calltap` -> **Tempo**.

**How to open Grafana:**

- **Browser (anywhere, Passkey SSO):** `https://grafana.tuann04.cloud` (auto-wakes VM if sleeping)
- **SSH tunnel fallback:** `ssh -L 3000:127.0.0.1:3000 azureuser@100.73.14.5` -> `http://127.0.0.1:3000`

---

## 2. Standard Deployment Procedures

### A. Deploy Backend / Neko / Compose Changes to `calltap-vm`

> [!CAUTION]
> Always exclude `.env`, `data/`, and `rclone/rclone.conf` when running `rsync`, and pass `--no-deps` when recreating only `calltap` or `neko` (otherwise `cloudflared` may recreate without `CLOUDFLARED_TOKEN` in shell env). Use `sudo docker compose` because `/var/lib/calltap/turn.env` is `root`-readable only.

```bash
# 1. Verify tests & lint locally first
.venv/bin/pytest -v
.venv/bin/ruff check calltap tests

# 2. Rebuild frontend bundle if web/ changed (Dockerfile copies web/dist or builds it)
npm --prefix web run build

# 3. Sync code to VM (preserving VM .env, data, rclone)
rsync -az --delete \
  --exclude='.git' --exclude='.venv' --exclude='node_modules' \
  --exclude='.env' --exclude='data/' --exclude='rclone/rclone.conf' \
  --exclude='.cloudflare/' --exclude='.pytest_cache/' --exclude='.ruff_cache/' \
  /home/tuan/Tools/calltap/ azureuser@100.73.14.5:~/calltap/

# 4. Rebuild & restart target service(s) on VM
ssh azureuser@100.73.14.5 'cd ~/calltap && sudo docker compose up -d --build --no-deps calltap'
# Or for both neko and calltap:
ssh azureuser@100.73.14.5 'cd ~/calltap && sudo docker compose up -d --build --no-deps neko calltap'
```

If `cloudflared` itself needs to be recreated, pass the token from `/etc/calltap/cloudflared-token`:

```bash
ssh azureuser@100.73.14.5 'cd ~/calltap && sudo bash -c "CLOUDFLARED_TOKEN=\$(cat /etc/calltap/cloudflared-token) docker compose up -d --no-deps cloudflared"'
```

### B. Deploy Frontend & Cloudflare Edge Worker (`calltap-wake`)

```bash
# 1. Build React SPA (serves both the VM dashboard and serverless offline mode)
npm --prefix web run build

# 2. Run Worker unit tests
cd deploy/cloudflare
node --test wake-worker.test.mjs

# 3. Deploy Worker + Static Assets
npx cf deploy
```

> [!NOTE]
> Make sure the VM is awake and `calltap` rebuilt if you also want the live-VM dashboard to serve the updated `web/dist`.

### C. Put `calltap-vm` Back to Sleep Manually (`$0/hr`)

```bash
ssh azureuser@100.73.14.5 'sudo bash -c "set -a; source /etc/calltap/idle.env; curl -fsS -X POST -H \"Authorization: Bearer \$SLEEP_SECRET\" \"\${WAKE_WORKER_URL}/sleep\""'
```

---

## 3. Troubleshooting Runbook

### 1. Neko asks for Username/Password instead of Passkey (OIDC) Login

**Symptoms:** Opening `https://neko.tuann04.cloud` passes Cloudflare Access, then shows Neko's built-in password box instead of redirecting to `tuann04.cloudflareaccess.com` OIDC.

**Checks:**
```bash
# 1. Check live Neko container environment on VM
ssh azureuser@100.73.14.5 'sudo docker inspect calltap-neko-1 --format "{{json .Config.Env}}" | tr "," "\n" | grep -E "NEKO_MEMBER|NEKO_OAUTH|NEKO_SESSION"'

# 2. Test Neko OAuth redirect locally on VM
ssh azureuser@100.73.14.5 'curl -sS -D - -o /dev/null -H "Host: neko.tuann04.cloud" -H "X-Forwarded-Proto: https" http://127.0.0.1:8080/api/oauth/login'

# 3. Check Cloudflare Access SaaS app ("CallTap Neko OIDC")
cd deploy/cloudflare && cf zero-trust access applications list | grep -A 35 "CallTap Neko OIDC"
```

**Fix:**
- Ensure `/home/azureuser/calltap/.env` on `calltap-vm` contains:
  - `NEKO_MEMBER_PROVIDER=oauth`
  - `NEKO_SESSION_COOKIE_ENABLED=true`
  - `NEKO_OAUTH_ENABLED=true`
  - `NEKO_OAUTH_AUTO_REDIRECT=true`
  - `NEKO_OAUTH_CLIENT_ID`, `NEKO_OAUTH_CLIENT_SECRET`, `NEKO_OAUTH_ISSUER_URL`, `NEKO_OAUTH_REDIRECT_URL=https://neko.tuann04.cloud/api/oauth/callback`, `NEKO_OAUTH_ADMIN_EMAILS`, `NEKO_OAUTH_USER_EMAILS`
- Recreate `neko`: `sudo docker compose up -d --no-deps neko`.
- **Note:** If `"OAuth redirect_uri host does not match the login request host"` appears in `neko` logs, ensure requests arrive with `Host: neko.tuann04.cloud` (via Tunnel, or pass `-H "Host: neko.tuann04.cloud"` when curling localhost).

---

### 2. Cloudflare Access / Passkey Prompt Issues

**Checks:**
```bash
cd deploy/cloudflare
cf zero-trust identity-providers list
cf zero-trust access applications list
cf zero-trust access users list
cf zero-trust access logs access-requests list | head -n 60
```

- Verify `allowed_idps` on `CallTap Neko`, `CallTap Dashboard`, and `CallTap Wake` includes the Passkeys IdP UUID (`1cfcf42d-c00a-429d-986e-fe8085fb07f9`).
- Verify `CallTap Dashboard` (`calltap.tuann04.cloud`) JWT verification in VM `.env`: `CALLTAP_CF_ACCESS_TEAM`, `CALLTAP_CF_ACCESS_AUD`, `CALLTAP_CF_ACCESS_ALLOWED_EMAILS`.

---

### 3. Call Stays Stuck Recording After Hanging Up in Mobile UI

**Symptoms:** Dashboard continues showing `Recording...` after ending the call on Sesame/Gemini or closing the Neko mobile tab.

**Checks:**
```bash
ssh azureuser@100.73.14.5 '
  echo "=== CallTap metrics ==="
  curl -sS http://127.0.0.1:8090/metrics | grep -E "calltap_(calls_active|pulse_healthy)"
  echo "=== Neko listeners ==="
  curl -sS http://127.0.0.1:8080/metrics | grep -E "^neko_(capture_streamsink_listeners|webrtc_video_listeners)"
  echo "=== PulseAudio source-outputs ==="
  sudo docker exec calltap-calltap-1 pactl list source-outputs
  echo "=== CallTap logs ==="
  sudo docker logs calltap-calltap-1 --tail 40
'
```

**Tuning (`.env`):**
- `CALLTAP_SILENCE_STOP_SECONDS` (default `20`): auto-stops when both tracks stay below `CALLTAP_SILENCE_THRESHOLD_DB` (default `-55` dB).
- `CALLTAP_NEKO_DISCONNECT_STOP_SECONDS` (default `10`): auto-stops when Neko reports `0` active WebRTC listeners.
- Force stop immediately via API/UI (`POST /api/calls/stop`), which suppresses auto-retrigger on the same Chrome `Source Output`.

---

### 4. WebRTC Audio/Video Fails to Connect or Drops

**Checks:**
```bash
ssh azureuser@100.73.14.5 '
  sudo systemctl status turn-rotate.timer turn-rotate.service --no-pager
  sudo docker inspect calltap-neko-1 --format "{{json .Config.Env}}" | tr "," "\n" | grep -E "NAT1TO1|ICESERVERS|UDPMUX|ICELITE"
  sudo docker logs calltap-neko-1 --tail 50
'
```

**Common Causes:**
- `NEKO_WEBRTC_NAT1TO1` in VM `.env` overwritten with workstation IP instead of VM's Tailscale IP (`100.73.14.5`).
- Expired TURN credentials in `/var/lib/calltap/turn.env` (run `sudo systemctl start turn-rotate.service && cd ~/calltap && sudo docker compose up -d --no-deps neko`).

---

### 5. VM Won't Wake, Tunnel Returns 530/502, or VM Won't Auto-Sleep

**Checks:**
```bash
# Check Azure VM power state from workstation
az vm get-instance-view -g CALLTAP-RG -n calltap-vm --query "instanceView.statuses[].code" -o tsv

# Check Cloudflare Tunnel health from workstation
cf tunnels list

# On VM: check cloudflared & idleness timer
ssh azureuser@100.73.14.5 '
  sudo docker logs calltap-cloudflared-1 --tail 30
  sudo systemctl status idleness.timer idleness.service --no-pager
  sudo journalctl -u idleness.service -n 30 --no-pager
  cat /run/calltap/idle-state 2>/dev/null || echo "no idle-state"
'
```

**Common Causes:**
- `idleness.sh` never reaches 15m idle if `calltap_calls_active > 0` (stuck recording), `calltap_pending_uploads > 0`, or `neko_capture_streamsink_listeners > 0`.
- `POST /sleep` returns `401 Unauthorized` if `SLEEP_SECRET` in `/etc/calltap/idle.env` does not match the Worker secret `SLEEP_SECRET` (`cf workers secrets list` in `deploy/cloudflare`).

---

### 6. Serverless Dashboard (`calltap.tuann04.cloud` When VM Sleeps) Issues

**Symptoms:** Calls missing when VM sleeps, audio won't play/seek, or page layout broken.

**Checks:**
- Confirm Worker triggers and bindings in [`deploy/cloudflare/cloudflare.config.ts`](cloudflare/cloudflare.config.ts) (`CALLS_KV` namespace `a76b15c391104d34a9c5f3cbf5bea9c3`, or `CALLS_BUCKET` if R2 is enabled).
- Check recent Worker deployment & routes via `cf audit-logs list --per-page 20 --direction desc`.
- Inspect KV contents in `deploy/cloudflare`:
  ```bash
  npx cf kv keys list --namespace-id a76b15c391104d34a9c5f3cbf5bea9c3 --prefix calls/
  ```
- If `index.json` in KV is stale after manual uploads, delete `calls/index.json` so [`wake-worker.js`](cloudflare/wake-worker.js) rebuilds/falls back cleanly.

---

### 7. Inspecting Logs, Metrics & Traces (Observability)

```bash
# Quick container logs on VM
ssh azureuser@100.73.14.5 'cd ~/calltap && sudo docker compose logs --tail=80 calltap neko cloudflared'

# Query Mimir / Loki / Tempo directly inside alloy/grafana network or via Grafana UI
ssh -L 3000:127.0.0.1:3000 azureuser@100.73.14.5
# Open http://127.0.0.1:3000 -> Dashboards -> CallTap & Neko, or Explore (Loki / Mimir / Tempo)
```
