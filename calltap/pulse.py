from __future__ import annotations

import asyncio
import os
import re
from dataclasses import dataclass


@dataclass(frozen=True)
class SourceOutput:
    index: int
    source_index: int | None
    source_name: str | None
    corked: bool
    app_name: str
    binary: str


_SOURCE_OUTPUT_HEADER = re.compile(r"^Source Output #(\d+)\s*$")
_PROP_KV = re.compile(r'^\s*([A-Za-z0-9_.-]+)\s*=\s*"(.*)"\s*$')


def parse_sources_short(output: str) -> dict[int, str]:
    """Parse `pactl list sources short` into {index: name}."""
    mapping: dict[int, str] = {}
    for line in output.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0].isdigit():
            mapping[int(parts[0])] = parts[1]
    return mapping


def parse_source_outputs(
    output: str, sources_by_index: dict[int, str] | None = None
) -> list[SourceOutput]:
    """Parse `pactl list source-outputs` into structured records."""
    sources_by_index = sources_by_index or {}
    results: list[SourceOutput] = []
    current: dict[str, object] | None = None

    def flush() -> None:
        if current is None:
            return
        src_idx = current.get("source_index")
        src_name = current.get("source_name")
        if src_name is None and isinstance(src_idx, int):
            src_name = sources_by_index.get(src_idx)
        results.append(
            SourceOutput(
                index=int(current["index"]),  # type: ignore[arg-type]
                source_index=src_idx if isinstance(src_idx, int) else None,
                source_name=str(src_name) if src_name is not None else None,
                corked=bool(current.get("corked", False)),
                app_name=str(current.get("app_name", "")),
                binary=str(current.get("binary", "")),
            )
        )

    for raw in output.splitlines():
        line = raw.rstrip("\r\n")
        m_hdr = _SOURCE_OUTPUT_HEADER.match(line.strip())
        if m_hdr:
            flush()
            current = {"index": int(m_hdr.group(1))}
            continue
        if current is None:
            continue

        stripped = line.strip()
        if stripped.startswith("Source:"):
            val = stripped.split(":", 1)[1].strip()
            if val.isdigit():
                current["source_index"] = int(val)
            else:
                current["source_name"] = val
        elif stripped.startswith("Corked:"):
            current["corked"] = stripped.split(":", 1)[1].strip().lower() == "yes"
        else:
            m_prop = _PROP_KV.match(stripped)
            if m_prop:
                key, val = m_prop.group(1), m_prop.group(2)
                if key == "application.name":
                    current["app_name"] = val
                elif key == "application.process.binary":
                    current["binary"] = val

    flush()
    return results


def is_browser_capturing_mic(
    source_outputs: list[SourceOutput],
    mic_source_names: list[str],
    browser_hints: list[str],
) -> SourceOutput | None:
    """Return the first active browser source-output reading a virtual mic source."""
    mic_set = set(mic_source_names)
    hints = tuple(h.lower() for h in browser_hints)
    ignored = ("ffmpeg", "parec", "pacat", "gst-launch")

    for so in source_outputs:
        if so.corked:
            continue
        if so.source_name and so.source_name not in mic_set:
            continue
        if so.source_name is None:
            continue
        ident = f"{so.binary} {so.app_name}".lower()
        if any(ig in ident for ig in ignored):
            continue
        if any(h in ident for h in hints):
            return so
    return None


class PulseMonitor:
    """Queries PulseAudio via `pactl` to inspect active browser mic streams."""

    def __init__(
        self,
        pulse_server: str,
        mic_source_names: list[str],
        browser_hints: list[str],
    ) -> None:
        self.pulse_server = pulse_server
        self.mic_source_names = mic_source_names
        self.browser_hints = browser_hints

    def _env(self) -> dict[str, str]:
        env = os.environ.copy()
        if self.pulse_server:
            env["PULSE_SERVER"] = self.pulse_server
        return env

    async def _run_pactl(self, *args: str) -> str:
        proc = await asyncio.create_subprocess_exec(
            "pactl",
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=self._env(),
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=5.0)
        if proc.returncode != 0:
            raise RuntimeError(f"pactl {' '.join(args)} failed: {stderr.decode().strip()}")
        return stdout.decode(errors="replace")

    async def active_browser_capture(self) -> SourceOutput | None:
        sources_out, outputs_out = await asyncio.gather(
            self._run_pactl("list", "sources", "short"),
            self._run_pactl("list", "source-outputs"),
        )
        sources = parse_sources_short(sources_out)
        source_outputs = parse_source_outputs(outputs_out, sources)
        return is_browser_capturing_mic(
            source_outputs, self.mic_source_names, self.browser_hints
        )

    async def is_healthy(self) -> bool:
        try:
            await self._run_pactl("info")
            return True
        except (RuntimeError, OSError, TimeoutError):
            return False
