from __future__ import annotations

import asyncio
import logging
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx

from calltap.config import Settings
from calltap.db import CallDB
from calltap.models import CallMetadata, UploadStatus
from calltap.storage import RcloneTarget, StorageManager
from calltap.telemetry import UPLOAD_DURATION, UPLOADS_TOTAL, start_span
from calltap.waveform import ensure_call_waveform

logger = logging.getLogger(__name__)


def build_remote_uri(remote: str, prefix: str, local_rel_dir: str) -> str:
    remote_clean = remote.rstrip("/")
    prefix_clean = prefix.strip("/")
    rel_clean = local_rel_dir.strip("/")
    if prefix_clean:
        return f"{remote_clean}/{prefix_clean}/{rel_clean}"
    return f"{remote_clean}/{rel_clean}"


def backoff_seconds(attempt: int) -> int:
    # 10s, 20s, 40s, 80s, ... capped at 1 hour
    return min(3600, 10 * (2 ** max(0, attempt - 1)))


def write_meta_file(call_dir: Path, meta: CallMetadata) -> None:
    call_dir.mkdir(parents=True, exist_ok=True)
    tmp = call_dir / "meta.json.tmp"
    target = call_dir / "meta.json"
    tmp.write_text(meta.model_dump_json(indent=2) + "\n", encoding="utf-8")
    tmp.replace(target)


