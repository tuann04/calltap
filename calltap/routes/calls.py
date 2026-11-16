from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse

from calltap.audio_edit import edit_call_audio
from calltap.deps import (
    CallMetaDep,
    ControllerDep,
    DbDep,
    SettingsDep,
    UploaderDep,
    require_uploader,
)
from calltap.models import (
    BulkCallsRequest,
    CallMetadata,
    CallStatus,
    EditCallRequest,
    PatchCallRequest,
    StartCallRequest,
    UploadStatus,
)
from calltap.uploader import write_meta_file
from calltap.utils import extract_hostname
from calltap.waveform import ensure_call_waveform

router = APIRouter(prefix="/api/calls", tags=["calls"])


def _download_filename(meta: CallMetadata, fname: str) -> str:
    if meta.title.strip():
        base = meta.title.strip()
    else:
        label = meta.service
        if label in ("unknown", "generic", ""):
            label = extract_hostname(meta.page_url) or label
        base = f"{label}-{meta.started_at:%Y-%m-%d_%H-%M}"
    slug = re.sub(r"[^a-zA-Z0-9._-]+", "-", base).strip("-._").lower() or meta.call_id
    return f"{slug[:80]}-{fname}"


@router.post("/start")
async def start_call(
    controller: ControllerDep,
    body: StartCallRequest | None = None,
) -> CallMetadata:
    req = body or StartCallRequest()
    return await controller.start_call(
        trigger="manual",
        service_override=req.service,
        title=req.title,
        tags=req.tags,
    )


@router.post("/stop")
async def stop_call(controller: ControllerDep) -> dict[str, object]:
    meta = await controller.stop_call(reason="manual")
    return {"stopped": meta is not None, "call": meta.model_dump() if meta else None}


@router.get("")
async def list_calls(
    db: DbDep,
    limit: int = 100,
    service: str | None = None,
    upload_status: UploadStatus | None = None,
    q: str | None = None,
) -> list[CallMetadata]:
    items = db.list_calls(limit=limit, service=service, upload_status=upload_status)
    if q and q.strip():
        needle = q.strip().lower()
        items = [c for c in items if c.matches_query(needle)]
    return items


@router.post("/bulk-upload", dependencies=[Depends(require_uploader)])
async def bulk_upload(
    body: BulkCallsRequest,
    controller: ControllerDep,
) -> dict[str, object]:
    updated = await controller.trigger_upload_many(body.call_ids)
    return {"queued": len(updated), "calls": [c.model_dump() for c in updated]}


@router.post("/bulk-delete")
async def bulk_delete(
    body: BulkCallsRequest,
    controller: ControllerDep,
) -> dict[str, object]:
    deleted = await controller.delete_calls(body.call_ids, delete_remote=body.delete_remote)
    return {"deleted": len(deleted), "call_ids": deleted}


@router.get("/{call_id}")
async def get_call(meta: CallMetaDep) -> CallMetadata:
    return meta


@router.patch("/{call_id}")
async def patch_call(
    body: PatchCallRequest,
    meta: CallMetaDep,
    cfg: SettingsDep,
    db: DbDep,
    uploader: UploaderDep,
) -> CallMetadata:
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
    if meta.upload_status == UploadStatus.UPLOADED and uploader.enabled:
        await uploader.sync_meta_file(meta)
    return meta


@router.post("/{call_id}/edit")
async def edit_call(
    body: EditCallRequest,
    meta: CallMetaDep,
    cfg: SettingsDep,
    db: DbDep,
    uploader: UploaderDep,
) -> CallMetadata:
    if meta.status != CallStatus.COMPLETED:
        raise HTTPException(status_code=409, detail="Only completed recordings can be edited")
    if meta.local_pruned:
        raise HTTPException(status_code=409, detail="Local audio files were pruned")

    call_dir = cfg.recordings_dir / meta.local_rel_dir
    try:
        updated = await edit_call_audio(
            call_dir,
            meta,
            mode=body.mode,
            start_seconds=body.start_seconds,
            end_seconds=body.end_seconds,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    requeue = meta.upload_status == UploadStatus.UPLOADED and uploader.enabled
    if requeue:
        updated.upload_status = UploadStatus.PENDING
        updated.upload_error = None
        db.upsert_call(updated, next_retry_at=datetime.now(UTC))
    else:
        db.upsert_call(updated)

    write_meta_file(call_dir, updated)
    return updated


@router.delete("/{call_id}")
async def delete_call(
    call_id: str,
    controller: ControllerDep,
    delete_remote: Annotated[bool, Query()] = False,
) -> dict[str, object]:
    try:
        ok = await controller.delete_call(call_id, delete_remote=delete_remote)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if not ok:
        raise HTTPException(status_code=404, detail="Call not found")
    return {"deleted": True, "call_id": call_id}


@router.post("/{call_id}/upload", dependencies=[Depends(require_uploader)])
async def retry_upload(call_id: str, controller: ControllerDep) -> CallMetadata:
    meta = await controller.trigger_upload_now(call_id)
    if meta is None:
        raise HTTPException(status_code=404, detail="Call not found")
    return meta


@router.get("/{call_id}/waveform")
async def get_waveform(meta: CallMetaDep, cfg: SettingsDep) -> dict[str, object]:
    call_dir = cfg.recordings_dir / meta.local_rel_dir
    if not call_dir.exists():
        raise HTTPException(status_code=404, detail="Call directory not found")
    return await ensure_call_waveform(call_dir, meta)


@router.get("/{call_id}/audio/{track}")
async def stream_audio(
    track: Literal["you", "agent", "mix"],
    meta: CallMetaDep,
    cfg: SettingsDep,
    download: Annotated[bool, Query()] = False,
) -> FileResponse:
    fname = getattr(meta.files, track)
    if not fname:
        raise HTTPException(status_code=404, detail=f"Track {track} disabled")
    fpath = cfg.recordings_dir / meta.local_rel_dir / fname
    if not fpath.exists():
        raise HTTPException(status_code=404, detail="Audio file not on disk (possibly pruned)")
    media_type = "audio/ogg" if fname.endswith(".opus") else "audio/flac"
    headers = (
        {"Content-Disposition": f'attachment; filename="{_download_filename(meta, fname)}"'}
        if download
        else None
    )
    return FileResponse(fpath, media_type=media_type, headers=headers)
