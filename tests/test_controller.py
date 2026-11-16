from pathlib import Path
from unittest.mock import AsyncMock

from calltap.cdp import TabContext
from calltap.config import Settings
from calltap.controller import CallController
from calltap.db import CallDB
from calltap.pulse import PulseMonitor, SourceOutput
from calltap.recorder import RecordingResult
from calltap.uploader import CloudUploader


class _FakeRecorder:
    def __init__(self) -> None:
        self.recording = False
        self.silent_for = 0.0
        self.call_dir: Path | None = None

    @property
    def is_recording(self) -> bool:
        return self.recording

    @property
    def silent_for_seconds(self) -> float:
        return self.silent_for

    async def start(self, call_dir: Path, **_kwargs) -> None:
        self.recording = True
        self.call_dir = call_dir
        call_dir.mkdir(parents=True, exist_ok=True)
        (call_dir / "you.flac").write_bytes(b"you")
        (call_dir / "agent.flac").write_bytes(b"agent")
        (call_dir / "mix.opus").write_bytes(b"mix")

    async def stop(self) -> RecordingResult:
        self.recording = False
        assert self.call_dir is not None
        return RecordingResult(
            you_path=self.call_dir / "you.flac",
            agent_path=self.call_dir / "agent.flac",
            mix_path=self.call_dir / "mix.opus",
            exit_code=0,
            stderr_tail="",
        )


def _make_controller(tmp_path: Path) -> tuple[CallController, CallDB]:
    cfg = Settings(
        data_dir=tmp_path,
        recordings_dir=tmp_path / "calls",
        db_path=tmp_path / "calltap.db",
        auto_detect=True,
        stop_grace_seconds=2.5,
        silence_stop_seconds=20.0,
        neko_metrics_url="",
        neko_disconnect_stop_seconds=10.0,
    )
    cfg.ensure_dirs()
    db = CallDB(cfg.db_path)
    pulse = PulseMonitor("", ["microphone"], ["chrome"])
    recorder = _FakeRecorder()
    uploader = CloudUploader(cfg, db)
    controller = CallController(
        cfg,
        db,
        pulse,
        recorder,  # type: ignore[arg-type]
        uploader,
        inspector=AsyncMock(
            active_tab=AsyncMock(
                return_value=TabContext(service="sesame", url="https://app.sesame.com")
            )
        ),
    )
    return controller, db


async def test_auto_stops_on_silence_and_suppresses_retrigger(tmp_path: Path) -> None:
    ctrl, db = _make_controller(tmp_path)
    so_41 = SourceOutput(
        index=41,
        source_index=2,
        source_name="microphone",
        corked=False,
        app_name="Google Chrome",
        binary="chrome",
    )
    ctrl.pulse.active_browser_capture = AsyncMock(return_value=so_41)  # type: ignore[method-assign]
    ctrl.pulse.sources_have_audio = AsyncMock(return_value=False)  # type: ignore[method-assign]

    # 1. Start auto call
    await ctrl._monitor_once(now_mono=10.0)
    assert ctrl.active_call is not None
    first_id = ctrl.active_call.call_id

    # 2. Chrome keeps SourceOutput #41 open, but both tracks are silent >= 20s -> auto-stop
    ctrl.recorder.silent_for = 21.0  # type: ignore[attr-defined]
    await ctrl._monitor_once(now_mono=31.0)
    assert ctrl.active_call is None

    # 3. Subsequent polls while #41 stays open and silent do NOT re-trigger
    await ctrl._monitor_once(now_mono=34.0)
    assert ctrl.active_call is None

    # 4. If audio returns on the same page (user starts second call), auto-record resumes
    ctrl.recorder.silent_for = 0.0  # type: ignore[attr-defined]
    ctrl.pulse.sources_have_audio = AsyncMock(return_value=True)  # type: ignore[method-assign]
    await ctrl._monitor_once(now_mono=37.0)
    assert ctrl.active_call is not None
    assert ctrl.active_call.call_id != first_id
    db.close()


async def test_auto_stops_on_neko_disconnect_and_manual_stop_stays_stopped(tmp_path: Path) -> None:
    ctrl, db = _make_controller(tmp_path)
    ctrl.settings.neko_metrics_url = "http://neko:8080/metrics"
    so_52 = SourceOutput(
        index=52,
        source_index=2,
        source_name="microphone",
        corked=False,
        app_name="Google Chrome",
        binary="chrome",
    )
    ctrl.pulse.active_browser_capture = AsyncMock(return_value=so_52)  # type: ignore[method-assign]
    ctrl.pulse.sources_have_audio = AsyncMock(return_value=True)  # type: ignore[method-assign]
    ctrl._neko_has_active_listeners = AsyncMock(return_value=True)  # type: ignore[method-assign]

    await ctrl._monitor_once(now_mono=10.0)
    assert ctrl.active_call is not None

    # Phone closes Neko tab -> 0 listeners for >= 10s -> auto-stop even if Chrome mic stays open
    ctrl._neko_has_active_listeners = AsyncMock(return_value=False)  # type: ignore[method-assign]
    await ctrl._monitor_once(now_mono=20.0)
    assert ctrl.active_call is not None  # grace timer just started
    await ctrl._monitor_once(now_mono=31.0)
    assert ctrl.active_call is None

    # Opening a new SourceOutput #53 starts a new recording; manual stop keeps it suppressed even with audio
    so_53 = SourceOutput(
        index=53,
        source_index=2,
        source_name="microphone",
        corked=False,
        app_name="Google Chrome",
        binary="chrome",
    )
    ctrl.pulse.active_browser_capture = AsyncMock(return_value=so_53)  # type: ignore[method-assign]
    ctrl._neko_has_active_listeners = AsyncMock(return_value=True)  # type: ignore[method-assign]
    await ctrl._monitor_once(now_mono=35.0)
    assert ctrl.active_call is not None

    await ctrl.stop_call(reason="manual")
    assert ctrl.active_call is None
    await ctrl._monitor_once(now_mono=40.0)
    assert ctrl.active_call is None
    db.close()
