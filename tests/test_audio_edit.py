from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from calltap.app import create_app
from calltap.audio_edit import edit_call_audio, probe_audio_duration
from calltap.config import Settings
from calltap.models import CallFiles, CallMetadata, CallStatus, UploadStatus


async def _make_sine_file(path: Path, *, duration: float = 4.0, freq: int = 440) -> None:
    codec = ["-c:a", "libopus", "-b:a", "64k"] if path.suffix == ".opus" else ["-c:a", "flac"]
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        f"sine=frequency={freq}:duration={duration}",
        "-ar",
        "48000",
        *codec,
        str(path),
    )
    rc = await proc.wait()
    assert rc == 0


def _sample_meta(
    call_id: str = "call-edit-1",
    *,
    duration: float = 4.0,
    status: CallStatus = CallStatus.COMPLETED,
    upload_status: UploadStatus = UploadStatus.PENDING,
    local_pruned: bool = False,
) -> CallMetadata:
    return CallMetadata(
        call_id=call_id,
        title="Editable call",
        service="sesame",
        trigger="manual",
        started_at=datetime(2026, 6, 1, 10, 0, tzinfo=UTC),
        ended_at=datetime(2026, 6, 1, 10, 0, 4, tzinfo=UTC),
        duration_seconds=duration,
        files=CallFiles(you="you.flac", agent="agent.flac", mix="mix.opus"),
        local_rel_dir=f"2026-06-01/{call_id}",
        status=status,
        upload_status=upload_status,
        local_pruned=local_pruned,
    )


@pytest.mark.asyncio
async def test_edit_call_audio_keep_and_cut_across_tracks(tmp_path: Path) -> None:
    call_dir = tmp_path / "calls" / "2026-06-01" / "call-edit-1"
    call_dir.mkdir(parents=True)
    await asyncio.gather(
        _make_sine_file(call_dir / "you.flac", duration=4.0, freq=440),
        _make_sine_file(call_dir / "agent.flac", duration=4.0, freq=660),
        _make_sine_file(call_dir / "mix.opus", duration=4.0, freq=550),
    )
    (call_dir / "peaks.json").write_text(json.dumps({"tracks": {"mix": [0.1, 0.2]}}), encoding="utf-8")

    meta = _sample_meta()

    # Keep [1.0, 3.0] -> ~2.0s across all tracks + fresh peaks.json
    trimmed = await edit_call_audio(
        call_dir,
        meta,
        mode="keep",
        start_seconds=1.0,
        end_seconds=3.0,
    )
    assert trimmed.edited_at is not None
    assert trimmed.duration_seconds is not None
    assert 1.9 <= trimmed.duration_seconds <= 2.15
    for fname in ("you.flac", "agent.flac", "mix.opus"):
        dur = await probe_audio_duration(call_dir / fname)
        assert 1.9 <= dur <= 2.15
    peaks = json.loads((call_dir / "peaks.json").read_text(encoding="utf-8"))
    assert set(peaks["tracks"].keys()) == {"you", "agent", "mix"}

    # Cut middle [0.5, 1.3] from the 2.0s recording -> ~1.2s
    cut_mid = await edit_call_audio(
        call_dir,
        trimmed,
        mode="cut",
        start_seconds=0.5,
        end_seconds=1.3,
    )
    assert cut_mid.duration_seconds is not None
    assert 1.05 <= cut_mid.duration_seconds <= 1.35
    for fname in ("you.flac", "agent.flac", "mix.opus"):
        dur = await probe_audio_duration(call_dir / fname)
        assert 1.05 <= dur <= 1.35

    # Cut leading edge [0.0, 0.4] -> ~0.8s
    cut_head = await edit_call_audio(
        call_dir,
        cut_mid,
        mode="cut",
        start_seconds=0.0,
        end_seconds=0.4,
    )
    assert cut_head.duration_seconds is not None
    assert 0.65 <= cut_head.duration_seconds <= 0.95


@pytest.mark.asyncio
async def test_edit_call_route_validation_and_requeue(tmp_path: Path) -> None:
    cfg = Settings(
        data_dir=tmp_path,
        recordings_dir=tmp_path / "calls",
        db_path=tmp_path / "calltap.db",
        auth_username="",
        auth_password="",
        rclone_remote="r2:bucket",
    )
    app = create_app(cfg)

    call_dir = cfg.recordings_dir / "2026-06-01" / "call-edit-1"
    call_dir.mkdir(parents=True)
    await asyncio.gather(
        _make_sine_file(call_dir / "you.flac", duration=3.0),
        _make_sine_file(call_dir / "agent.flac", duration=3.0),
        _make_sine_file(call_dir / "mix.opus", duration=3.0),
    )

    uploaded_meta = _sample_meta(
        duration=3.0,
        upload_status=UploadStatus.UPLOADED,
    )
    pruned_meta = _sample_meta(call_id="call-pruned", local_pruned=True)

    with TestClient(app) as client:
        db = app.state.db
        db.upsert_call(uploaded_meta)
        db.upsert_call(pruned_meta)

        # Pruned call returns 409
        res_pruned = client.post(
            "/api/calls/call-pruned/edit",
            json={"mode": "keep", "start_seconds": 0.5, "end_seconds": 2.0},
        )
        assert res_pruned.status_code == 409

        # Invalid range returns 400
        res_bad = client.post(
            "/api/calls/call-edit-1/edit",
            json={"mode": "keep", "start_seconds": 2.0, "end_seconds": 1.0},
        )
        assert res_bad.status_code == 400

        # Valid trim succeeds, updates duration & resets UPLOADED -> PENDING for re-sync
        res_ok = client.post(
            "/api/calls/call-edit-1/edit",
            json={"mode": "keep", "start_seconds": 0.5, "end_seconds": 2.5},
        )
        assert res_ok.status_code == 200
        body = res_ok.json()
        assert 1.9 <= body["duration_seconds"] <= 2.15
        assert body["edited_at"] is not None
        assert body["upload_status"] == "pending"
