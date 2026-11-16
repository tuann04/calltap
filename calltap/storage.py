from __future__ import annotations

import asyncio
import configparser
import json
import os
import tempfile
from dataclasses import dataclass
from io import StringIO
from pathlib import Path

from calltap.config import Settings
from calltap.models import StorageConfig, StorageProvider, StoragePublicView
from calltap.utils import atomic_write_text


@dataclass(frozen=True)
class RcloneTarget:
    remote: str
    prefix: str
    config_path: Path | None
    auto_upload: bool
    source: str  # "ui" | "env"


def _mask_secret(secret: str) -> str:
    s = secret.strip()
    if not s:
        return ""
    if len(s) <= 4:
        return "••••"
    return f"••••{s[-4:]}"


def _normalize_gdrive_token(raw: str) -> str:
    text = raw.strip()
    if not text:
        return ""
    # Allow users to paste `token = {...}` from rclone.conf directly.
    if text.startswith("token"):
        _, _, rhs = text.partition("=")
        text = rhs.strip()
    parsed = json.loads(text)
    if not isinstance(parsed, dict) or "access_token" not in parsed:
        raise ValueError("Google Drive token must be a JSON object containing access_token")
    return json.dumps(parsed, separators=(",", ":"))


def _normalize_endpoint(endpoint: str) -> str:
    ep = endpoint.strip()
    if ep and not ep.startswith(("http://", "https://")):
        ep = f"https://{ep}"
    return ep.rstrip("/")


_S3_RCLONE_PROVIDERS = {
    StorageProvider.R2: "Cloudflare",
    StorageProvider.S3: "AWS",
    StorageProvider.B2: "Other",
    StorageProvider.CUSTOM_S3: "Other",
}


def render_rclone_ini(cfg: StorageConfig) -> str:
    cp = configparser.ConfigParser(interpolation=None)
    sec = "calltap_remote"

    if cfg.provider in _S3_RCLONE_PROVIDERS:
        default_region = "auto" if cfg.provider == StorageProvider.R2 else "us-east-1"
        cp[sec] = {
            "type": "s3",
            "provider": _S3_RCLONE_PROVIDERS[cfg.provider],
            "env_auth": "false",
            "access_key_id": cfg.access_key_id.strip(),
            "secret_access_key": cfg.secret_access_key.strip(),
            "region": (cfg.region or default_region).strip(),
            "no_check_bucket": "true",
        }
        ep = _normalize_endpoint(cfg.endpoint)
        if ep:
            cp[sec]["endpoint"] = ep
    elif cfg.provider == StorageProvider.GDRIVE:
        cp[sec] = {
            "type": "drive",
            "scope": "drive.file",
            "token": _normalize_gdrive_token(cfg.gdrive_token_json),
        }
        if cfg.gdrive_client_id.strip():
            cp[sec]["client_id"] = cfg.gdrive_client_id.strip()
        if cfg.gdrive_client_secret.strip():
            cp[sec]["client_secret"] = cfg.gdrive_client_secret.strip()
        if cfg.gdrive_root_folder_id.strip():
            cp[sec]["root_folder_id"] = cfg.gdrive_root_folder_id.strip()

    buf = StringIO()
    cp.write(buf)
    return buf.getvalue()


def _remote_for_config(cfg: StorageConfig) -> str:
    bucket = cfg.bucket.strip().strip("/")
    if cfg.provider == StorageProvider.GDRIVE:
        return f"calltap_remote:{bucket}" if bucket else "calltap_remote:CallTap"
    if not bucket:
        raise ValueError("Bucket name is required")
    return f"calltap_remote:{bucket}"


