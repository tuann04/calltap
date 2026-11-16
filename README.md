# CallTap

Dual-track voice call recorder and cloud uploader for browser-based AI voice agents (Sesame AI, ChatGPT Voice, Gemini Live, and others), controllable from a phone browser.

## How it works

Web voice agents encrypt media end to end with WebRTC (DTLS-SRTP), so a network proxy cannot inspect audio. CallTap runs a real Chrome browser inside `m1k1o/neko` on your homelab or VPS:

1. Your phone connects to Neko over HTTPS/WebRTC, sends your mic to virtual sink `audio_input`, and hears `audio_output.monitor`.
2. Chrome has persistent login enabled (`--bwsi` removed, cookies allowed, profile mounted on a Docker volume) so your Sesame AI session survives restarts.
3. The CallTap sidecar watches PulseAudio (`pactl list source-outputs`) over a shared unix socket. When Chrome opens `microphone`, one `ffmpeg` process records `audio_input.monitor` (`you.flac`) and `audio_output.monitor` (`agent.flac`) in sync, plus an optional stereo `mix.opus` (left = you, right = agent).
4. After hang-up, CallTap writes `meta.json`, extracts a dual-track waveform (`peaks.json`), and saves locally by default. Optionally connect Cloudflare R2, AWS S3, Backblaze B2, or Google Drive directly inside the dashboard (no `.env` or `rclone.conf` preconfiguration required) with auto-upload or manual upload of selected calls.

### Architecture & Audio Routing

```mermaid
flowchart TB
  Phone["Phone Browser<br/>HTTPS + WebRTC"]
  Proxy["Tailscale Serve / Caddy<br/>HTTPS Termination"]

  Phone <-->|"HTTPS / WebRTC"| Proxy
  Proxy <-->|"WebRTC + :8080"| NekoSrv
  Proxy <-->|"Dashboard :8090"| API

  subgraph Neko["Container: neko (m1k1o/neko)"]
    direction TB
    NekoSrv["Neko WebRTC Server<br/>:8080 · UDP/TCP :52000"]
    Chrome["Google Chrome (Persistent Profile)<br/>Sesame · ChatGPT · Gemini · CDP :9222"]
    subgraph PA["PulseAudio (/var/run/pulse/pulseaudio.socket)"]
      direction LR
      SinkIn["audio_input<br/>(null sink)"]
      SrcMic["microphone<br/>(virtual source)"]
      SinkOut["audio_output<br/>(null sink)"]
      SinkIn -. "monitor" .-> SrcMic
    end
    NekoSrv -->|"Phone Mic"| SinkIn
    SrcMic -->|"User Mic"| Chrome
    Chrome -->|"AI Audio"| SinkOut
    SinkOut -. "audio_output.monitor" .-> NekoSrv
  end

  subgraph CallTap["Container: calltap (Sidecar)"]
    direction TB
    API["FastAPI Dashboard :8090"]
    CDP["ChromeInspector<br/>CDP /json/list"]
    PulseMon["PulseMonitor<br/>pactl poll 0.5s"]
    FFmpeg["DualTrackRecorder<br/>Synced ffmpeg"]
    Ctrl["CallController"]
    DB[("SQLite Outbox<br/>calltap.db")]
    Disk["/data/calls/YYYY/MM/DD/id<br/>you.flac · agent.flac · mix.opus · meta.json"]
    Uploader["CloudUploader<br/>rclone copy + check"]

    API <-->|"manual / playback"| Ctrl
    CDP -->|"service + tab URL"| Ctrl
    PulseMon -->|"mic active / lost"| Ctrl
    Ctrl --> FFmpeg
    Ctrl --> DB
    FFmpeg --> Disk
    DB --> Uploader
    Disk --> Uploader
  end

  Chrome -. "CDP :9222" .-> CDP
  PA -. "pulse_sock" .-> PulseMon
  PA -. "audio_input.monitor +<br/>audio_output.monitor" .-> FFmpeg

  Cloud[("Cloud Storage<br/>R2 / S3 / GCS / B2")]
  Ntfy["ntfy Push"]
  Uploader -->|"rclone copy + check"| Cloud
  Uploader -. "optional notify" .-> Ntfy
```

### Auto-Detect Recording & Upload Lifecycle

```mermaid
sequenceDiagram
  autonumber
  participant B as Phone + Chrome
  participant PA as PulseAudio
  participant M as PulseMonitor
  participant C as CallController + CDP
  participant F as ffmpeg
  participant U as CloudUploader

  B->>PA: Start voice call (Chrome opens microphone)
  loop Poll every 0.5s
    M->>PA: pactl list source-outputs
  end
  PA-->>M: Uncorked browser stream on microphone
  M->>C: start_call(trigger="auto")
  C->>B: Query CDP :9222/json/list (service & URL)
  C->>F: Record audio_input.monitor + audio_output.monitor
  Note over F: Synced you.flac, agent.flac, mix.opus

  B->>PA: Hang up (mic stream closes, 20s dual-track silence, or 10s Neko viewer disconnect)
  M->>C: Stop condition met
  C->>F: Send 'q' on stdin (flush headers)
  C->>C: Write meta.json + peaks.json + mark COMPLETED in SQLite
  C-->>U: Wake upload loop

  U->>U: rclone copy + check (--size-only)
  alt Verified
    U->>U: Mark UPLOADED + ntfy
    U->>U: Prune local audio after retention days
  else Error
    U->>U: Backoff retry (10s to 1h)
  end
```

