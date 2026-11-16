from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import urlparse


def atomic_write_text(path: Path, content: str, *, mode: int | None = None) -> None:
    """Write text atomically via a sibling .tmp file, optionally enforcing file mode."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.tmp")
    if mode is None:
        tmp.write_text(content, encoding="utf-8")
    else:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
    tmp.replace(path)


def extract_hostname(url: str | None) -> str | None:
    """Return lowercase hostname without leading 'www.', or None if invalid/empty."""
    if not url:
        return None
    host = (urlparse(url).hostname or "").lower().removeprefix("www.")
    return host or None
