from __future__ import annotations

import secrets
from contextlib import asynccontextmanager
from typing import Annotated, Literal

from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from pydantic import BaseModel, Field

from calltap.cdp import ChromeInspector
from calltap.cf_access import CloudflareAccessVerifier
from calltap.config import Settings
from calltap.controller import CallController
from calltap.db import CallDB
from calltap.models import CallMetadata, UploadStatus
from calltap.pulse import PulseMonitor
from calltap.recorder import DualTrackRecorder
from calltap.uploader import CloudUploader, write_meta_file

_security = HTTPBasic(auto_error=False)


class StartCallRequest(BaseModel):
    service: str | None = None
    tags: list[str] = Field(default_factory=list)


class PatchCallRequest(BaseModel):
    tags: list[str] | None = None
    notes: str | None = None


class AutoDetectRequest(BaseModel):
    enabled: bool


def _dashboard_html() -> str:
    return """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>CallTap · Voice Call Recorder</title>
<style>
  :root {
    --bg: #0c0d10; --card: #15171c; --muted: #1e2129; --border: #2a2e39;
    --fg: #f3f4f6; --sub: #9ca3af; --accent: #6366f1; --ok: #10b981;
    --warn: #f59e0b; --err: #ef4444; --radius: 12px;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 15px/1.45 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    padding: 16px; max-width: 760px; margin-inline: auto;
  }
  header { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 16px; }
  h1 { font-size: 20px; margin: 0; letter-spacing: -0.02em; }
  .pill {
    display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px;
    border-radius: 999px; font-size: 12px; font-weight: 600; background: var(--muted); border: 1px solid var(--border);
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--sub); }
  .dot.rec { background: var(--err); box-shadow: 0 0 8px var(--err); }
  .dot.ok { background: var(--ok); }
  .card {
    background: var(--card); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 16px; margin-bottom: 14px;
  }
  .row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between; }
  button {
    appearance: none; border: 1px solid var(--border); background: var(--muted); color: var(--fg);
    padding: 10px 14px; border-radius: 10px; font-size: 14px; font-weight: 600; cursor: pointer;
  }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.danger { background: var(--err); border-color: var(--err); color: #fff; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  input, select {
    background: var(--bg); color: var(--fg); border: 1px solid var(--border);
    border-radius: 8px; padding: 8px 10px; font-size: 14px;
  }
  .meta { font-size: 12px; color: var(--sub); }
  .call { border-top: 1px solid var(--border); padding-top: 12px; margin-top: 12px; }
  .call:first-child { border-top: 0; padding-top: 0; margin-top: 0; }
  .tracks { display: grid; gap: 8px; margin-top: 10px; }
  .track { display: flex; flex-direction: column; gap: 4px; background: var(--bg); padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border); }
  .track span { font-size: 12px; color: var(--sub); font-weight: 600; }
  audio { width: 100%; height: 34px; }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; font-weight: 600; }
  .b-uploaded { background: #064e3b; color: #6ee7b7; }
  .b-pending, .b-uploading { background: #78350f; color: #fcd34d; }
  .b-failed { background: #7f1d1d; color: #fca5a5; }
  .b-disabled { background: var(--muted); color: var(--sub); }
  .tags-row { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
  .tags-row input { flex: 1; min-width: 140px; }
</style>
</head>
<body>
  <header>
    <div>
      <h1>CallTap</h1>
      <div class="meta" id="healthLine">Checking PulseAudio &amp; cloud sync...</div>
    </div>
    <span class="pill"><span class="dot" id="stateDot"></span><span id="stateText">Idle</span></span>
  </header>

  <section class="card">
    <div class="row">
      <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
        <select id="serviceSelect">
          <option value="">Auto (from tab)</option>
          <option value="sesame">Sesame AI</option>
          <option value="chatgpt">ChatGPT Voice</option>
          <option value="gemini">Gemini Live</option>
          <option value="generic">Generic</option>
        </select>
        <button id="toggleRecBtn" class="primary">Start recording</button>
      </div>
      <label class="meta" style="display:flex; align-items:center; gap:6px; cursor:pointer;">
        <input type="checkbox" id="autoDetectChk"> Auto-detect calls
      </label>
    </div>
    <div class="meta" id="activeInfo" style="margin-top:10px;"></div>
  </section>

  <section class="card">
    <div class="row" style="margin-bottom:10px;">
      <strong>Recorded calls</strong>
      <button onclick="refresh()">Refresh</button>
    </div>
    <div id="callsList" class="meta">Loading...</div>
  </section>

<script>
let currentStatus = null;

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function fmtDur(s) {
  if (s == null) return 'live';
  const m = Math.floor(s / 60), r = Math.round(s % 60);
  return m > 0 ? `${m}m ${r}s` : `${r}s`;
}

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function refresh() {
  const [st, calls] = await Promise.all([api('/api/status'), api('/api/calls?limit=50')]);
  currentStatus = st;

  const dot = document.getElementById('stateDot');
  const txt = document.getElementById('stateText');
  const btn = document.getElementById('toggleRecBtn');
  const info = document.getElementById('activeInfo');

  if (st.active_call) {
    dot.className = 'dot rec';
    txt.textContent = 'Recording';
    btn.className = 'danger';
    btn.textContent = 'Stop recording';
    info.textContent = `${st.active_call.service} · ${st.active_call.call_id} (started ${new Date(st.active_call.started_at).toLocaleTimeString()})`;
  } else {
    dot.className = st.pulse_healthy ? 'dot ok' : 'dot';
    txt.textContent = 'Idle';
    btn.className = 'primary';
    btn.textContent = 'Start recording';
    info.textContent = st.active_tab?.url ? `Active tab: ${st.active_tab.service} (${st.active_tab.url})` : 'Waiting for a call...';
  }

  document.getElementById('autoDetectChk').checked = st.auto_detect;
  document.getElementById('healthLine').textContent =
    `PulseAudio: ${st.pulse_healthy ? 'connected' : 'offline'} · Cloud: ${st.rclone_remote || 'local only'}`;

  const list = document.getElementById('callsList');
  if (!calls.length) {
    list.innerHTML = '<div class="meta">No calls recorded yet.</div>';
    return;
  }

  list.innerHTML = calls.map(c => {
    const bCls = 'b-' + (c.upload_status || 'pending');
    const audioBlock = c.local_pruned
      ? `<div class="meta" style="margin-top:8px;">Local audio pruned after cloud upload (${esc(c.remote_uri || '')})</div>`
      : `<div class="tracks">
          ${c.files.mix ? `<div class="track"><span>Stereo mix (L = you · R = agent)</span><audio controls preload="none" src="/api/calls/${encodeURIComponent(c.call_id)}/audio/mix"></audio></div>` : ''}
          <div class="track"><span>You (${esc(c.files.you)})</span><audio controls preload="none" src="/api/calls/${encodeURIComponent(c.call_id)}/audio/you"></audio></div>
          <div class="track"><span>Agent (${esc(c.files.agent)})</span><audio controls preload="none" src="/api/calls/${encodeURIComponent(c.call_id)}/audio/agent"></audio></div>
        </div>`;
    const retryBtn = (c.upload_status === 'failed' || c.upload_status === 'pending' || c.upload_status === 'disabled') && st.rclone_remote
      ? `<button onclick="retryUpload('${esc(c.call_id)}')">${c.upload_status === 'disabled' ? 'Upload now' : 'Retry upload'}</button>` : '';
    return `<div class="call">
      <div class="row">
        <div>
          <strong>${esc(c.service)}</strong> · ${fmtDur(c.duration_seconds)}
          <div class="meta">${new Date(c.started_at).toLocaleString()} · ${esc(c.call_id)}</div>
        </div>
        <div style="display:flex; gap:6px; align-items:center;">
          <span class="badge ${bCls}">${esc(c.upload_status)}</span>
          ${retryBtn}
        </div>
      </div>
      ${c.upload_error ? `<div class="meta" style="color:#fca5a5;margin-top:4px;">${esc(c.upload_error)}</div>` : ''}
      ${audioBlock}
      <div class="tags-row">
        <input id="tags-${esc(c.call_id)}" placeholder="tags (comma separated)" value="${esc((c.tags || []).join(', '))}">
        <input id="notes-${esc(c.call_id)}" placeholder="notes..." value="${esc(c.notes || '')}">
        <button onclick="saveMeta('${esc(c.call_id)}')">Save</button>
      </div>
    </div>`;
  }).join('');
}

document.getElementById('toggleRecBtn').onclick = async () => {
  if (currentStatus?.active_call) {
    await api('/api/calls/stop', { method: 'POST' });
  } else {
    const svc = document.getElementById('serviceSelect').value || null;
    await api('/api/calls/start', { method: 'POST', body: JSON.stringify({ service: svc }) });
  }
  await refresh();
};

document.getElementById('autoDetectChk').onchange = async (e) => {
  await api('/api/auto-detect', { method: 'POST', body: JSON.stringify({ enabled: e.target.checked }) });
  await refresh();
};

async function saveMeta(id) {
  const tagsRaw = document.getElementById('tags-' + id).value;
  const notes = document.getElementById('notes-' + id).value;
  const tags = tagsRaw.split(',').map(s => s.trim()).filter(Boolean);
  await api(`/api/calls/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ tags, notes }) });
  await refresh();
}

async function retryUpload(id) {
  await api(`/api/calls/${encodeURIComponent(id)}/upload`, { method: 'POST' });
  await refresh();
}

refresh();
setInterval(() => { if (currentStatus?.active_call) refresh(); }, 4000);
</script>
</body>
</html>"""


