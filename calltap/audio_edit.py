from __future__ import annotations

import asyncio
import contextlib
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from calltap.models import CallMetadata, CallStatus
from calltap.waveform import ensure_call_waveform

MIN_RESULT_SECONDS = 0.5
MIN_CUT_SECONDS = 0.1
EDGE_EPSILON = 0.02


async def probe_audio_duration(audio_path: Path) -> float:
    if not audio_path.exists():
        return 0.0
    proc = await asyncio.create_subprocess_exec(
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(audio_path),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, _ = await proc.communicate()
    if proc.returncode != 0:
        return 0.0
    try:
        value = float(stdout.decode().strip())
        return value if value > 0 else 0.0
    except ValueError:
        return 0.0


def _codec_args(path: Path) -> list[str]:
    if path.suffix.lower() == ".opus":
        return ["-c:a", "libopus", "-b:a", "96k"]
    return ["-c:a", "flac", "-compression_level", "5"]


def build_edit_ffmpeg_command(
    src: Path,
    dst: Path,
    *,
    mode: Literal["keep", "cut"],
    start_s: float,
    end_s: float,
    total_duration: float,
) -> list[str]:
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(src)]

    if mode == "keep":
        cmd.extend(["-af", f"atrim=start={start_s:.3f}:end={end_s:.3f},asetpts=PTS-STARTPTS"])
    elif start_s <= EDGE_EPSILON:
        cmd.extend(["-af", f"atrim=start={end_s:.3f},asetpts=PTS-STARTPTS"])
    elif end_s >= total_duration - EDGE_EPSILON:
        cmd.extend(["-af", f"atrim=end={start_s:.3f},asetpts=PTS-STARTPTS"])
    else:
        filter_graph = (
            f"[0:a]asplit=2[a][b];"
            f"[a]atrim=end={start_s:.3f},asetpts=PTS-STARTPTS[p1];"
            f"[b]atrim=start={end_s:.3f},asetpts=PTS-STARTPTS[p2];"
            f"[p1][p2]concat=n=2:v=0:a=1[out]"
        )
        cmd.extend(["-filter_complex", filter_graph, "-map", "[out]"])

    cmd.extend(_codec_args(dst))
    cmd.append(str(dst))
    return cmd


async def _run_ffmpeg_edit(cmd: list[str]) -> None:
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        msg = stderr.decode(errors="replace").strip() or f"ffmpeg exited with code {proc.returncode}"
        raise RuntimeError(msg)


async def edit_call_audio(
    call_dir: Path,
    meta: CallMetadata,
    *,
    mode: Literal["keep", "cut"],
    start_seconds: float,
    end_seconds: float,
) -> CallMetadata:
    if meta.status != CallStatus.COMPLETED:
        raise ValueError("Only completed recordings can be edited")
    if meta.local_pruned or not call_dir.exists():
        raise ValueError("Local audio files are missing or pruned")

    track_files: list[Path] = []
    for fname in (meta.files.mix, meta.files.you, meta.files.agent):
        if fname:
            fpath = call_dir / fname
            if fpath.exists():
                track_files.append(fpath)

    if not track_files:
        raise ValueError("No audio tracks found on disk")

    probed = await probe_audio_duration(track_files[0])
    total_duration = probed if probed > 0 else float(meta.duration_seconds or 0.0)
    if total_duration <= 0:
        raise ValueError("Unable to determine recording duration")

    start_s = round(max(0.0, start_seconds), 3)
    end_s = round(min(total_duration, end_seconds), 3)
    if start_s >= end_s:
        raise ValueError("End time must be after start time")

    if mode == "keep":
        if end_s - start_s < MIN_RESULT_SECONDS:
            raise ValueError(f"Kept selection must be at least {MIN_RESULT_SECONDS:.1f}s")
        if start_s <= EDGE_EPSILON and end_s >= total_duration - EDGE_EPSILON:
            raise ValueError("Selection already covers the entire recording")
        expected_duration = end_s - start_s
    else:
        if end_s - start_s < MIN_CUT_SECONDS:
            raise ValueError(f"Cut selection must be at least {MIN_CUT_SECONDS:.1f}s")
        expected_duration = total_duration - (end_s - start_s)
        if expected_duration < MIN_RESULT_SECONDS:
            raise ValueError(f"At least {MIN_RESULT_SECONDS:.1f}s must remain after cutting")

    staged: list[tuple[Path, Path]] = []
    try:
        tasks = []
        for orig in track_files:
            tmp = orig.with_name(f".edit.{orig.name}")
            staged.append((tmp, orig))
            cmd = build_edit_ffmpeg_command(
                orig,
                tmp,
                mode=mode,
                start_s=start_s,
                end_s=end_s,
                total_duration=total_duration,
            )
            tasks.append(_run_ffmpeg_edit(cmd))

        await asyncio.gather(*tasks)

        for tmp, _ in staged:
            if not tmp.exists() or tmp.stat().st_size == 0:
                raise RuntimeError(f"Edited track is empty: {tmp.name}")

        for tmp, orig in staged:
            os.replace(tmp, orig)
    finally:
        for tmp, _ in staged:
            with contextlib.suppress(OSError):
                tmp.unlink(missing_ok=True)

    new_duration = await probe_audio_duration(track_files[0])
    final_duration = round(new_duration if new_duration > 0 else expected_duration, 2)

    (call_dir / "peaks.json").unlink(missing_ok=True)
    updated = meta.model_copy(
        update={
            "duration_seconds": final_duration,
            "edited_at": datetime.now(UTC),
        }
    )
    await ensure_call_waveform(call_dir, updated)
    return updated
