# Cloudflare Deployment (tuann04.cloud)

Public entry points for CallTap, no Tailscale required on the client:

| URL | Service | Path |
|---|---|---|
| `https://neko.tuann04.cloud` | neko remote browser (:8080) | Cloudflare Tunnel -> `http://neko:8080` |
| `https://calltap.tuann04.cloud` | CallTap dashboard (:8090) | Cloudflare Tunnel -> `http://calltap:8090` |
| `https://call.tuann04.cloud` | 1-tap wake Worker | Cloudflare Worker -> Azure API |

Cloudflare resources (already created in the account):

- Tunnel `calltap` (`8286d507-38f0-43e4-a53b-b093a9a10f42`), remotely managed, ingress
  configured for the two subdomains above.
- Realtime TURN key `calltap-turn` (`a5bb41e83f59679e4a5349884308dc32`); credentials are
  generated with max 48h TTL, so the VM rotates them daily.

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
3. `idleness.timer` (optional): every 5 min checks for active neko sessions and pending
   uploads; after `IDLE_MINUTES` (default 15) it calls the wake Worker's `/sleep`
   endpoint, which deallocates the VM.
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

## Cost after migration

- Azure public IP (`$3.65/mo`) can be deleted: tunnel + TURN remove the need for a
  public endpoint. SSH stays available over Tailscale.
- Idle cost: `$0` (deallocated VM). Active: ~`$0.06/h` billed from the Azure student
  credit while a call runs, plus tunnel/TURN are free-tier.
