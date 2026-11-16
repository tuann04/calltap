from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock

from fastapi.testclient import TestClient

from calltap.app import create_app
from calltap.config import Settings
from calltap.models import CallStatus, StorageConfig, StorageProvider, UploadStatus
from calltap.recorder import RecordingResult


class _StubRecorder:
    def __init__(self) -> None:
        self.is_recording = False
        self.silent_for_seconds = 0.0
        self._dir: Path | None = None

    async def start(self, call_dir: Path, **_kwargs) -> None:
        self._dir = call_dir
        (call_dir / "you.flac").write_bytes(b"fLaC-you")
        (call_dir / "agent.flac").write_bytes(b"fLaC-agent")
        (call_dir / "mix.opus").write_bytes(b"OggS-mix")
        self.is_recording = True

    async def stop(self) -> RecordingResult:
        assert self._dir is not None
        d = self._dir
        self.is_recording = False
        return RecordingResult(
            you_path=d / "you.flac",
            agent_path=d / "agent.flac",
            mix_path=d / "mix.opus",
            exit_code=0,
            stderr_tail="",
        )


def test_storage_connect_mask_and_call_management(tmp_path: Path) -> None:
    cfg = Settings(
        data_dir=tmp_path,
        recordings_dir=tmp_path / "calls",
        db_path=tmp_path / "calltap.db",
        auto_detect=False,
    )
    app = create_app(cfg, start_background=False)
    ctrl = app.state.controller
    ctrl.pulse.is_healthy = AsyncMock(return_value=True)

    from calltap.cdp import TabContext

    ctrl.inspector.active_tab = AsyncMock(
        return_value=TabContext(service="sesame", url="https://app.sesame.com", title="Sesame")
    )
    ctrl.recorder = _StubRecorder()  # type: ignore[assignment]

    with TestClient(app) as client:
        # Initially local-only with no preconfigured keys
        st = client.get("/api/storage").json()
        assert st["connected"] is False
        assert st["provider"] == "none"

        # Record a call locally -> stays disabled/local-only
        c1 = client.post("/api/calls/start", json={"title": "Morning practice"}).json()
        c1_id = c1["call_id"]
        assert c1["title"] == "Morning practice"
        stopped = client.post("/api/calls/stop").json()
        assert stopped["call"]["upload_status"] == UploadStatus.DISABLED.value

        # Rename record
        renamed = client.patch(
            f"/api/calls/{c1_id}",
            json={"title": "Sesame lesson #1", "tags": ["vocab"], "notes": "great"},
        ).json()
        assert renamed["title"] == "Sesame lesson #1"

        # Bulk upload fails cleanly when storage is disconnected
        assert client.post("/api/calls/bulk-upload", json={"call_ids": [c1_id]}).status_code == 400

        # Connect Cloudflare R2 via UI API with auto_upload=False
        saved = client.put(
            "/api/storage",
            json=StorageConfig(
                provider=StorageProvider.R2,
                auto_upload=False,
                bucket="my-calls",
                prefix="calls",
                endpoint="https://acct123.r2.cloudflarestorage.com",
                region="auto",
                access_key_id="AKIA1234",
                secret_access_key="supersecret9876",
            ).model_dump(),
        ).json()
        assert saved["connected"] is True
        assert saved["provider"] == "r2"
        assert saved["secret_hint"] == "••••9876"
        assert "supersecret9876" not in str(saved)
        assert (tmp_path / "rclone.ui.conf").exists()

        # New call with auto_upload=False stays disabled until manually queued
        c2 = client.post("/api/calls/start").json()
        c2_id = c2["call_id"]
        s2 = client.post("/api/calls/stop").json()
        assert s2["call"]["upload_status"] == UploadStatus.DISABLED.value

        # Bulk upload queues selected call
        bulk_up = client.post("/api/calls/bulk-upload", json={"call_ids": [c2_id]}).json()
        assert bulk_up["queued"] == 1
        assert bulk_up["calls"][0]["upload_status"] == UploadStatus.PENDING.value

        # Toggle auto_upload=True without re-sending secret -> secret preserved
        toggled = client.put(
            "/api/storage",
            json={
                "provider": "r2",
                "auto_upload": True,
                "bucket": "my-calls",
                "prefix": "calls",
                "endpoint": "https://acct123.r2.cloudflarestorage.com",
                "region": "auto",
                "access_key_id": "AKIA1234",
                "secret_access_key": "",
            },
        ).json()
        assert toggled["connected"] is True
        assert toggled["auto_upload"] is True
        assert toggled["has_secret"] is True

        # Search calls by title
        found = client.get("/api/calls", params={"q": "lesson"}).json()
        assert len(found) == 1
        assert found[0]["call_id"] == c1_id

        # Delete single record removes DB entry and directory
        c1_dir = cfg.recordings_dir / renamed["local_rel_dir"]
        assert c1_dir.exists()
        assert client.delete(f"/api/calls/{c1_id}").status_code == 200
        assert not c1_dir.exists()
        assert client.get(f"/api/calls/{c1_id}").status_code == 404

        # Bulk delete remaining call
        del_res = client.post("/api/calls/bulk-delete", json={"call_ids": [c2_id]}).json()
        assert del_res["deleted"] == 1
        assert client.get("/api/calls").json() == []

        # Disconnect storage
        disc = client.delete("/api/storage").json()
        assert disc["connected"] is False
        assert not (tmp_path / "rclone.ui.conf").exists()