def create_app(
    settings: Settings | None = None,
    *,
    start_background: bool = True,
    cf_verifier: CloudflareAccessVerifier | None = None,
) -> FastAPI:
    cfg = settings or Settings()
    cfg.ensure_dirs()
    db = CallDB(cfg.db_path)
    pulse = PulseMonitor(cfg.pulse_server, cfg.mic_source_names, cfg.browser_process_hints)
    recorder = DualTrackRecorder(
        pulse_server=cfg.pulse_server,
        user_source=cfg.user_source,
        agent_source=cfg.agent_source,
        sample_rate=cfg.sample_rate,
        create_stereo_mix=cfg.create_stereo_mix,
    )
    uploader = CloudUploader(cfg, db)
    inspector = ChromeInspector(cfg.cdp_url, default_service=cfg.default_service)
    controller = CallController(cfg, db, pulse, recorder, uploader, inspector)
    access_verifier = cf_verifier or CloudflareAccessVerifier(
        team=cfg.cf_access_team,
        audience=cfg.cf_access_aud,
        allowed_emails=cfg.cf_access_email_set,
    )

    async def require_auth(
        request: Request,
        credentials: Annotated[HTTPBasicCredentials | None, Depends(_security)],
    ) -> None:
        if access_verifier.enabled:
            cf_jwt = request.headers.get("cf-access-jwt-assertion") or request.cookies.get(
                "CF_Authorization"
            )
            if cf_jwt and await access_verifier.verify(cf_jwt) is not None:
                return

        user = cfg.dashboard_user.strip()
        pw = cfg.dashboard_pass
        if not user:
            if access_verifier.enabled:
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Cloudflare Access authentication required",
                )
            return
        if credentials is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Authentication required",
                headers={"WWW-Authenticate": "Basic"},
            )
        user_ok = secrets.compare_digest(credentials.username.encode(), user.encode())
        pass_ok = secrets.compare_digest(credentials.password.encode(), pw.encode())
        if not (user_ok and pass_ok):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid credentials",
                headers={"WWW-Authenticate": "Basic"},
            )

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        if start_background:
            await controller.start_background()
        try:
            yield
        finally:
            await controller.stop_background()
            db.close()

    app = FastAPI(title="CallTap", version="0.1.0", lifespan=lifespan)
    app.state.settings = cfg
    app.state.db = db
    app.state.controller = controller
    app.state.uploader = uploader
    app.state.cf_verifier = access_verifier

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/", response_class=HTMLResponse, dependencies=[Depends(require_auth)])
    async def index() -> str:
        return _dashboard_html()

    @app.get("/api/status", dependencies=[Depends(require_auth)])
    async def get_status() -> dict[str, object]:
        pulse_ok = await pulse.is_healthy()
        tab = await inspector.active_tab()
        return {
            "active_call": controller.active_call.model_dump() if controller.active_call else None,
            "auto_detect": controller.auto_detect,
            "pulse_healthy": pulse_ok,
            "rclone_remote": cfg.rclone_remote or None,
            "active_tab": {"service": tab.service, "url": tab.url, "title": tab.title},
        }

    @app.post("/api/auto-detect", dependencies=[Depends(require_auth)])
    async def set_auto_detect(body: AutoDetectRequest) -> dict[str, bool]:
        controller.auto_detect = body.enabled
        return {"auto_detect": controller.auto_detect}

    @app.post("/api/calls/start", dependencies=[Depends(require_auth)])
    async def start_call(body: StartCallRequest | None = None) -> CallMetadata:
        req = body or StartCallRequest()
        return await controller.start_call(
            trigger="manual",
            service_override=req.service,
            tags=req.tags,
        )

    @app.post("/api/calls/stop", dependencies=[Depends(require_auth)])
    async def stop_call() -> dict[str, object]:
        meta = await controller.stop_call(reason="manual")
        return {"stopped": meta is not None, "call": meta.model_dump() if meta else None}

    @app.get("/api/calls", dependencies=[Depends(require_auth)])
    async def list_calls(
        limit: int = 50,
        service: str | None = None,
        upload_status: UploadStatus | None = None,
    ) -> list[CallMetadata]:
        return db.list_calls(limit=limit, service=service, upload_status=upload_status)

    @app.get("/api/calls/{call_id}", dependencies=[Depends(require_auth)])
    async def get_call(call_id: str) -> CallMetadata:
        meta = db.get_call(call_id)
        if meta is None:
            raise HTTPException(status_code=404, detail="Call not found")
        return meta

    @app.patch("/api/calls/{call_id}", dependencies=[Depends(require_auth)])
    async def patch_call(call_id: str, body: PatchCallRequest) -> CallMetadata:
        meta = db.get_call(call_id)
        if meta is None:
            raise HTTPException(status_code=404, detail="Call not found")
        if body.tags is not None:
            meta.tags = body.tags
        if body.notes is not None:
            meta.notes = body.notes
        db.upsert_call(meta)
        call_dir = cfg.recordings_dir / meta.local_rel_dir
        if call_dir.exists():
            write_meta_file(call_dir, meta)
        return meta

    @app.post("/api/calls/{call_id}/upload", dependencies=[Depends(require_auth)])
    async def retry_upload(call_id: str) -> CallMetadata:
        meta = await controller.trigger_upload_now(call_id)
        if meta is None:
            raise HTTPException(status_code=404, detail="Call not found")
        return meta

    @app.get("/api/calls/{call_id}/audio/{track}", dependencies=[Depends(require_auth)])
    async def stream_audio(call_id: str, track: Literal["you", "agent", "mix"]) -> FileResponse:
        meta = db.get_call(call_id)
        if meta is None:
            raise HTTPException(status_code=404, detail="Call not found")
        fname = getattr(meta.files, track)
        if not fname:
            raise HTTPException(status_code=404, detail=f"Track {track} disabled")
        fpath = cfg.recordings_dir / meta.local_rel_dir / fname
        if not fpath.exists():
            raise HTTPException(status_code=404, detail="Audio file not on disk (possibly pruned)")
        media_type = "audio/ogg" if fname.endswith(".opus") else "audio/flac"
        return FileResponse(fpath, media_type=media_type, filename=f"{call_id}-{fname}")

    return app
