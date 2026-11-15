from __future__ import annotations

import asyncio
import json
from array import array
from pathlib import Path
from typing import Any

from calltap.models import CallMetadata

DEFAULT_BINS = 180
SAMPLE_RATE = 8000


def _downsample_pcm_peaks(pcm_bytes: bytes, bins: int = DEFAULT_BINS) -> tuple[list[float], float]:
    samples = array("h")
    usable = len(pcm_bytes) - (len(pcm_bytes) % 2)
    if usable <= 0:
        return [0.0] * bins, 0.0
    samples.frombytes(pcm_bytes[:usable])
    total = len(samples)
    duration = round(total / SAMPLE_RATE, 2)
    if total == 0:
        return [0.0] * bins, 0.0

    raw_peaks: list[int] = []
    for i in range(bins):
        start = (i * total) // bins
        end = ((i + 1) * total) // bins
        if end <= start:
            end = min(total, start + 1)
        peak = 0
        for val in samples[start:end]:
            av = -val if val < 0 else val
            peak = max(peak, av)
        raw_peaks.append(peak)

    max_peak = max(raw_peaks) or 1
    # Normalize relative to track's own dynamic range when audible, avoiding noise floor blowup.
    floor = max(max_peak, 1024)
    normalized = [round(min(1.0, p / floor), 3) for p in raw_peaks]
    return normalized, duration


async def extract_track_peaks(audio_path: Path, bins: int = DEFAULT_BINS) -> tuple[list[float], float]:
    if not audio_path.exists():
        return [], 0.0
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(audio_path),
        "-vn",
        "-ac",
        "1",
        "-ar",
        str(SAMPLE_RATE),
        "-f",
        "s16le",
        "pipe:1",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, _ = await proc.communicate()
    if proc.returncode != 0 or not stdout:
        return [], 0.0
    return _downsample_pcm_peaks(stdout, bins=bins)


async def ensure_call_waveform(
    call_dir: Path, meta: CallMetadata, *, bins: int = DEFAULT_BINS
) -> dict[str, Any]:
    peaks_path = call_dir / "peaks.json"
    if peaks_path.exists():
        try:
            cached = json.loads(peaks_path.read_text(encoding="utf-8"))
            if isinstance(cached, dict) and "tracks" in cached:
                return cached
        except (OSError, ValueError):
            pass

    tracks: dict[str, list[float]] = {}
    durations: list[float] = []

    candidates: list[tuple[str, str | None]] = [
        ("you", meta.files.you),
        ("agent", meta.files.agent),
        ("mix", meta.files.mix),
    ]
    for track_name, filename in candidates:
        if not filename:
            continue
        fpath = call_dir / filename
        if fpath.exists():
            peaks, dur = await extract_track_peaks(fpath, bins=bins)
            if peaks:
                tracks[track_name] = peaks
            if dur > 0:
                durations.append(dur)

    payload: dict[str, Any] = {
        "call_id": meta.call_id,
        "bins": bins,
        "duration_seconds": meta.duration_seconds or (max(durations) if durations else 0.0),
        "tracks": tracks,
    }
    if tracks and call_dir.exists():
        tmp = call_dir / "peaks.json.tmp"
        tmp.write_text(json.dumps(payload), encoding="utf-8")
        tmp.replace(peaks_path)
    return payload
