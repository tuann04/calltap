from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import AsyncMock

from calltap.config import Settings
from calltap.db import CallDB
from calltap.models import CallMetadata, CallStatus, UploadStatus
from calltap.uploader import CloudUploader, build_remote_uri


def _sample_meta(call_id: str, *, ended_at: datetime | None = None) -> CallMetadata:
    now = ended_at or datetime.now(UTC)
    return CallMetadata(
        call_id=call_id,
        service="sesame",
        started_at=now - timedelta(seconds=30),
        ended_at=now,
        duration_seconds=30.0,
        local_rel_dir=f"2026/11/14/{call_id}",
        status=CallStatus.COMPLETED,
        upload_status=UploadStatus.PENDING,
    )


def test_db_crash_recovery(tmp_path: Path) -> None:
    db = CallDB(tmp_path / "calltap.db")
    m1 = _sample_meta("c1")
    m1.status = CallStatus.RECORDING
    m1.ended_at = None
    m2 = _sample_meta("c2")
    m2.upload_status = UploadStatus.UPLOADING
    db.upsert_call(m1)
    db.upsert_call(m2)

    fixed = db.recover_interrupted_on_boot()
    assert fixed == 2
    assert db.get_call("c1").status == CallStatus.ERROR
    assert db.get_call("c2").upload_status == UploadStatus.PENDING
    db.close()


async def test_uploader_success_and_retention_prune(tmp_path: Path) -> None:
    cfg = Settings(
        data_dir=tmp_path,
        recordings_dir=tmp_path / "calls",
        db_path=tmp_path / "calltap.db",
        rclone_remote="r2:calltap-test",
        local_retention_days=7,
    )
    cfg.ensure_dirs()
    db = CallDB(cfg.db_path)

    old_end = datetime.now(UTC) - timedelta(days=10)
    meta = _sample_meta("c-old", ended_at=old_end)
    call_dir = cfg.recordings_dir / meta.local_rel_dir
    call_dir.mkdir(parents=True)
    for fn in ("you.flac", "agent.flac", "mix.opus"):
        (call_dir / fn).write_bytes(b"audio")
    db.upsert_call(meta)

    observed_meta_during_rclone: dict[str, object] = {}

    async def fake_rclone(*args: object, **kwargs: object) -> tuple[int, str]:
        import json

        if not observed_meta_during_rclone:
            observed_meta_during_rclone.update(json.loads((call_dir / "meta.json").read_text()))
        return (0, "")

    uploader = CloudUploader(cfg, db)
    uploader._run_rclone = AsyncMock(side_effect=fake_rclone)  # type: ignore[method-assign]

    processed = await uploader.process_pending_once()
    assert processed == 1

    expected_uri = build_remote_uri("r2:calltap-test", "calls", meta.local_rel_dir)
    assert observed_meta_during_rclone.get("upload_status") == "uploaded"
    assert observed_meta_during_rclone.get("remote_uri") == expected_uri

    updated = db.get_call("c-old")
    assert updated is not None
    assert updated.upload_status == UploadStatus.UPLOADED
    assert updated.remote_uri == expected_uri
    assert updated.local_pruned is True
    assert not (call_dir / "you.flac").exists()
    assert (call_dir / "meta.json").exists()

    synced = await uploader.sync_meta_file(updated)
    assert synced is True
    db.close()


async def test_uploader_failure_schedules_backoff(tmp_path: Path) -> None:
    import json

    cfg = Settings(
        data_dir=tmp_path,
        recordings_dir=tmp_path / "calls",
        db_path=tmp_path / "calltap.db",
        rclone_remote="r2:calltap-test",
    )
    cfg.ensure_dirs()
    db = CallDB(cfg.db_path)

    meta = _sample_meta("c-fail")
    call_dir = cfg.recordings_dir / meta.local_rel_dir
    call_dir.mkdir(parents=True)
    (call_dir / "you.flac").write_bytes(b"audio")
    db.upsert_call(meta)

    uploader = CloudUploader(cfg, db)
    uploader._run_rclone = AsyncMock(return_value=(1, "network timeout"))  # type: ignore[method-assign]

    await uploader.process_pending_once()
    updated = db.get_call("c-fail")
    assert updated is not None
    assert updated.upload_status == UploadStatus.FAILED
    assert updated.remote_uri is None
    assert updated.upload_attempts == 1
    assert "network timeout" in (updated.upload_error or "")
    disk_meta = json.loads((call_dir / "meta.json").read_text())
    assert disk_meta["upload_status"] == "failed"
    assert disk_meta["remote_uri"] is None
    # Next retry is in the future, so next_pending_upload() returns None right now.
    assert db.next_pending_upload() is None
    db.close()

