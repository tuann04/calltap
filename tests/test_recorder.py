import asyncio
import shutil
from pathlib import Path

import pytest

from calltap.recorder import DualTrackRecorder, build_ffmpeg_command


def test_build_ffmpeg_command_with_mix(tmp_path: Path) -> None:
    cmd = build_ffmpeg_command(
        user_source="audio_input.monitor",
        agent_source="audio_output.monitor",
        you_path=tmp_path / "you.flac",
        agent_path=tmp_path / "agent.flac",
        mix_path=tmp_path / "mix.opus",
        sample_rate=48000,
    )
    assert "-f" in cmd and "pulse" in cmd
    assert "audio_input.monitor" in cmd
    assert "audio_output.monitor" in cmd
    fc_idx = cmd.index("-filter_complex") + 1
    assert "asplit=2[you_f][you_m]" in cmd[fc_idx]
    assert "amerge=inputs=2[mix]" in cmd[fc_idx]


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
async def test_dual_track_recorder_lavfi_end_to_end(tmp_path: Path) -> None:
    rec = DualTrackRecorder(
        pulse_server="",
        user_source="audio_input.monitor",
        agent_source="audio_output.monitor",
        sample_rate=48000,
        create_stereo_mix=True,
    )
    call_dir = tmp_path / "call-1"
    await rec.start(
        call_dir,
        input_format="lavfi",
        user_source_override="sine=frequency=440:sample_rate=48000",
        agent_source_override="sine=frequency=880:sample_rate=48000",
    )
    assert rec.is_recording
    await asyncio.sleep(0.8)
    result = await rec.stop()
    assert not rec.is_recording
    assert result.you_path.exists() and result.you_path.stat().st_size > 1000
    assert result.agent_path.exists() and result.agent_path.stat().st_size > 1000
    assert result.mix_path is not None
    assert result.mix_path.exists() and result.mix_path.stat().st_size > 500
    assert rec.silent_for_seconds == 0.0


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
async def test_dual_track_recorder_detects_silence_in_realtime(tmp_path: Path) -> None:
    rec = DualTrackRecorder(
        pulse_server="",
        user_source="audio_input.monitor",
        agent_source="audio_output.monitor",
        sample_rate=48000,
        create_stereo_mix=True,
    )
    call_dir = tmp_path / "call-silent"
    await rec.start(
        call_dir,
        input_format="lavfi",
        user_source_override="anullsrc=r=48000:cl=stereo",
        agent_source_override="anullsrc=r=48000:cl=stereo",
    )
    await asyncio.sleep(1.8)
    assert rec.silent_for_seconds > 0.2
    await rec.stop()
    assert rec.silent_for_seconds == 0.0
