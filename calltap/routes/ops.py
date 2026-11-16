from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import HTMLResponse
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

from calltap.deps import ControllerDep, DbDep, PulseDep, SettingsDep, StorageDep
from calltap.models import AutoDetectRequest, TelemetryBatchRequest, TelemetryEvent
from calltap.telemetry import (
    BROWSER_EVENTS,
    CALLS_ACTIVE,
    PENDING_UPLOADS,
    PULSE_HEALTHY,
    start_span,
)

_client_logger = logging.getLogger("calltap.client")

public_router = APIRouter(tags=["ops"])
protected_router = APIRouter(tags=["ops"])


@public_router.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@public_router.get("/metrics")
async def metrics(cfg: SettingsDep, controller: ControllerDep, db: DbDep) -> Response:
    if not cfg.metrics_enabled:
        raise HTTPException(status_code=404, detail="Metrics disabled")
    CALLS_ACTIVE.set(1 if controller.active_call is not None else 0)
    PENDING_UPLOADS.set(db.count_pending_uploads())
    return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)


@protected_router.get("/", response_class=HTMLResponse)
async def index(request: Request) -> HTMLResponse:
    return HTMLResponse(request.app.state.index_html)


@protected_router.post("/api/telemetry")
async def ingest_telemetry(body: TelemetryBatchRequest | TelemetryEvent) -> dict[str, int]:
    events = body.events if isinstance(body, TelemetryBatchRequest) else [body]
    with start_span("client.telemetry", {"telemetry.count": len(events)}):
        for ev in events:
            lvl = "warning" if ev.level == "warn" else ev.level
            BROWSER_EVENTS.labels(source=ev.source, event=ev.event, level=lvl).inc()
            log_fn = getattr(_client_logger, lvl, _client_logger.info)
            log_fn(
                "client event %s: %s",
                ev.event,
                ev.message or "-",
                extra={
                    "client_source": ev.source,
                    "client_event": ev.event,
                    "client_data": ev.data,
                },
            )
    return {"accepted": len(events)}


@protected_router.get("/api/status")
async def get_status(
    pulse: PulseDep,
    db: DbDep,
    controller: ControllerDep,
    storage: StorageDep,
) -> dict[str, object]:
    pulse_ok = await pulse.is_healthy()
    PULSE_HEALTHY.set(1 if pulse_ok else 0)
    pending = db.count_pending_uploads()
    PENDING_UPLOADS.set(pending)
    tab = await controller.inspector.active_tab()
    storage_view = storage.public_view()
    return {
        "active_call": controller.active_call.model_dump() if controller.active_call else None,
        "auto_detect": controller.auto_detect,
        "pulse_healthy": pulse_ok,
        "rclone_remote": storage_view.remote_label if storage_view.connected else None,
        "storage": storage_view.model_dump(),
        "pending_uploads": pending,
        "active_tab": {"service": tab.service, "url": tab.url, "title": tab.title},
    }


@protected_router.post("/api/auto-detect")
async def set_auto_detect(
    body: AutoDetectRequest,
    controller: ControllerDep,
) -> dict[str, bool]:
    controller.auto_detect = body.enabled
    return {"auto_detect": controller.auto_detect}
