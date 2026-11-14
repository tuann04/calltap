from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx

from calltap.config import Settings
from calltap.db import CallDB
from calltap.models import CallMetadata, UploadStatus


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

    def __init__(self, settings: Settings, db: CallDB) -> None:
        self.settings = settings
        self.db = db

    @property
    def enabled(self) -> bool:
        return bool(self.settings.rclone_remote.strip())

    def _rclone_args(self, *subcmd: str) -> list[str]:
        args = ["rclone"]
        if self.settings.rclone_config.exists():
            args.extend(["--config", str(self.settings.rclone_config)])
        args.extend(subcmd)
        return args

    async def _run_rclone(self, *subcmd: str) -> tuple[int, str]:
        cmd = self._rclone_args(*subcmd)
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        stdout, _ = await proc.communicate()
        return proc.returncode or 0, stdout.decode(errors="replace")[-1500:]

    async def _notify(self, meta: CallMetadata) -> None:
        url = self.settings.ntfy_url.strip()
        if not url:
            return
        dur = f"{meta.duration_seconds:.0f}s" if meta.duration_seconds is not None else "?"
        body = f"{meta.service} call ({dur}) uploaded to {meta.remote_uri}"
        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                await client.post(
                    url,
                    content=body.encode("utf-8"),
                    headers={"Title": f"CallTap: {meta.call_id}"},
                )
        except httpx.HTTPError as exc:
            import logging

            logging.getLogger(__name__).warning("ntfy notification failed: %s", exc)

    async def upload_one(self, meta: CallMetadata) -> CallMetadata:
        if not self.enabled:
            updated = self.db.update_upload_state(
                meta.call_id, UploadStatus.DISABLED, error=None
            )
            return updated or meta

        call_dir = self.settings.recordings_dir / meta.local_rel_dir
        if not call_dir.exists():
            updated = self.db.update_upload_state(
                meta.call_id,
                UploadStatus.FAILED,
                attempts=meta.upload_attempts + 1,
                error=f"Local call directory missing: {call_dir}",
            )
            return updated or meta

        remote_uri = build_remote_uri(
            self.settings.rclone_remote,
            self.settings.rclone_remote_prefix,
            meta.local_rel_dir,
        )

        attempts = meta.upload_attempts + 1
        self.db.update_upload_state(
            meta.call_id, UploadStatus.UPLOADING, attempts=attempts, error=None
        )

        # Ensure meta.json on disk is fresh before copying.
        write_meta_file(call_dir, meta)

        rc, out = await self._run_rclone(
            "copy",
            str(call_dir),
            remote_uri,
            "--transfers=4",
            "--retries=3",
        )
        if rc == 0:
            # Verify remote files match local sizes/hashes where supported (--size-only works across all backends)
            rc_chk, chk_out = await self._run_rclone(
                "check", str(call_dir), remote_uri, "--one-way", "--size-only"
            )
            if rc_chk != 0:
                rc = rc_chk
                out = f"rclone check failed: {chk_out}"

        if rc == 0:
            now = datetime.now(UTC)
            updated = self.db.update_upload_state(
                meta.call_id,
                UploadStatus.UPLOADED,
                attempts=attempts,
                error=None,
                remote_uri=remote_uri,
                uploaded_at=now,
            )
            if updated:
                write_meta_file(call_dir, updated)
                await self._notify(updated)
                return updated
            return meta

        retry_at = datetime.now(UTC) + timedelta(seconds=backoff_seconds(attempts))
        updated = self.db.update_upload_state(
            meta.call_id,
            UploadStatus.FAILED,
            attempts=attempts,
            error=out.strip() or f"rclone exited with code {rc}",
            next_retry_at=retry_at,
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
                # Wait for manual retry after max automatic attempts.
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