async def test_waveform_generation_from_real_audio(tmp_path: Path) -> None:
    from calltap.models import CallFiles, CallMetadata
    from calltap.waveform import ensure_call_waveform

    call_dir = tmp_path / "2026/11/16/c-wave"
    call_dir.mkdir(parents=True)

    # Generate 1s test FLAC + Opus files with ffmpeg
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=1",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=880:duration=1",
        "-map",
        "0:a",
        "-c:a",
        "flac",
        str(call_dir / "you.flac"),
        "-map",
        "1:a",
        "-c:a",
        "flac",
        str(call_dir / "agent.flac"),
        "-map",
        "0:a",
        "-c:a",
        "libopus",
        str(call_dir / "mix.opus"),
    )
    rc = await proc.wait()
    assert rc == 0

    meta = CallMetadata(
        call_id="c-wave",
        local_rel_dir="2026/11/16/c-wave",
        status=CallStatus.COMPLETED,
        files=CallFiles(you="you.flac", agent="agent.flac", mix="mix.opus"),
    )
    wave = await ensure_call_waveform(call_dir, meta, bins=60)
    assert wave["bins"] == 60
    assert len(wave["tracks"]["you"]) == 60
    assert len(wave["tracks"]["agent"]) == 60
    assert len(wave["tracks"]["mix"]) == 60
    assert max(wave["tracks"]["you"]) > 0.5
    assert (call_dir / "peaks.json").exists()


def test_built_spa_and_assets_served(tmp_path: Path) -> None:
    cfg = Settings(
        data_dir=tmp_path,
        recordings_dir=tmp_path / "calls",
        db_path=tmp_path / "calltap.db",
        auto_detect=False,
    )
    app = create_app(cfg, start_background=False)
    with TestClient(app) as client:
        res = client.get("/")
        assert res.status_code == 200
        assert '<div id="root"></div>' in res.text
        assert "/assets/" in res.text


def test_unknown_service_preserves_url_and_clean_download_name(tmp_path: Path) -> None:
    from calltap.cdp import TabContext, classify_service_from_url

    assert classify_service_from_url("https://meet.google.com/abc-def") == "unknown"
    assert classify_service_from_url(None) == "unknown"
    assert classify_service_from_url("https://app.sesame.com") == "sesame"

    cfg = Settings(
        _env_file=None,
        data_dir=tmp_path,
        recordings_dir=tmp_path / "calls",
        db_path=tmp_path / "calltap.db",
        auto_detect=False,
    )
    assert cfg.default_service == "unknown"

    app = create_app(cfg, start_background=False)
    ctrl = app.state.controller
    ctrl.pulse.is_healthy = AsyncMock(return_value=True)
    ctrl.inspector.active_tab = AsyncMock(
        return_value=TabContext(
            service="unknown",
            url="https://meet.google.com/abc-defg-hij",
            title="Meet - abc-defg-hij",
        )
    )

    ctrl.recorder = _StubRecorder()  # type: ignore[assignment]

    with TestClient(app) as client:
        started = client.post("/api/calls/start").json()
        assert started["service"] == "unknown"
        assert started["page_url"] == "https://meet.google.com/abc-defg-hij"
        cid = started["call_id"]
        client.post("/api/calls/stop")

        dl_untitled = client.get(f"/api/calls/{cid}/audio/mix", params={"download": "true"})
        assert dl_untitled.status_code == 200
        assert "meet.google.com-" in dl_untitled.headers["content-disposition"]

        client.patch(f"/api/calls/{cid}", json={"title": "Weekly Team Sync"})
        dl_titled = client.get(f"/api/calls/{cid}/audio/mix", params={"download": "true"})
        assert 'filename="weekly-team-sync-mix.opus"' in dl_titled.headers["content-disposition"]


