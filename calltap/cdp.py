from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urlparse

import httpx

from calltap.utils import extract_hostname


@dataclass(frozen=True)
class TabContext:
    service: str
    url: str | None = None
    title: str | None = None


_DOMAIN_TO_SERVICE: list[tuple[str, str]] = [
    ("sesame.com", "sesame"),
    ("chatgpt.com", "chatgpt"),
    ("chat.openai.com", "chatgpt"),
    ("gemini.google.com", "gemini"),
    ("aistudio.google.com", "gemini-studio"),
    ("hume.ai", "hume"),
    ("elevenlabs.io", "elevenlabs"),
    ("vapi.ai", "vapi"),
    ("retellai.com", "retell"),
]


def classify_service_from_url(url: str | None, default: str = "unknown") -> str:
    host = extract_hostname(url)
    if not host:
        return default
    for domain, service in _DOMAIN_TO_SERVICE:
        if host == domain or host.endswith(f".{domain}"):
            return service
    return default


class ChromeInspector:
    """Optional Chrome DevTools Protocol inspector for service detection."""

    def __init__(self, cdp_url: str, default_service: str = "unknown") -> None:
        self.cdp_url = cdp_url.rstrip("/")
        self.default_service = default_service
        self._client: httpx.AsyncClient | None = None

    def _http(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(timeout=1.5)
        return self._client

    async def close(self) -> None:
        if self._client is not None and not self._client.is_closed:
            await self._client.aclose()
            self._client = None

    async def active_tab(self) -> TabContext:
        if not self.cdp_url:
            return TabContext(service=self.default_service)
        try:
            port = urlparse(self.cdp_url).port or 9222
            # Chrome rejects non-localhost Host headers on CDP HTTP endpoints.
            headers = {"Host": f"localhost:{port}"}
            resp = await self._http().get(f"{self.cdp_url}/json/list", headers=headers)
            resp.raise_for_status()
            targets = resp.json()
        except (httpx.HTTPError, ValueError):
            return TabContext(service=self.default_service)

        pages = [
            t
            for t in targets
            if t.get("type") == "page" and str(t.get("url", "")).startswith(("http://", "https://"))
        ]
        if not pages:
            return TabContext(service=self.default_service)

        # Prefer a known voice-agent tab if multiple tabs are open.
        chosen = next(
            (p for p in pages if classify_service_from_url(p.get("url"), "") != ""),
            pages[0],
        )
        url = chosen.get("url")
        return TabContext(
            service=classify_service_from_url(url, default=self.default_service),
            url=url,
            title=chosen.get("title"),
        )
