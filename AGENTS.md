# CallTap Project Agent Memory

CallTap is a dual-track AI voice call recorder (`calltap` Python/FastAPI sidecar + React SPA in `web/`) paired with a containerized remote browser (`m1k1o/neko` + Chrome + PulseAudio), a Cloudflare Edge Wake + Serverless Worker (`deploy/cloudflare/`), and a GLTM observability stack (`deploy/observability/`).

## Quick Command Reference

- **Python tests & lint:** `.venv/bin/pytest -v` and `.venv/bin/ruff check calltap tests`
- **Frontend build:** `npm --prefix web run build` (bundles into `web/dist/`, copied/bundled into `calltap/web_dist` by Docker and served by Cloudflare Worker Assets when the VM is sleeping)
- **Worker tests & deploy:** `cd deploy/cloudflare && node --test wake-worker.test.mjs && npx cf deploy`

## Where to Look for Deployment & Live Issues

Before guessing during any deployment, auth, WebRTC, recording, or serverless issue, inspect these files and systems in order:

1. **Detailed Runbook & Architecture:** [`deploy/README.md`](deploy/README.md) (covers VM paths, secret map, deploy commands, and symptom-by-symptom troubleshooting) and [`deploy/cloudflare/README.md`](deploy/cloudflare/README.md).
2. **Compose & Container Wiring:** [`docker-compose.yml`](docker-compose.yml) (all 8 services: `neko`, `cloudflared`, `calltap`, `loki`, `tempo`, `mimir`, `alloy`, `grafana`).
3. **Cloudflare Edge (Worker / Routes / Access / Tunnel / KV):**
   - [`deploy/cloudflare/cloudflare.config.ts`](deploy/cloudflare/cloudflare.config.ts) & [`deploy/cloudflare/wake-worker.js`](deploy/cloudflare/wake-worker.js)
   - CLI inspection from `deploy/cloudflare/`: `cf zero-trust access applications list`, `cf zero-trust identity-providers list`, `cf zero-trust access logs access-requests list`, `cf tunnels list`, `cf tunnels config get 8286d507-38f0-43e4-a53b-b093a9a10f42`, `cf audit-logs list --per-page 30 --direction desc`.
4. **Azure VM (`calltap-vm`):**
   - Check power state without waking: `az vm get-instance-view -g CALLTAP-RG -n calltap-vm --query "instanceView.statuses[].code" -o tsv`
   - SSH (Tailscale, only when awake): `azureuser@100.73.14.5`, repo at `~/calltap`.
   - Host-level scripts/units: `/etc/calltap/{cloudflared-token,turn-key.env,idle.env}`, `/var/lib/calltap/turn.env`, `idleness.timer`, `turn-rotate.timer`.
5. **Observability (GLTM Stack):**
   - Configs live in [`deploy/observability/`](deploy/observability/) (`alloy/config.alloy`, `loki/`, `tempo/`, `mimir/`, `grafana/provisioning/`).
   - Grafana is exposed at `https://grafana.tuann04.cloud` behind Cloudflare Access Passkeys (SSO via `Cf-Access-Authenticated-User-Email` auth proxy, auto-wakes VM if sleeping) and also bound to `127.0.0.1:3000` on `calltap-vm` (`ssh -L 3000:127.0.0.1:3000 azureuser@100.73.14.5`).

## Critical Deployment Guardrails

1. **NEVER overwrite `/home/azureuser/calltap/.env` on `calltap-vm` from local `.env`:**
   - The VM `.env` holds VM-only secrets and settings: `NEKO_WEBRTC_NAT1TO1=100.73.14.5`, `NEKO_MEMBER_PROVIDER=oauth`, `NEKO_SESSION_COOKIE_ENABLED=true`, `NEKO_OAUTH_*` (Cloudflare Access OIDC), and `CALLTAP_CF_ACCESS_*`.
   - Always pass `--exclude='.env'` (plus `--exclude='data/'` and `--exclude='rclone/rclone.conf'`) when `rsync`ing to `calltap-vm`.
   - If Neko ever falls back to username/password login, check `sudo docker inspect calltap-neko-1` env vars and VM `.env` immediately.
2. **Use `sudo docker compose up -d --build --no-deps <service>` on the VM:**
   - `/var/lib/calltap/turn.env` is `0600 root:root`, so non-sudo `docker compose` fails.
   - `cloudflared` relies on `CLOUDFLARED_TOKEN` passed from `/etc/calltap/cloudflared-token` (not in `.env`); recreating `cloudflared` without `--no-deps` or without reading that file will disconnect the Tunnel.
3. **Respect the `$0/hr` VM sleep lifecycle:**
   - `idleness.timer` deallocates `calltap-vm` after 15m idle (`neko` listeners = 0, `calltap_calls_active` = 0, `calltap_pending_uploads` = 0).
   - If debugging requires waking a sleeping VM when the user didn't ask to leave it running, deallocate it via `POST https://call.tuann04.cloud/sleep` with `SLEEP_SECRET` from `/etc/calltap/idle.env` when done (or tell the user if left awake for testing).
4. **Test hygiene:**
   - Never mutate `DualTrackRecorder` class descriptors/properties in pytest (use instance stubs/fakes) so tests stay isolated.
