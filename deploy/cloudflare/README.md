# Cloudflare Deployment (`example.com`)

Public entry points for CallTap, no Tailscale required on the client:

| URL | Service | Path |
|---|---|---|
| `https://neko.example.com` | neko remote browser (:8080) | Cloudflare Access -> Cloudflare Tunnel -> `http://neko:8080` (auto-wakes VM if sleeping) |
| `https://calltap.example.com` | CallTap dashboard (:8090 / R2 Edge) | Cloudflare Access -> Worker Static Assets + R2 when VM is sleeping, or Cloudflare Tunnel -> `http://calltap:8090` when VM is awake |
| `https://grafana.example.com` | Grafana observability (:3000) | Cloudflare Access -> Cloudflare Tunnel -> `http://grafana:3000` (auto-wakes VM if sleeping) |
| `https://call.example.com` | 1-tap wake Worker | Cloudflare Access -> Cloudflare Worker -> Azure API |

## Authentication (Cloudflare Access + Passkeys + SSO)

`neko.`, `calltap.`, `grafana.`, and `call.` sit behind Cloudflare Access (Zero Trust, free tier).
Logging in requires a passkey (Face ID / fingerprint) or an emailed one-time PIN,
both restricted to the account owner's email. After authenticating with Access,
no in-app password is needed:

- **Neko (`neko.example.com`)** uses Cloudflare Access OIDC (`CallTap Neko OIDC` app,
  `NEKO_MEMBER_PROVIDER=oauth`, `NEKO_SESSION_COOKIE_ENABLED=true`) and grants admin
  access to `owner@example.com`.
- **CallTap (`calltap.example.com`)** verifies the `Cf-Access-Jwt-Assertion` header
  against `<team>.cloudflareaccess.com/cdn-cgi/access/certs` (`CALLTAP_CF_ACCESS_*`)
  and keeps Basic Auth as a fallback for direct/local access.
- **Grafana (`grafana.example.com`)** uses Grafana Auth Proxy (`GF_AUTH_PROXY_ENABLED=true`)
  trusting `Cf-Access-Authenticated-User-Email` injected at the Cloudflare Edge after Access
  verification, with auto sign-up as `Admin` (`127.0.0.1:3000` remains bound only to localhost).
- **Wake Worker (`call.example.com`)** is protected by Cloudflare Access (`GET /`, `GET /status`)
  with a path-specific Access bypass on `call.example.com/sleep` so `idleness.sh` can call
  `POST /sleep` using `Authorization: Bearer <SLEEP_SECRET>`.

Config (created via `cf`):

- IdP: `passkeys` (auto-prompt on), uid `<passkeys-idp-uid>`
- App `CallTap Neko` -> `neko.example.com`, 24h session
- App `CallTap Neko OIDC` -> SaaS OIDC for `https://neko.example.com/api/oauth/callback`
- App `CallTap Dashboard` -> `calltap.example.com`, 24h session
- App `CallTap Grafana` -> `grafana.example.com`, 24h session
- App `CallTap Wake` -> `call.example.com`, 24h session (plus `Bypass` app for `call.example.com/sleep`)
- Policy on allow apps: allow email `owner@example.com`

To enroll a passkey: open `https://neko.example.com` in Safari, choose
"Sign in with a passkey" -> "Don't have a passkey? Set one up", verify with OTP,
then save the passkey to iCloud Keychain.

First login from the iPhone needs the OTP path; after the passkey is enrolled,
subsequent logins are Face ID only.

Cloudflare resources:

- Tunnel `calltap` (`<tunnel-id>`), remotely managed, ingress
  configured for `neko.`, `calltap.`, and `grafana.` subdomains.
- R2 Bucket (`CALLS_BUCKET`, default `calltap-calls`), storing uploaded call directories
  (`calls/<YYYY>/<MM>/<DD>/<call_id>/{meta.json,peaks.json,you.flac,agent.flac,mix.opus}`).
- Realtime TURN key `calltap-turn` (`<turn-key-id>`); credentials are
  generated with max 48h TTL, so the VM rotates them daily.

## Hybrid Serverless Dashboard & Auto-Wake

`calltap-wake` is bound to `call.example.com/*`, `neko.example.com/`, `grafana.example.com/`, and `calltap.example.com/*`:

