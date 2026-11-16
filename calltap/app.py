from __future__ import annotations

import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Request, Response
from fastapi.staticfiles import StaticFiles

from calltap.cdp import ChromeInspector
from calltap.cf_access import CloudflareAccessVerifier, build_auth_dependency
from calltap.config import Settings
from calltap.controller import CallController
from calltap.db import CallDB
from calltap.pulse import PulseMonitor
from calltap.recorder import DualTrackRecorder
from calltap.routes import calls as call_routes
from calltap.routes import ops as ops_routes
from calltap.routes import storage as storage_routes
from calltap.storage import StorageManager
from calltap.telemetry import (
    HTTP_DURATION,
    HTTP_REQUESTS,
    configure_logging,
    configure_telemetry,
)
from calltap.uploader import CloudUploader


def _resolve_web_dist() -> Path | None:
    candidates = [
        Path(__file__).resolve().parent / "web_dist",
        Path(__file__).resolve().parent.parent / "web" / "dist",
        Path("/app/web_dist"),
    ]
    return next((c for c in candidates if (c / "index.html").is_file()), None)


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
        silence_threshold_db=cfg.silence_threshold_db,
    )
    uploader = CloudUploader(cfg, db, storage=storage)
    inspector = ChromeInspector(cfg.cdp_url, default_service=cfg.default_service)
    controller = CallController(cfg, db, pulse, recorder, uploader, inspector)
    access_verifier = cf_verifier or CloudflareAccessVerifier(
        team=cfg.cf_access_team,
        audience=cfg.cf_access_aud,
        allowed_emails=cfg.cf_access_email_set,
    )
    auth_dep = [Depends(build_auth_dependency(cfg, access_verifier))]

    configure_logging(log_json=cfg.log_json)

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
    dist_dir = _resolve_web_dist()
    app.state.settings = cfg
    app.state.db = db
    app.state.storage = storage
    app.state.pulse = pulse
    app.state.controller = controller
    app.state.uploader = uploader
    app.state.cf_verifier = access_verifier
    app.state.index_html = (
        (dist_dir / "index.html").read_text(encoding="utf-8") if dist_dir else _fallback_html()
    )
    configure_telemetry(app, cfg)

    @app.middleware("http")
    async def _metrics_middleware(request: Request, call_next: Any) -> Response:
        path = request.url.path
        if path in ("/metrics", "/healthz"):
            return await call_next(request)
        started = time.perf_counter()
        status_code = 500
        try:
            response = await call_next(request)
            status_code = response.status_code
            return response
        finally:
            route = request.scope.get("route")
            route_path = getattr(route, "path", path)
            HTTP_REQUESTS.labels(
                method=request.method,
                path=route_path,
                status=str(status_code),
            ).inc()
            HTTP_DURATION.labels(method=request.method, path=route_path).observe(
                max(0.0, time.perf_counter() - started)
            )

    if dist_dir is not None and (dist_dir / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=dist_dir / "assets"), name="assets")

    app.include_router(ops_routes.public_router)
    app.include_router(ops_routes.protected_router, dependencies=auth_dep)
    app.include_router(call_routes.router, dependencies=auth_dep)
    app.include_router(storage_routes.router, dependencies=auth_dep)

    return app
