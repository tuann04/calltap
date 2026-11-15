# CallTap

Dual-track voice call recorder and cloud uploader for browser-based AI voice agents (Sesame AI, ChatGPT Voice, Gemini Live, and others), controllable from a phone browser.

## How it works

Web voice agents encrypt media end to end with WebRTC (DTLS-SRTP), so a network proxy cannot inspect audio. CallTap runs a real Chrome browser inside `m1k1o/neko` on your homelab or VPS:

1. Your phone connects to Neko over HTTPS/WebRTC, sends your mic to virtual sink `audio_input`, and hears `audio_output.monitor`.
2. Chrome has persistent login enabled (`--bwsi` removed, cookies allowed, profile mounted on a Docker volume) so your Sesame AI session survives restarts.
3. The CallTap sidecar watches PulseAudio (`pactl list source-outputs`) over a shared unix socket. When Chrome opens `microphone`, one `ffmpeg` process records `audio_input.monitor` (`you.flac`) and `audio_output.monitor` (`agent.flac`) in sync, plus an optional stereo `mix.opus` (left = you, right = agent).
4. After hang-up, CallTap writes `meta.json`, enqueues the call in a SQLite outbox, uploads to R2 / S3 / GCS / B2 via `rclone` with verification, and prunes local audio after `CALLTAP_LOCAL_RETENTION_DAYS`.

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

  B->>PA: Hang up (mic stream closes)
  M->>C: Mic absent for 2.5s grace period
  C->>F: Send 'q' on stdin (flush headers)
  C->>C: Write meta.json + mark COMPLETED in SQLite
  C-->>U: Wake upload loop

  U->>U: rclone copy + check (--size-only)
  alt Verified
    U->>U: Mark UPLOADED + ntfy
    U->>U: Prune local audio after retention days
  else Error
    U->>U: Backoff retry (10s to 1h)
  end
```

## Cloudflare deployment (Azure VM)

Public endpoints on `tuann04.cloud`, no VPN or open ports needed on the client: `neko.tuann04.cloud` (remote Chrome), `calltap.tuann04.cloud` (dashboard), and `call.tuann04.cloud` (1-tap wake Worker). Full setup details in [deploy/cloudflare/README.md](deploy/cloudflare/README.md).

```mermaid
flowchart LR
  subgraph client["iPhone / any browser"]
    safari["Safari<br/>(no VPN needed)"]
  end

  subgraph cf["Cloudflare free tier"]
    dns["tuann04.cloud DNS"]
    worker["Worker: calltap-wake<br/>call.tuann04.cloud"]
    tunnel["Tunnel: calltap<br/>neko + calltap subdomains"]
    turn["Realtime TURN relay<br/>turn.cloudflare.com"]
  end

  subgraph azure["Azure: calltap-vm (east asia)"]
    direction TB
    subgraph dockernet["Docker compose network"]
      neko["neko<br/>remote Chrome :8080"]
      calltap["calltap<br/>recorder + dashboard :8090"]
      cfd["cloudflared"]
    end
    nsg["NSG: only SSH/22"]
  end

  safari -->|HTTPS| dns
  dns -->|"call."| worker
  dns -->|"neko / calltap."| tunnel
  worker -->|"Azure REST API<br/>start / deallocate"| azure
  cfd <-->|"outbound QUIC tunnel"| tunnel
  tunnel --> neko
  tunnel --> calltap
  safari <-.->|"WebRTC media<br/>direct or relayed"| turn
  turn <-.-> neko
  nsg -.- dockernet
```

### A call from the iPhone, step by step

```mermaid
sequenceDiagram
  autonumber
  actor U as iPhone (Safari)
  participant W as Worker<br/>call.tuann04.cloud
  participant AZ as Azure API
  participant VM as calltap-vm
  participant N as neko
  participant T as TURN relay

  U->>W: GET call.tuann04.cloud
  alt VM deallocated
    W->>AZ: start VM
    AZ-->>VM: boot (~40s)
    W-->>U: "Waking CallTap..." page
    U->>W: auto-refresh
  end
  W-->>U: 302 redirect
  U->>N: HTTPS signaling (via tunnel)
  N-->>U: SDP offer + TURN credentials
  U->>T: ICE connectivity check
  T->>N: relayed media
  Note over U,N: ICE picks direct if possible,<br/>TURN relay otherwise
  VM->>VM: CallTap records mic + agent tracks
  VM->>VM: idle 15 min, no session/upload<br/>-> deallocate
```

### Cost control (idle = $0/hour)

```mermaid
flowchart TB
  subgraph vm["calltap-vm (systemd timers)"]
    rotate["turn-rotate.timer<br/>daily 03:10 UTC + at boot"]
    idle["idleness.timer<br/>every 5 min"]
  end

  rotate -->|"curl POST"| cfturn["Cloudflare TURN API<br/>fresh 24h credentials"]
  cfturn -->|"write turn.env"| compose["docker compose env<br/>neko picks it up on restart"]

  idle -->|"check sessions +<br/>pending uploads"| state{"active?"}
  state -->|yes| reset["reset idle counter"]
  state -->|"no, 15 min"| sleepapi["POST /sleep"]
  sleepapi --> worker["Worker deallocates VM<br/>$0/hour"]
```

## Quick start

```bash
cp .env.example .env
cp rclone/rclone.conf.example rclone/rclone.conf
# Edit .env (passwords, CALLTAP_RCLONE_REMOTE) and rclone/rclone.conf
docker compose up -d --build
```

### Connect from your phone

Phone browsers require **HTTPS** to share your microphone.

- **Homelab / VPS with Tailscale (recommended, zero open ports):**
  ```bash
  ./deploy/homelab/tailscale-serve.sh
  ```
  Open Neko on `https://<machine>.<tailnet>.ts.net/` to log in to Sesame AI and make calls, and open `https://<machine>.<tailnet>.ts.net:8443/` for the CallTap dashboard.

- **VPS without Tailscale:**
  Set `NEKO_WEBRTC_NAT1TO1=<your-public-ip>` in `.env`, open TCP `80/443` and UDP `52000`, set `CALLTAP_DASHBOARD_USER`/`CALLTAP_DASHBOARD_PASS`, and point Caddy at `deploy/vps/Caddyfile`.

## Local development & tests

```bash
uv venv --python 3.13 .venv
uv pip install --python .venv/bin/python -e ".[dev]"
.venv/bin/pytest
```