class StorageManager:
    """Manages runtime cloud storage connection persisted in /data/storage.json."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.storage_file = settings.data_dir / "storage.json"
        self.rclone_ui_conf = settings.data_dir / "rclone.ui.conf"

    def _read_ui_config(self) -> StorageConfig | None:
        if not self.storage_file.exists():
            return None
        try:
            return StorageConfig.model_validate_json(
                self.storage_file.read_text(encoding="utf-8")
            )
        except (OSError, ValueError):
            return None

    def resolve_target(self) -> RcloneTarget | None:
        ui = self._read_ui_config()
        if ui is not None:
            if ui.provider == StorageProvider.NONE:
                return None
            if not self.rclone_ui_conf.exists():
                self._write_rclone_conf(ui)
            return RcloneTarget(
                remote=_remote_for_config(ui),
                prefix=ui.prefix.strip("/"),
                config_path=self.rclone_ui_conf,
                auto_upload=ui.auto_upload,
                source="ui",
            )

        env_remote = self.settings.rclone_remote.strip()
        if env_remote:
            return RcloneTarget(
                remote=env_remote,
                prefix=self.settings.rclone_remote_prefix.strip("/"),
                config_path=self.settings.rclone_config
                if self.settings.rclone_config.exists()
                else None,
                auto_upload=True,
                source="env",
            )
        return None

    def public_view(self) -> StoragePublicView:
        ui = self._read_ui_config()
        if ui is not None and ui.provider != StorageProvider.NONE:
            remote_label = (
                f"gdrive:{ui.bucket or 'CallTap'}"
                if ui.provider == StorageProvider.GDRIVE
                else f"{ui.provider.value}:{ui.bucket}"
            )
            return StoragePublicView(
                connected=True,
                source="ui",
                provider=ui.provider,
                auto_upload=ui.auto_upload,
                bucket=ui.bucket,
                prefix=ui.prefix,
                endpoint=ui.endpoint,
                region=ui.region,
                access_key_id=ui.access_key_id,
                has_secret=bool(ui.secret_access_key),
                secret_hint=_mask_secret(ui.secret_access_key),
                has_gdrive_token=bool(ui.gdrive_token_json),
                gdrive_client_id=ui.gdrive_client_id,
                gdrive_root_folder_id=ui.gdrive_root_folder_id,
                remote_label=remote_label,
            )

        env_remote = self.settings.rclone_remote.strip() if ui is None else ""
        if env_remote:
            return StoragePublicView(
                connected=True,
                source="env",
                provider=StorageProvider.CUSTOM_S3,
                auto_upload=True,
                prefix=self.settings.rclone_remote_prefix,
                remote_label=env_remote,
            )

        return StoragePublicView(
            connected=False,
            source="none",
            provider=StorageProvider.NONE,
            auto_upload=ui.auto_upload if ui is not None else True,
            prefix=(ui.prefix or "calls") if ui is not None else "calls",
            remote_label="Local storage only",
        )

    def _validate_and_merge(self, incoming: StorageConfig) -> StorageConfig:
        existing = self._read_ui_config() or StorageConfig()
        merged = incoming.model_copy()

        if merged.provider == StorageProvider.NONE:
            return StorageConfig(
                provider=StorageProvider.NONE,
                auto_upload=merged.auto_upload,
                prefix=merged.prefix or "calls",
            )

        # Preserve existing secrets if omitted during an update (e.g. toggling auto_upload).
        if existing.provider == merged.provider:
            if not merged.secret_access_key.strip():
                merged.secret_access_key = existing.secret_access_key
            if not merged.gdrive_token_json.strip():
                merged.gdrive_token_json = existing.gdrive_token_json
            if not merged.gdrive_client_secret.strip():
                merged.gdrive_client_secret = existing.gdrive_client_secret

        merged.prefix = (merged.prefix or "calls").strip().strip("/")
        merged.bucket = merged.bucket.strip().strip("/")
        merged.endpoint = _normalize_endpoint(merged.endpoint)

        if merged.provider == StorageProvider.GDRIVE:
            if not merged.gdrive_token_json.strip():
                raise ValueError("Google Drive OAuth token JSON is required")
            merged.gdrive_token_json = _normalize_gdrive_token(merged.gdrive_token_json)
            if not merged.bucket:
                merged.bucket = "CallTap"
        else:
            if not merged.bucket:
                raise ValueError("Bucket name is required")
            if not merged.access_key_id.strip():
                raise ValueError("Access Key ID is required")
            if not merged.secret_access_key.strip():
                raise ValueError("Secret Access Key is required")
            if merged.provider in (StorageProvider.R2, StorageProvider.B2, StorageProvider.CUSTOM_S3) and not merged.endpoint:
                raise ValueError("Endpoint URL is required for this provider")

        return merged

    def _write_rclone_conf(self, cfg: StorageConfig) -> None:
        atomic_write_text(self.rclone_ui_conf, render_rclone_ini(cfg), mode=0o600)

    def save(self, incoming: StorageConfig) -> StoragePublicView:
        merged = self._validate_and_merge(incoming)
        atomic_write_text(self.storage_file, merged.model_dump_json(indent=2) + "\n", mode=0o600)

        if merged.provider == StorageProvider.NONE:
            self.rclone_ui_conf.unlink(missing_ok=True)
        else:
            self._write_rclone_conf(merged)

        return self.public_view()

    def disconnect(self) -> StoragePublicView:
        return self.save(StorageConfig(provider=StorageProvider.NONE, auto_upload=True))

    async def test_connection(self, incoming: StorageConfig | None = None) -> tuple[bool, str]:
        cfg = self._validate_and_merge(incoming) if incoming is not None else self._read_ui_config()
        if cfg is None or cfg.provider == StorageProvider.NONE:
            target = self.resolve_target()
            if target is None:
                return False, "No cloud storage configured"
            args = ["rclone", "lsf", target.remote, "--max-depth", "1"]
            if target.config_path:
                args[1:1] = ["--config", str(target.config_path)]
            return await self._run_test_cmd(args, target.remote)

        ini_text = render_rclone_ini(cfg)
        remote = _remote_for_config(cfg)
        fd, tmp_path = tempfile.mkstemp(prefix="calltap-rclone-test-", suffix=".conf")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(ini_text)
            # For Google Drive, list root to verify OAuth even if CallTap folder doesn't exist yet.
            target_remote = "calltap_remote:" if cfg.provider == StorageProvider.GDRIVE else remote
            args = ["rclone", "--config", tmp_path, "lsf", target_remote, "--max-depth", "1"]
            return await self._run_test_cmd(args, remote)
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

    async def _run_test_cmd(self, args: list[str], label: str) -> tuple[bool, str]:
        try:
            proc = await asyncio.create_subprocess_exec(
                *args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=15.0)
        except TimeoutError:
            return False, "Connection timed out after 15s"
        except OSError as exc:
            return False, f"Failed to run rclone: {exc}"

        out = stdout.decode(errors="replace").strip()
        if proc.returncode == 0:
            return True, f"Connected to {label}"
        return False, out[-500:] or f"rclone exited with code {proc.returncode}"
