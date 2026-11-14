from pathlib import Path
from unittest.mock import AsyncMock

from fastapi.testclient import TestClient

from calltap.app import create_app
from calltap.config import Settings
from calltap.recorder import RecordingResult


def test_app_dashboard_and_call_lifecycle(tmp_path: Path) -> None:
    cfg = Settings(
        data_dir=tmp_path,
        recordings_dir=tmp_path / "calls",
        db_path=tmp_path / "calltap.db",
        auto_detect=False,
        dashboard_user="tuan",
        dashboard_pass="secret",
    )
    app = create_app(cfg, start_background=False)

    # Stub recorder and pulse so API test runs without PulseAudio daemon.
    ctrl = app.state.controller
    ctrl.pulse.is_healthy = AsyncMock(return_value=True)
    ctrl.inspector.active_tab = AsyncMock(
        return_value=ctrl.inspector.active_tab.return_value
        if hasattr(ctrl.inspector.active_tab, "return_value")
        else None
    )
    from calltap.cdp import TabContext

    ctrl.inspector.active_tab = AsyncMock(
        return_value=TabContext(service="sesame", url="https://app.sesame.com", title="Sesame")
    )

    recording_dir_holder: dict[str, Path] = {}

    async def fake_start(call_dir: Path, **_kwargs) -> None:
        recording_dir_holder["dir"] = call_dir
        (call_dir / "you.flac").write_bytes(b"fLaC-you")
        (call_dir / "agent.flac").write_bytes(b"fLaC-agent")
        (call_dir / "mix.opus").write_bytes(b"OggS-mix")
        ctrl.recorder._proc = object()  # mark active

    async def fake_stop() -> RecordingResult:
        d = recording_dir_holder["dir"]
        ctrl.recorder._proc = None
        return RecordingResult(
            you_path=d / "you.flac",
            agent_path=d / "agent.flac",
            mix_path=d / "mix.opus",
            exit_code=0,
            stderr_tail="",
        )

    ctrl.recorder.start = fake_start  # type: ignore[method-assign]
    ctrl.recorder.stop = fake_stop  # type: ignore[method-assign]
    type(ctrl.recorder).is_recording = property(lambda self: self._proc is not None)  # type: ignore[misc]

    with TestClient(app) as client:
        # Unauthenticated request fails when dashboard_user is configured
        assert client.get("/").status_code == 401
        assert client.get("/healthz").status_code == 200

        auth = ("tuan", "secret")
        assert client.get("/", auth=auth).status_code == 200

        r_start = client.post("/api/calls/start", json={"tags": ["practice"]}, auth=auth)
        assert r_start.status_code == 200
        call_id = r_start.json()["call_id"]
        assert r_start.json()["service"] == "sesame"

        r_stop = client.post("/api/calls/stop", auth=auth)
        assert r_stop.status_code == 200
        assert r_stop.json()["stopped"] is True

        r_patch = client.patch(
            f"/api/calls/{call_id}",
            json={"tags": ["sesame", "pronunciation"], "notes": "good pacing"},
            auth=auth,
        )
        assert r_patch.status_code == 200
        assert r_patch.json()["notes"] == "good pacing"

        r_audio = client.get(f"/api/calls/{call_id}/audio/you", auth=auth)
        assert r_audio.status_code == 200
        assert r_audio.content == b"fLaC-you"
