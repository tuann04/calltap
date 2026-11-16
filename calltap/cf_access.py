from __future__ import annotations

import asyncio
import logging
import secrets
import time
from typing import TYPE_CHECKING, Annotated, Any

import httpx
import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPBasic, HTTPBasicCredentials

if TYPE_CHECKING:
    from calltap.config import Settings

logger = logging.getLogger(__name__)
_http_basic = HTTPBasic(auto_error=False)


def normalize_team_domain(team: str) -> str:
    raw = team.strip()
    if "://" in raw:
        raw = raw.split("://", 1)[1]
    raw = raw.split("/", 1)[0].strip()
    if raw and "." not in raw:
        raw = f"{raw}.cloudflareaccess.com"
    return raw


class CloudflareAccessVerifier:
    """Verifies Cf-Access-Jwt-Assertion RS256 tokens against Cloudflare Access JWKS."""

    def __init__(
        self,
        team: str,
        audience: str,
        allowed_emails: set[str] | None = None,
        *,
        cache_ttl_seconds: float = 3600.0,
        jwks_override: dict[str, Any] | None = None,
    ) -> None:
        self.domain = normalize_team_domain(team)
        self.audience = audience.strip()
        self.allowed_emails = {e.strip().lower() for e in (allowed_emails or set()) if e.strip()}
        self.cache_ttl_seconds = cache_ttl_seconds
        self._jwks_override = jwks_override

        self._keys: dict[str, Any] = {}
        self._fetched_at: float = 0.0
        self._lock = asyncio.Lock()

    @property
    def enabled(self) -> bool:
        return bool(self.domain and self.audience)

    @property
    def issuer(self) -> str:
        return f"https://{self.domain}"

    @property
    def certs_url(self) -> str:
        return f"https://{self.domain}/cdn-cgi/access/certs"

    def _load_jwks(self, payload: dict[str, Any]) -> dict[str, Any]:
        loaded: dict[str, Any] = {}
        for jwk_dict in payload.get("keys", []):
            kid = jwk_dict.get("kid")
            if not kid:
                continue
            try:
                loaded[kid] = jwt.PyJWK.from_dict(jwk_dict).key
            except (jwt.PyJWTError, ValueError, KeyError, TypeError) as exc:
                logger.warning("Skipping invalid JWK %s: %s", kid, exc)
        return loaded

    async def _get_key(self, kid: str) -> Any | None:
        now = time.monotonic()
        if self._jwks_override is not None:
            if not self._keys:
                self._keys = self._load_jwks(self._jwks_override)
            return self._keys.get(kid)

        if kid in self._keys and (now - self._fetched_at) < self.cache_ttl_seconds:
            return self._keys[kid]

        async with self._lock:
            now = time.monotonic()
            if kid in self._keys and (now - self._fetched_at) < self.cache_ttl_seconds:
                return self._keys[kid]
            try:
                async with httpx.AsyncClient(timeout=5.0) as client:
                    resp = await client.get(self.certs_url)
                    resp.raise_for_status()
                    payload = resp.json()
                self._keys = self._load_jwks(payload)
                self._fetched_at = time.monotonic()
            except (httpx.HTTPError, ValueError) as exc:
                logger.warning("Failed to fetch Cloudflare Access JWKS: %s", exc)
        return self._keys.get(kid)

    async def verify(self, token: str) -> dict[str, Any] | None:
        if not self.enabled or not token:
            return None
        try:
            header = jwt.get_unverified_header(token)
        except jwt.PyJWTError:
            return None
        kid = header.get("kid")
        if not kid:
            return None

        key = await self._get_key(kid)
        if key is None:
            return None

        try:
            claims = jwt.decode(
                token,
                key=key,
                algorithms=["RS256"],
                audience=self.audience,
                issuer=self.issuer,
            )
        except jwt.PyJWTError:
            return None

        if self.allowed_emails:
            email = str(claims.get("email") or "").strip().lower()
            if email not in self.allowed_emails:
                return None

        return claims


def build_auth_dependency(cfg: Settings, access_verifier: CloudflareAccessVerifier) -> Any:
    """Create the FastAPI dependency enforcing Cloudflare Access JWT or HTTP Basic Auth."""

    async def require_auth(
        request: Request,
        credentials: Annotated[HTTPBasicCredentials | None, Depends(_http_basic)],
    ) -> None:
        if access_verifier.enabled:
            cf_jwt = request.headers.get("cf-access-jwt-assertion") or request.cookies.get(
                "CF_Authorization"
            )
            if cf_jwt and await access_verifier.verify(cf_jwt) is not None:
                return

        user = cfg.dashboard_user.strip()
        pw = cfg.dashboard_pass
        if not user:
            if access_verifier.enabled:
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Cloudflare Access authentication required",
                )
            return
        if credentials is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Authentication required",
                headers={"WWW-Authenticate": "Basic"},
            )
        user_ok = secrets.compare_digest(credentials.username.encode(), user.encode())
        pass_ok = secrets.compare_digest(credentials.password.encode(), pw.encode())
        if not (user_ok and pass_ok):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid credentials",
                headers={"WWW-Authenticate": "Basic"},
            )

    return require_auth