class CloudUploader:
    """Uploads completed call directories to cloud storage via rclone with retries + verification."""

    def __init__(
        self,
        settings: Settings,
        db: CallDB,
        storage: StorageManager | None = None,
    ) -> None:
        self.settings = settings
        self.db = db
        self.storage = storage or StorageManager(settings)

    def _target(self) -> RcloneTarget | None:
        return self.storage.resolve_target()

    @property
    def enabled(self) -> bool:
        return self._target() is not None

    @property
    def auto_upload_enabled(self) -> bool:
        t = self._target()
        return t is not None and t.auto_upload

    def _rclone_args(self, target: RcloneTarget | None, *subcmd: str) -> list[str]:
        args = ["rclone"]
        cfg_path = target.config_path if target else None
        if cfg_path is not None and cfg_path.exists():
            args.extend(["--config", str(cfg_path)])
        args.extend(subcmd)
        return args

    async def _run_rclone(self, *subcmd: str, target: RcloneTarget | None = None) -> tuple[int, str]:
        resolved = target or self._target()
        cmd = self._rclone_args(resolved, *subcmd)
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        stdout, _ = await proc.communicate()
        return proc.returncode or 0, stdout.decode(errors="replace")[-1500:]

    async def delete_remote_dir(self, remote_uri: str) -> tuple[bool, str]:
        target = self._target()
        if target is None or not remote_uri:
            return False, "Cloud storage not connected"
        rc, out = await self._run_rclone("purge", remote_uri, target=target)
        return rc == 0, out.strip()

    async def sync_meta_file(self, meta: CallMetadata) -> bool:
        """Push updated meta.json to remote storage when a call is edited after upload."""
        target = self._target()
        if target is None or meta.upload_status != UploadStatus.UPLOADED:
            return False
        call_dir = self.settings.recordings_dir / meta.local_rel_dir
        meta_path = call_dir / "meta.json"
        if not meta_path.exists():
            return False
        remote_uri = meta.remote_uri or build_remote_uri(
            target.remote,
            target.prefix,
            meta.local_rel_dir,
        )
        rc, _ = await self._run_rclone(
            "copyto",
            str(meta_path),
            f"{remote_uri.rstrip('/')}/meta.json",
            "--retries=2",
            target=target,
        )
        return rc == 0

    async def _notify(self, meta: CallMetadata) -> None:
        url = self.settings.ntfy_url.strip()
        if not url:
            return
        dur = f"{meta.duration_seconds:.0f}s" if meta.duration_seconds is not None else "?"
        label = meta.title or meta.service
        body = f"{label} ({dur}) uploaded to {meta.remote_uri}"
        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                await client.post(
                    url,
                    content=body.encode("utf-8"),
                    headers={"Title": f"CallTap: {meta.call_id}"},
                )
        except httpx.HTTPError as exc:
            logger.warning("ntfy notification failed: %s", exc)

    async def upload_one(self, meta: CallMetadata) -> CallMetadata:
        started = time.perf_counter()
        target = self._target()
        if target is None:
            updated = self.db.update_upload_state(
                meta.call_id, UploadStatus.DISABLED, error=None
            )
            return updated or meta

        with start_span(
            "call.upload",
            {"call.id": meta.call_id, "upload.attempt": meta.upload_attempts + 1},
        ):
            call_dir = self.settings.recordings_dir / meta.local_rel_dir
            if not call_dir.exists():
                updated = self.db.update_upload_state(
                    meta.call_id,
                    UploadStatus.FAILED,
                    attempts=meta.upload_attempts + 1,
                    error=f"Local call directory missing: {call_dir}",
                )
                UPLOADS_TOTAL.labels(status=UploadStatus.FAILED.value).inc()
                return updated or meta

            remote_uri = build_remote_uri(
                target.remote,
                target.prefix,
                meta.local_rel_dir,
            )

            attempts = meta.upload_attempts + 1
            self.db.update_upload_state(
                meta.call_id, UploadStatus.UPLOADING, attempts=attempts, error=None
            )

            # Ensure peaks.json waveform exists before rclone copies the directory to R2.
            try:
                await ensure_call_waveform(call_dir, meta)
            except Exception as exc:  # noqa: BLE001
                logger.warning("Pre-upload waveform generation skipped for %s: %s", meta.call_id, exc)

            # Write meta.json with UPLOADED status before rclone copy so R2 has the final metadata.
            now = datetime.now(UTC)
            remote_meta = meta.model_copy(
                update={
                    "upload_status": UploadStatus.UPLOADED,
                    "upload_attempts": attempts,
                    "upload_error": None,
                    "remote_uri": remote_uri,
                    "uploaded_at": now,
                }
            )
            write_meta_file(call_dir, remote_meta)

            rc, out = await self._run_rclone(
                "copy",
                str(call_dir),
                remote_uri,
                "--transfers=4",
                "--retries=3",
                target=target,
            )
            if rc == 0:
                rc_chk, chk_out = await self._run_rclone(
                    "check",
                    str(call_dir),
                    remote_uri,
                    "--one-way",
                    "--size-only",
                    target=target,
                )
                if rc_chk != 0:
                    rc = rc_chk
                    out = f"rclone check failed: {chk_out}"

            UPLOAD_DURATION.observe(max(0.0, time.perf_counter() - started))

            if rc == 0:
                updated = self.db.update_upload_state(
                    meta.call_id,
                    UploadStatus.UPLOADED,
                    attempts=attempts,
                    error=None,
                    remote_uri=remote_uri,
                    uploaded_at=now,
                )
                UPLOADS_TOTAL.labels(status=UploadStatus.UPLOADED.value).inc()
                logger.info(
                    "Uploaded call %s to %s",
                    meta.call_id,
                    remote_uri,
                    extra={"call_id": meta.call_id, "remote_uri": remote_uri},
                )
                if updated:
                    write_meta_file(call_dir, updated)
                    await self._notify(updated)
                    return updated
                return meta

            err_msg = out.strip() or f"rclone exited with code {rc}"
            retry_at = datetime.now(UTC) + timedelta(seconds=backoff_seconds(attempts))
            updated = self.db.update_upload_state(
                meta.call_id,
                UploadStatus.FAILED,
                attempts=attempts,
                error=err_msg,
                next_retry_at=retry_at,
            )
            if updated:
                write_meta_file(call_dir, updated)
            UPLOADS_TOTAL.labels(status=UploadStatus.FAILED.value).inc()
            logger.warning(
                "Upload failed for call %s (attempt %d): %s",
                meta.call_id,
                attempts,
                err_msg,
                extra={"call_id": meta.call_id, "attempt": attempts},
            )
            return updated or meta

    def prune_expired_local_audio(self, now: datetime | None = None) -> int:
        days = self.settings.local_retention_days
        if days <= 0:
            return 0
        now = now or datetime.now(UTC)
        cutoff = now - timedelta(days=days)
        pruned_count = 0
        for meta in self.db.prune_candidates(cutoff):
            call_dir = self.settings.recordings_dir / meta.local_rel_dir
            for fname in (meta.files.you, meta.files.agent, meta.files.mix):
                if not fname:
                    continue
                fpath = call_dir / fname
                if fpath.exists():
                    fpath.unlink()
            updated = self.db.mark_pruned(meta.call_id)
            if updated and call_dir.exists():
                write_meta_file(call_dir, updated)
            pruned_count += 1
        return pruned_count

    async def process_pending_once(self) -> int:
        if not self.enabled:
            return 0
        processed = 0
        while True:
            meta = self.db.next_pending_upload()
            if meta is None:
                break
            if meta.upload_attempts >= self.settings.upload_max_retries:
                self.db.update_upload_state(
                    meta.call_id,
                    UploadStatus.FAILED,
                    error=meta.upload_error or "Max upload retries exceeded",
                    next_retry_at=datetime.now(UTC) + timedelta(days=3650),
                )
                continue
            await self.upload_one(meta)
            processed += 1
        self.prune_expired_local_audio()
        return processed
