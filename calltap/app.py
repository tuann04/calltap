from __future__ import annotations

import secrets
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Literal

from fastapi import Depends, FastAPI, HTTPException, Query, Request, status
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from calltap.cdp import ChromeInspector
from calltap.cf_access import CloudflareAccessVerifier
from calltap.config import Settings
from calltap.controller import CallController
from calltap.db import CallDB
from calltap.models import CallMetadata, StorageConfig, StoragePublicView, UploadStatus
from calltap.pulse import PulseMonitor
from calltap.recorder import DualTrackRecorder
from calltap.storage import StorageManager
from calltap.uploader import CloudUploader, write_meta_file
from calltap.waveform import ensure_call_waveform

_security = HTTPBasic(auto_error=False)


class StartCallRequest(BaseModel):
    service: str | None = None
    title: str = ""
    tags: list[str] = Field(default_factory=list)


class PatchCallRequest(BaseModel):
    title: str | None = None
    service: str | None = None
    tags: list[str] | None = None
    notes: str | None = None


class AutoDetectRequest(BaseModel):
    enabled: bool


class BulkCallsRequest(BaseModel):
    call_ids: list[str] = Field(default_factory=list)
    delete_remote: bool = False


class StorageTestResponse(BaseModel):
    ok: bool
    message: str


def _resolve_web_dist() -> Path | None:
    candidates = [
        Path(__file__).resolve().parent / "web_dist",
        Path(__file__).resolve().parent.parent / "web" / "dist",
        Path("/app/web_dist"),
    ]
    for cand in candidates:
        if (cand / "index.html").is_file():
            return cand
    return None


