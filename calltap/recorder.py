from __future__ import annotations

import asyncio
import contextlib
import os
import re
import signal
from collections import deque
from dataclasses import dataclass
from pathlib import Path

_SILENCE_START_RE = re.compile(r"silence_start:\s*([0-9.+-eE]+)")
_SILENCE_END_RE = re.compile(r"silence_end:\s*([0-9.+-eE]+)")


@dataclass(frozen=True)
class RecordingResult:
    you_path: Path
    agent_path: Path
    mix_path: Path | None
    exit_code: int
    stderr_tail: str


def _input_args(source: str, input_format: str, sample_rate: int) -> list[str]:
    # PulseAudio inputs use thread_queue_size so bursts never drop frames on either track.
    if input_format == "pulse":
        return ["-thread_queue_size", "1024", "-f", "pulse", "-ac", "2", "-ar", str(sample_rate), "-i", source]
    return ["-f", input_format, "-i", source]


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
    silence_threshold_db: float = -55.0,
    enable_silence_detect: bool = True,
) -> list[str]:
    """Build a single-process ffmpeg command recording user + agent into synced separate files."""
    cmd = ["ffmpeg", "-hide_banner"]
    cmd.extend(["-loglevel", "info", "-nostats"] if enable_silence_detect else ["-loglevel", "warning"])
    cmd.append("-y")
    if extra_global_args:
        cmd.extend(extra_global_args)

    cmd.extend(_input_args(user_source, input_format, sample_rate))
    cmd.extend(_input_args(agent_source, input_format, sample_rate))

    need_merge = mix_path is not None or enable_silence_detect
    filters = []
    for idx, name in ((0, "you"), (1, "agent")):
        base = f"[{idx}:a]aresample={sample_rate}:async=1:first_pts=0,pan=mono|c0=0.5*c0+0.5*c1"
        if need_merge:
            filters.append(f"{base},asplit=2[{name}_f][{name}_m]")
        else:
            filters.append(f"{base}[{name}_f]")

    if mix_path is not None and enable_silence_detect:
        filters.append("[you_m][agent_m]amerge=inputs=2[mix]")
        filters.append("[mix]asplit=2[mix_out][sil_in]")
        filters.append(f"[sil_in]silencedetect=n={silence_threshold_db:.1f}dB:d=1[sil_out]")
        mix_map = "[mix_out]"
    elif mix_path is not None:
        filters.append("[you_m][agent_m]amerge=inputs=2[mix]")
        mix_map = "[mix]"
    elif enable_silence_detect:
        filters.append(f"[you_m][agent_m]amerge=inputs=2,silencedetect=n={silence_threshold_db:.1f}dB:d=1[sil_out]")
        mix_map = ""
    else:
        mix_map = ""

    cmd.extend([
        "-filter_complex", ";".join(filters),
        "-map", "[you_f]", "-c:a", "flac", "-compression_level", "5", str(you_path),
        "-map", "[agent_f]", "-c:a", "flac", "-compression_level", "5", str(agent_path),
    ])
    if mix_path is not None:
        cmd.extend(["-map", mix_map, "-c:a", "libopus", "-b:a", "96k", str(mix_path)])
    if enable_silence_detect:
        cmd.extend(["-map", "[sil_out]", "-f", "null", "-"])
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
        silence_threshold_db: float = -55.0,
    ) -> None:
        self.pulse_server = pulse_server
        self.user_source = user_source
        self.agent_source = agent_source
        self.sample_rate = sample_rate
        self.create_stereo_mix = create_stereo_mix
        self.silence_threshold_db = silence_threshold_db

        self._proc: asyncio.subprocess.Process | None = None
        self._you_path: Path | None = None
        self._agent_path: Path | None = None
        self._mix_path: Path | None = None
        self._stderr_task: asyncio.Task[None] | None = None
        self._stderr_lines: deque[str] = deque(maxlen=40)
        self._silence_started_at: float | None = None

    @property
    def is_recording(self) -> bool:
        return self._proc is not None and self._proc.returncode is None

    @property
    def silent_for_seconds(self) -> float:
        if not self.is_recording or self._silence_started_at is None:
            return 0.0
        try:
            loop = asyncio.get_running_loop()
            return max(0.0, loop.time() - self._silence_started_at)
        except RuntimeError:
            return 0.0

    async def _consume_stderr(self, proc: asyncio.subprocess.Process) -> None:
        if proc.stderr is None:
            return
        loop = asyncio.get_running_loop()
        while True:
            line = await proc.stderr.readline()
            if not line:
                break
            text = line.decode(errors="replace").rstrip()
            if not text:
                continue
            self._stderr_lines.append(text)
            if _SILENCE_START_RE.search(text):
                if self._silence_started_at is None:
                    self._silence_started_at = loop.time()
            elif _SILENCE_END_RE.search(text):
                self._silence_started_at = None

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
        self._stderr_lines.clear()
        self._silence_started_at = None

        cmd = build_ffmpeg_command(
            user_source=user_source_override or self.user_source,
            agent_source=agent_source_override or self.agent_source,
            you_path=self._you_path,
            agent_path=self._agent_path,
            mix_path=self._mix_path,
            sample_rate=self.sample_rate,
            input_format=input_format,
            extra_global_args=extra_global_args,
            silence_threshold_db=self.silence_threshold_db,
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
        self._stderr_task = asyncio.create_task(
            self._consume_stderr(self._proc), name="calltap-ffmpeg-stderr"
        )

    async def stop(self, timeout: float = 8.0) -> RecordingResult:
        if self._proc is None or self._you_path is None or self._agent_path is None:
            raise RuntimeError("Recorder is not running")

        proc = self._proc

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
                await asyncio.wait_for(proc.wait(), timeout=timeout)
            except TimeoutError:
                proc.send_signal(signal.SIGINT)
                try:
                    await asyncio.wait_for(proc.wait(), timeout=3.0)
                except TimeoutError:
                    proc.kill()
                    await proc.wait()

        if self._stderr_task is not None:
            with contextlib.suppress(asyncio.CancelledError):
                await asyncio.wait_for(self._stderr_task, timeout=2.0)
            self._stderr_task = None

        stderr_tail = "\n".join(self._stderr_lines)[-1000:]
        result = RecordingResult(
            you_path=self._you_path,
            agent_path=self._agent_path,
            mix_path=self._mix_path,
            exit_code=proc.returncode or 0,
            stderr_tail=stderr_tail,
        )
        self._proc = None
        self._silence_started_at = None
        return result
