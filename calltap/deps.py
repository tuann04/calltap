from __future__ import annotations

from typing import Annotated

from fastapi import Depends, HTTPException, Request

from calltap.config import Settings
from calltap.controller import CallController
from calltap.db import CallDB
from calltap.models import CallMetadata
from calltap.pulse import PulseMonitor
from calltap.storage import StorageManager
from calltap.uploader import CloudUploader


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_db(request: Request) -> CallDB:
    return request.app.state.db


def get_storage(request: Request) -> StorageManager:
    return request.app.state.storage


def get_pulse(request: Request) -> PulseMonitor:
    return request.app.state.pulse


def get_controller(request: Request) -> CallController:
    return request.app.state.controller


def get_uploader(request: Request) -> CloudUploader:
    return request.app.state.uploader


SettingsDep = Annotated[Settings, Depends(get_settings)]
DbDep = Annotated[CallDB, Depends(get_db)]
StorageDep = Annotated[StorageManager, Depends(get_storage)]
PulseDep = Annotated[PulseMonitor, Depends(get_pulse)]
ControllerDep = Annotated[CallController, Depends(get_controller)]
UploaderDep = Annotated[CloudUploader, Depends(get_uploader)]


def get_call_or_404(call_id: str, db: DbDep) -> CallMetadata:
    meta = db.get_call(call_id)
    if meta is None:
        raise HTTPException(status_code=404, detail="Call not found")
    return meta


CallMetaDep = Annotated[CallMetadata, Depends(get_call_or_404)]


def require_uploader(uploader: UploaderDep) -> CloudUploader:
    if not uploader.enabled:
        raise HTTPException(
            status_code=400,
            detail="Connect a cloud storage provider before uploading",
        )
    return uploader