def _fallback_html() -> str:
    return """<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>CallTap</title></head>
<body style="background:#000;color:#ededed;font-family:system-ui,sans-serif;padding:32px">
  <h1>CallTap</h1>
  <p>Frontend bundle not found. Run <code>cd web &amp;&amp; npm run build</code>.</p>
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
    storage = StorageManager(cfg)
    pulse = PulseMonitor(cfg.pulse_server, cfg.mic_source_names, cfg.browser_process_hints)
    recorder = DualTrackRecorder(
        pulse_server=cfg.pulse_server,
        user_source=cfg.user_source,
        agent_source=cfg.agent_source,
        sample_rate=cfg.sample_rate,
        create_stereo_mix=cfg.create_stereo_mix,
    )
    uploader = CloudUploader(cfg, db, storage=storage)
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

    app = FastAPI(title="CallTap", version="0.2.0", lifespan=lifespan)
    app.state.settings = cfg
    app.state.db = db
    app.state.storage = storage
    app.state.controller = controller
    app.state.uploader = uploader
    app.state.cf_verifier = access_verifier

    dist_dir = _resolve_web_dist()
    if dist_dir is not None and (dist_dir / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=dist_dir / "assets"), name="assets")

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/", response_class=HTMLResponse, dependencies=[Depends(require_auth)])
    async def index() -> HTMLResponse:
        if dist_dir is not None:
            return HTMLResponse((dist_dir / "index.html").read_text(encoding="utf-8"))
        return HTMLResponse(_fallback_html())

    @app.get("/api/status", dependencies=[Depends(require_auth)])
    async def get_status() -> dict[str, object]:
        pulse_ok = await pulse.is_healthy()
        tab = await inspector.active_tab()
        storage_view = storage.public_view()
        return {
            "active_call": controller.active_call.model_dump() if controller.active_call else None,
            "auto_detect": controller.auto_detect,
            "pulse_healthy": pulse_ok,
            "rclone_remote": storage_view.remote_label if storage_view.connected else None,
            "storage": storage_view.model_dump(),
            "pending_uploads": db.count_pending_uploads(),
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
            title=req.title,
            tags=req.tags,
        )

    @app.post("/api/calls/stop", dependencies=[Depends(require_auth)])
    async def stop_call() -> dict[str, object]:
        meta = await controller.stop_call(reason="manual")
        return {"stopped": meta is not None, "call": meta.model_dump() if meta else None}

    @app.get("/api/calls", dependencies=[Depends(require_auth)])
    async def list_calls(
        limit: int = 100,
        service: str | None = None,
        upload_status: UploadStatus | None = None,
        q: str | None = None,
    ) -> list[CallMetadata]:
        items = db.list_calls(limit=limit, service=service, upload_status=upload_status)
        if q and q.strip():
            needle = q.strip().lower()
            items = [
                c
                for c in items
                if needle in c.title.lower()
                or needle in c.service.lower()
                or needle in c.call_id.lower()
                or needle in c.notes.lower()
                or any(needle in t.lower() for t in c.tags)
            ]
        return items

    @app.post("/api/calls/bulk-upload", dependencies=[Depends(require_auth)])
    async def bulk_upload(body: BulkCallsRequest) -> dict[str, object]:
        if not uploader.enabled:
            raise HTTPException(
                status_code=400,
                detail="Connect a cloud storage provider before uploading",
            )
        updated = await controller.trigger_upload_many(body.call_ids)
        return {"queued": len(updated), "calls": [c.model_dump() for c in updated]}

    @app.post("/api/calls/bulk-delete", dependencies=[Depends(require_auth)])
    async def bulk_delete(body: BulkCallsRequest) -> dict[str, object]:
        deleted = await controller.delete_calls(body.call_ids, delete_remote=body.delete_remote)
        return {"deleted": len(deleted), "call_ids": deleted}

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
        if body.title is not None:
            meta.title = body.title.strip()
        if body.service is not None and body.service.strip():
            meta.service = body.service.strip()
        if body.tags is not None:
            meta.tags = body.tags
        if body.notes is not None:
            meta.notes = body.notes
        db.upsert_call(meta)
        call_dir = cfg.recordings_dir / meta.local_rel_dir
        if call_dir.exists():
            write_meta_file(call_dir, meta)
        return meta

    @app.delete("/api/calls/{call_id}", dependencies=[Depends(require_auth)])
    async def delete_call(
        call_id: str,
        delete_remote: bool = Query(default=False),
    ) -> dict[str, object]:
        try:
            ok = await controller.delete_call(call_id, delete_remote=delete_remote)
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        if not ok:
            raise HTTPException(status_code=404, detail="Call not found")
        return {"deleted": True, "call_id": call_id}

    @app.post("/api/calls/{call_id}/upload", dependencies=[Depends(require_auth)])
    async def retry_upload(call_id: str) -> CallMetadata:
        if not uploader.enabled:
            raise HTTPException(
                status_code=400,
                detail="Connect a cloud storage provider before uploading",
            )
        meta = await controller.trigger_upload_now(call_id)
        if meta is None:
            raise HTTPException(status_code=404, detail="Call not found")
        return meta

    @app.get("/api/calls/{call_id}/waveform", dependencies=[Depends(require_auth)])
    async def get_waveform(call_id: str) -> dict[str, object]:
        meta = db.get_call(call_id)
        if meta is None:
            raise HTTPException(status_code=404, detail="Call not found")
        call_dir = cfg.recordings_dir / meta.local_rel_dir
        if not call_dir.exists():
            raise HTTPException(status_code=404, detail="Call directory not found")
        return await ensure_call_waveform(call_dir, meta)

    @app.get("/api/calls/{call_id}/audio/{track}", dependencies=[Depends(require_auth)])
    async def stream_audio(
        call_id: str,
        track: Literal["you", "agent", "mix"],
        download: bool = Query(default=False),
    ) -> FileResponse:
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
        headers = (
            {"Content-Disposition": f'attachment; filename="{call_id}-{fname}"'}
            if download
            else None
        )
        return FileResponse(fpath, media_type=media_type, headers=headers)

    @app.get("/api/storage", dependencies=[Depends(require_auth)])
    async def get_storage() -> StoragePublicView:
        return storage.public_view()

    @app.put("/api/storage", dependencies=[Depends(require_auth)])
    async def update_storage(body: StorageConfig) -> StoragePublicView:
        try:
            view = storage.save(body)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if view.connected and view.auto_upload:
            controller.wake_uploader()
        return view

    @app.post("/api/storage/test", dependencies=[Depends(require_auth)])
    async def test_storage(body: StorageConfig | None = None) -> StorageTestResponse:
        try:
            ok, msg = await storage.test_connection(body)
        except ValueError as exc:
            return StorageTestResponse(ok=False, message=str(exc))
        return StorageTestResponse(ok=ok, message=msg)

    @app.delete("/api/storage", dependencies=[Depends(require_auth)])
    async def delete_storage() -> StoragePublicView:
        return storage.disconnect()

    return app