## Deployment (High-Level View)

CallTap supports three deployment targets under [`deploy/`](deploy/):

| Target | Entry Point | Notes |
|---|---|---|
| **Cloudflare + Azure VM (recommended)** | [`deploy/README.md`](deploy/README.md), [`deploy/cloudflare/README.md`](deploy/cloudflare/README.md) | Zero public IPs, Passkey/OIDC SSO via Cloudflare Access, 1-tap VM wake + 15m auto-sleep (`$0/hr` idle), and serverless dashboard/playback via Worker + KV/R2 while the VM sleeps. |
| **VPS + Caddy** | [`deploy/vps/Caddyfile`](deploy/vps/Caddyfile) | Reverse proxy for `neko` (`:8080`) and `calltap` (`:8090`) on a standard Linux VPS with public ports `80/443` and `52000/udp+tcp`. |
| **Homelab + Tailscale Serve** | [`deploy/homelab/tailscale-serve.sh`](deploy/homelab/tailscale-serve.sh) | Exposes Neko (`:443`) and CallTap (`:8443`) privately over Tailscale HTTPS. |

```mermaid
flowchart LR
  subgraph client["Phone / Desktop Browser"]
    browser["Safari / Chrome<br/>(no VPN needed)"]
  end

  subgraph cf["Cloudflare Edge (Free Tier)"]
    access["Cloudflare Access<br/>(Passkeys / OIDC / OTP)"]
    worker["Worker: calltap-wake<br/>call. + neko/ + calltap/*"]
    assets["Worker Static Assets + KV/R2<br/>(serverless dashboard & playback)"]
    tunnel["Tunnel: calltap"]
    turn["Realtime TURN Relay"]
  end

  subgraph vm["calltap-vm (Azure · No Public IP · Auto-Sleep $0/hr)"]
    direction TB
    neko["neko (:8080)<br/>Chrome + PulseAudio"]
    calltap["calltap (:8090)<br/>Recorder + API"]
    cfd["cloudflared"]
    gltm["Observability (GLTM)<br/>Grafana :3000 · Alloy · Loki · Tempo · Mimir"]
  end

  browser -->|HTTPS| access
  access --> worker
  worker -->|"VM sleeping: serve SPA + KV/R2"| assets
  worker -->|"VM sleeping on neko/ or ?wake=1"| vm
  access -->|"VM awake"| tunnel
  cfd <-->|"outbound QUIC"| tunnel
  tunnel --> neko
  tunnel --> calltap
  browser <-.->|"WebRTC media"| turn
  turn <-.-> neko
  neko -.-> gltm
  calltap -.-> gltm
```

### Observability (GLTM Stack)

Every Docker Compose deployment runs a built-in **Grafana + Loki + Tempo + Mimir + Alloy** stack ([`deploy/observability/`](deploy/observability/)):

- **Alloy** collects Docker container JSON logs (-> **Loki**), scrapes host + `neko` + `calltap` Prometheus metrics (-> **Mimir**), and ingests OpenTelemetry traces from `calltap` (`:4318`) (-> **Tempo**).
- **Grafana** is exposed at `grafana.<domain>` behind Cloudflare Access (Passkeys) with auto-login via `Cf-Access-Authenticated-User-Email` (and also bound to `127.0.0.1:3000` for SSH tunnels), featuring a pre-provisioned **CallTap & Neko** dashboard.

For full setup, secret locations, deploy commands, and step-by-step troubleshooting runbooks, see **[`deploy/README.md`](deploy/README.md)**.

## Quick start

```bash
cp .env.example .env
# Edit .env (passwords, Cloudflare/Neko settings). No S3/R2 keys required in .env.
docker compose up -d --build
```

Open the CallTap dashboard, click **Local Only** in the top bar whenever you want to connect Cloudflare R2, AWS S3, Backblaze B2 / Custom S3, or Google Drive, test the connection, and choose auto-upload or manual selection uploads.

## Local development & tests

```bash
# Backend + tests
uv venv --python 3.13 .venv
uv pip install --python .venv/bin/python -e ".[dev]"
.venv/bin/pytest
.venv/bin/ruff check calltap tests

# Frontend (React + Tailwind + Vercel Geist)
cd web
npm install
npm run build   # or `npm run dev` with Vite proxy to :8090
```

