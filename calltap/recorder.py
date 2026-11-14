from __future__ import annotations

import asyncio
import os
import signal
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class RecordingResult:
    you_path: Path
    agent_path: Path
    mix_path: Path | None
    exit_code: int
    stderr_tail: str


def build_ffmpeg_command(
    *,
    user_source: str,
    agent_source: str,
    you_path: Path,
    agent_path: Path,
    mix_path: Path | None,
    sample_rate: int = 48000,
    input_format: str = "pulse",
    extra_global_args: list[str] | None = None,
) -> list[str]:
    """Build a single-process ffmpeg command recording user + agent into synced separate files."""
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "warning", "-y"]
    if extra_global_args:
        cmd.extend(extra_global_args)

    # PulseAudio inputs use thread_queue_size so bursts never drop frames on either track.
    if input_format == "pulse":
        cmd.extend(
            [
                "-thread_queue_size",
                "1024",
                "-f",
                "pulse",
                "-ac",
                "2",
                "-ar",
                str(sample_rate),
                "-i",
                user_source,
                "-thread_queue_size",
                "1024",
                "-f",
                "pulse",
                "-ac",
                "2",
                "-ar",
                str(sample_rate),
                "-i",
                agent_source,
            ]
        )
    else:
        cmd.extend(["-f", input_format, "-i", user_source, "-f", input_format, "-i", agent_source])

    if mix_path is not None:
        filter_complex = (
            f"[0:a]aresample={sample_rate}:async=1:first_pts=0,"
            f"pan=mono|c0=0.5*c0+0.5*c1,asplit=2[you_f][you_m];"
            f"[1:a]aresample={sample_rate}:async=1:first_pts=0,"
            f"pan=mono|c0=0.5*c0+0.5*c1,asplit=2[agent_f][agent_m];"
            f"[you_m][agent_m]amerge=inputs=2[mix]"
        )
        cmd.extend(
            [
                "-filter_complex",
                filter_complex,
                "-map",
                "[you_f]",
                "-c:a",
                "flac",
                "-compression_level",
                "5",
                str(you_path),
                "-map",
                "[agent_f]",
                "-c:a",
                "flac",
                "-compression_level",
                "5",
                str(agent_path),
                "-map",
                "[mix]",
                "-c:a",
                "libopus",
                "-b:a",
                "96k",
                str(mix_path),
            ]
        )
    else:
        filter_complex = (
            f"[0:a]aresample={sample_rate}:async=1:first_pts=0,"
            f"pan=mono|c0=0.5*c0+0.5*c1[you_f];"
            f"[1:a]aresample={sample_rate}:async=1:first_pts=0,"
            f"pan=mono|c0=0.5*c0+0.5*c1[agent_f]"
        )
        cmd.extend(
            [
                "-filter_complex",
                filter_complex,
                "-map",
                "[you_f]",
                "-c:a",
                "flac",
                "-compression_level",
                "5",
                str(you_path),
                "-map",
                "[agent_f]",
                "-c:a",
                "flac",
                "-compression_level",
                "5",
                str(agent_path),
            ]
        )
    return cmd


class DualTrackRecorder:
    """Manages one active dual-track ffmpeg recording subprocess."""

    def __init__(
        self,
        *,
        pulse_server: str,
        user_source: str,
        agent_source: str,
        sample_rate: int = 48000,
        create_stereo_mix: bool = True,
    ) -> None:
        self.pulse_server = pulse_server
        self.user_source = user_source
        self.agent_source = agent_source
        self.sample_rate = sample_rate
        self.create_stereo_mix = create_stereo_mix

        self._proc: asyncio.subprocess.Process | None = None
        self._you_path: Path | None = None
        self._agent_path: Path | None = None
        self._mix_path: Path | None = None

    @property
    def is_recording(self) -> bool:
        return self._proc is not None and self._proc.returncode is None

    async def start(
        self,
        call_dir: Path,
        *,
        input_format: str = "pulse",
        user_source_override: str | None = None,
        agent_source_override: str | None = None,
        extra_global_args: list[str] | None = None,
    ) -> None:
        if self.is_recording:
            raise RuntimeError("Recorder is already running")

        call_dir.mkdir(parents=True, exist_ok=True)
        self._you_path = call_dir / "you.flac"
        self._agent_path = call_dir / "agent.flac"
        self._mix_path = (call_dir / "mix.opus") if self.create_stereo_mix else None

        cmd = build_ffmpeg_command(
            user_source=user_source_override or self.user_source,
            agent_source=agent_source_override or self.agent_source,
            you_path=self._you_path,
            agent_path=self._agent_path,
            mix_path=self._mix_path,
            sample_rate=self.sample_rate,
            input_format=input_format,
            extra_global_args=extra_global_args,
        )

        env = os.environ.copy()
        if self.pulse_server:
            env["PULSE_SERVER"] = self.pulse_server

        self._proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )

    async def stop(self, timeout: float = 8.0) -> RecordingResult:
        if self._proc is None or self._you_path is None or self._agent_path is None:
            raise RuntimeError("Recorder is not running")

        proc = self._proc
        stderr_data = b""

        if proc.returncode is None:
            # Sending 'q' on stdin lets ffmpeg flush FLAC/Opus headers cleanly.
            try:
                if proc.stdin is not None:
                    proc.stdin.write(b"q\n")
                    await proc.stdin.drain()
                    proc.stdin.close()
            except (BrokenPipeError, OSError):
                pass

            try:
                _, stderr_data = await asyncio.wait_for(proc.communicate(), timeout=timeout)
            except TimeoutError:
                proc.send_signal(signal.SIGINT)
                try:
                    _, stderr_data = await asyncio.wait_for(proc.communicate(), timeout=3.0)
                except TimeoutError:
                    proc.kill()
                    _, stderr_data = await proc.communicate()
        else:
            if proc.stderr is not None:
                stderr_data = await proc.stderr.read()

        result = RecordingResult(
            you_path=self._you_path,
            agent_path=self._agent_path,
            mix_path=self._mix_path,
            exit_code=proc.returncode or 0,
            stderr_tail=stderr_data.decode(errors="replace")[-1000:],
        )
        self._proc = None
        return result
