from __future__ import annotations

from fastapi import APIRouter, HTTPException

from calltap.deps import ControllerDep, StorageDep
from calltap.models import StorageConfig, StoragePublicView, StorageTestResponse

router = APIRouter(prefix="/api/storage", tags=["storage"])


@router.get("")
async def get_storage_config(storage: StorageDep) -> StoragePublicView:
    return storage.public_view()


@router.put("")
async def update_storage(
    body: StorageConfig,
    storage: StorageDep,
    controller: ControllerDep,
) -> StoragePublicView:
    try:
        view = storage.save(body)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if view.connected and view.auto_upload:
        controller.wake_uploader()
    return view


@router.post("/test")
async def test_storage(
    storage: StorageDep,
    body: StorageConfig | None = None,
) -> StorageTestResponse:
    try:
        ok, msg = await storage.test_connection(body)
    except ValueError as exc:
        return StorageTestResponse(ok=False, message=str(exc))
    return StorageTestResponse(ok=ok, message=msg)


@router.delete("")
async def delete_storage(storage: StorageDep) -> StoragePublicView:
    return storage.disconnect()