- **Serverless Archive & Playback (`calltap.example.com/*`):**
  - When `calltap-vm` is deallocated (`530`/`502`/`503`/`521–523`), `calltap.example.com` **does not wake the VM**. Instead, the Worker serves the React SPA from Cloudflare Worker Static Assets (`web/dist`) and serves `/api/status`, `/api/calls`, `/api/calls/:id`, `/api/calls/:id/waveform`, and `/api/calls/:id/audio/:track` (including HTTP `206 Partial Content` `Range` requests) directly from R2 (`CALLS_BUCKET`) with **0ms cold start and `$0/hr` VM compute**.
  - Even when the VM is awake, audio tracks and waveform peaks stored in R2 are served at the Cloudflare edge first, so locally pruned calls (`local_pruned: true`) remain playable seamlessly.
  - Clicking **"Wake VM to Record"** in the dashboard visits `https://calltap.example.com/?wake=1` (or `https://call.example.com/?next=https://calltap.example.com&wait=1`), booting the VM on demand.
- **Auto-wake for Live Browser (`neko.example.com/`, `grafana.example.com/`):**
  - Opening `neko.example.com/` or `grafana.example.com/` while the VM is asleep automatically redirects (`302`) to `https://call.example.com/?next=<origin>&wait=1`.
  - `call.example.com` starts the VM if deallocated and waits until `PowerState/running` **plus** a `35s` boot grace period after `ProvisioningState/succeeded` so `cloudflared` and Docker services are ready before redirecting back to `?next=` (strictly allowlisted to `NEKO_ORIGIN` / `CALLTAP_ORIGIN` / `GRAFANA_ORIGIN`).

## Worker + Static Assets Deployment

Build the frontend and deploy from `deploy/cloudflare` with your origins and R2 bucket passed via env vars (so your real domain stays out of git):

```bash
npm --prefix web run build
cd deploy/cloudflare
NEKO_ORIGIN=https://neko.example.com \
CALLTAP_ORIGIN=https://calltap.example.com \
GRAFANA_ORIGIN=https://grafana.example.com \
WAKE_ORIGIN=https://call.example.com \
R2_BUCKET_NAME=calltap-calls \
R2_PREFIX=calls \
npx cf deploy
```

Set the Worker secrets via `cf workers secrets update <NAME>` (including `SLEEP_SECRET`, matching `/etc/calltap/idle.env`).

## VM setup (one-time)

Run on `calltap-vm` (see `deploy/cloudflare/setup-vm.sh`, run from the repo root):

```bash
sudo ./deploy/cloudflare/setup-vm.sh
```

The script installs:

1. `cloudflared` container in the CallTap compose network, with the tunnel token from
   `/etc/calltap/cloudflared-token` (get it with `cf tunnels token calltap`).
2. `turn-rotate.timer`: generates fresh TURN credentials daily into
   `/var/lib/calltap/turn.env`; docker compose reads them on every container restart.
   Rotation happens at boot (2 min after) and at 03:10 UTC.
3. `idleness.timer` (optional): every 5 min checks local Neko/CallTap Prometheus `/metrics`
   for active WebRTC listeners/pipelines, active calls, and pending uploads; after
   `IDLE_MINUTES` (default 15) it calls the wake Worker's `/sleep` endpoint with
   `Authorization: Bearer <SLEEP_SECRET>`, which deallocates the VM. State is stored
   in `/run/calltap/idle-state` (tmpfs, cleared on reboot).
4. `systemd-networkd-wait-online` drop-in: cloudflared and timers start even when the
   boot wait times out.

## WebRTC notes

- Neko runs with `NEKO_WEBRTC_ICELITE=false` and both `NEKO_TURN_FRONTEND` /
  `NEKO_TURN_BACKEND` JSON from `turn.env`.
- With TURN configured, neko offers: tailscale host candidate (direct, when the iPhone
  VPN is on), server reflexive candidates, and Cloudflare TURN relays (works from any
  network, no VPN, no open ports).
- Docker compose publishes `52000/udp+tcp` only on the VM; with TURN relay fallback that
  port no longer needs to be publicly reachable.

## Cost & network footprint

- **No public IP (`$0/mo`):** the Azure static public IP (`$3.65/mo`) is deleted; inbound traffic enters only via Cloudflare Tunnel, and admin SSH uses Tailscale.
- **Idle compute (`$0/hr`):** `calltap-vm` auto-deallocates after 15 min idle (plus an Azure DevTestLab daily safety schedule). Active runtime is ~`$0.06/h` from Azure credit, while Tunnel/Access/Workers/TURN stay on Cloudflare free tier.
- **OS disk:** 64 GiB OS disk is the only persistent Azure resource (`StandardSSD_LRS` if not covered by a free `Premium_LRS` P6 student grant).
