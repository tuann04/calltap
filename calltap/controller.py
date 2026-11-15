from __future__ import annotations

import asyncio
import logging
import secrets
import shutil
from datetime import UTC, datetime
from pathlib import Path

from calltap.cdp import ChromeInspector
from calltap.config import Settings
from calltap.db import CallDB
from calltap.models import CallFiles, CallMetadata, CallStatus, UploadStatus
from calltap.pulse import PulseMonitor
from calltap.recorder import DualTrackRecorder
from calltap.uploader import CloudUploader, write_meta_file
from calltap.waveform import ensure_call_waveform

logger = logging.getLogger(__name__)


def make_call_id(now: datetime | None = None) -> tuple[str, str]:
    now = now or datetime.now(UTC)
    stamp = now.strftime("%Y%m%dT%H%M%SZ")
    suffix = secrets.token_hex(3)
    call_id = f"{stamp}-{suffix}"
    rel_dir = f"{now:%Y/%m/%d}/{call_id}"
    return call_id, rel_dir


class CallController:
    """Orchestrates call detection, dual-track recording, metadata persistence, and upload queueing."""

    def __init__(
        self,
        settings: Settings,
        db: CallDB,
        pulse: PulseMonitor,
        recorder: DualTrackRecorder,
        uploader: CloudUploader,
        inspector: ChromeInspector,
    ) -> None:
        self.settings = settings
        self.db = db
        self.pulse = pulse
        self.recorder = recorder
        self.uploader = uploader
        self.inspector = inspector

        self._lock = asyncio.Lock()
        self._upload_wake = asyncio.Event()
        self._active_meta: CallMetadata | None = None
        self._mic_lost_at: float | None = None
        self.auto_detect: bool = settings.auto_detect
        self._stop_event = asyncio.Event()
        self._tasks: list[asyncio.Task[None]] = []
        self._bg_tasks: set[asyncio.Task[None]] = set()

    @property
    def active_call(self) -> CallMetadata | None:
        return self._active_meta

    def wake_uploader(self) -> None:
        self._upload_wake.set()

    async def start_background(self) -> None:
        self.settings.ensure_dirs()
        self.db.recover_interrupted_on_boot()
        self._tasks = [
            asyncio.create_task(self._monitor_loop(), name="calltap-monitor"),
            asyncio.create_task(self._upload_loop(), name="calltap-uploader"),
        ]

    async def stop_background(self) -> None:
        self._stop_event.set()
        self._upload_wake.set()
        for t in self._tasks:
            t.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()
        for t in list(self._bg_tasks):
            t.cancel()
        if self._bg_tasks:
            await asyncio.gather(*self._bg_tasks, return_exceptions=True)
        self._bg_tasks.clear()
        if self.recorder.is_recording:
            await self.stop_call(reason="shutdown")

    async def start_call(
        self,
        *,
        trigger: str = "manual",
        service_override: str | None = None,
        title: str = "",
        tags: list[str] | None = None,
    ) -> CallMetadata:
        async with self._lock:
            if self.recorder.is_recording and self._active_meta is not None:
                return self._active_meta

            now = datetime.now(UTC)
            call_id, rel_dir = make_call_id(now)
            tab = await self.inspector.active_tab()
            service = service_override or tab.service or self.settings.default_service

            files = CallFiles(
                you="you.flac",
                agent="agent.flac",
                mix="mix.opus" if self.settings.create_stereo_mix else None,
            )
            meta = CallMetadata(
                call_id=call_id,
                title=title.strip(),
                service=service,
                trigger=trigger,
                page_url=tab.url,
                page_title=tab.title,
                started_at=now,
                sample_rate=self.settings.sample_rate,
                files=files,
                tags=tags or [],
                local_rel_dir=rel_dir,
                status=CallStatus.RECORDING,
                upload_status=(
                    UploadStatus.PENDING
                    if self.uploader.auto_upload_enabled
                    else UploadStatus.DISABLED
                ),
            )

            call_dir = self.settings.recordings_dir / rel_dir
            write_meta_file(call_dir, meta)
            self.db.upsert_call(meta)

            try:
                await self.recorder.start(call_dir)
            except Exception as exc:
                meta.status = CallStatus.ERROR
                meta.ended_at = datetime.now(UTC)
                meta.upload_error = f"Recorder failed to start: {exc}"
                write_meta_file(call_dir, meta)
                self.db.upsert_call(meta)
                raise

            self._active_meta = meta
            self._mic_lost_at = None
            return meta

    async def stop_call(self, *, reason: str = "manual") -> CallMetadata | None:
        async with self._lock:
            if not self.recorder.is_recording or self._active_meta is None:
                return None

            meta = self._active_meta
            meta.status = CallStatus.FINALIZING
            self.db.upsert_call(meta)

            result = await self.recorder.stop()
            ended_at = datetime.now(UTC)
            meta.ended_at = ended_at
            meta.duration_seconds = max(
                0.0, round((ended_at - meta.started_at).total_seconds(), 2)
            )
            if result.exit_code != 0 and not result.you_path.exists():
                meta.status = CallStatus.ERROR
                meta.upload_error = f"ffmpeg exited {result.exit_code}: {result.stderr_tail}"
            else:
                meta.status = CallStatus.COMPLETED
                meta.upload_status = (
                    UploadStatus.PENDING
                    if self.uploader.auto_upload_enabled
                    else UploadStatus.DISABLED
                )

            call_dir = self.settings.recordings_dir / meta.local_rel_dir
            write_meta_file(call_dir, meta)
            self.db.upsert_call(meta)

            self._active_meta = None
            self._mic_lost_at = None
            self._upload_wake.set()

            if meta.status == CallStatus.COMPLETED:
                task = asyncio.create_task(self._generate_waveform_safe(call_dir, meta))
                self._bg_tasks.add(task)
                task.add_done_callback(self._bg_tasks.discard)

            return meta

    async def _generate_waveform_safe(self, call_dir: Path, meta: CallMetadata) -> None:
        try:
            await ensure_call_waveform(call_dir, meta)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Waveform generation failed for %s: %s", meta.call_id, exc)

    async def trigger_upload_now(self, call_id: str) -> CallMetadata | None:
        meta = self.db.get_call(call_id)
        if meta is None:
            return None
        updated = self.db.update_upload_state(
            call_id,
            UploadStatus.PENDING if self.uploader.enabled else UploadStatus.DISABLED,
            error=None,
            next_retry_at=datetime.now(UTC),
        )
        self._upload_wake.set()
        return updated

    async def trigger_upload_many(self, call_ids: list[str]) -> list[CallMetadata]:
        if not self.uploader.enabled:
            raise RuntimeError("Cloud storage is not connected")
        updated_items: list[CallMetadata] = []
        now = datetime.now(UTC)
        for cid in call_ids:
            meta = self.db.get_call(cid)
            if meta is None or meta.status != CallStatus.COMPLETED:
                continue
            updated = self.db.update_upload_state(
                cid,
                UploadStatus.PENDING,
                error=None,
                next_retry_at=now,
            )
            if updated is not None:
                updated_items.append(updated)
        if updated_items:
            self._upload_wake.set()
        return updated_items

    async def delete_call(self, call_id: str, *, delete_remote: bool = False) -> bool:
        if self._active_meta is not None and self._active_meta.call_id == call_id:
            raise RuntimeError("Cannot delete an active recording")
        meta = self.db.get_call(call_id)
        if meta is None:
            return False
        if delete_remote and meta.remote_uri and self.uploader.enabled:
            await self.uploader.delete_remote_dir(meta.remote_uri)
        call_dir = self.settings.recordings_dir / meta.local_rel_dir
        if call_dir.exists():
            shutil.rmtree(call_dir, ignore_errors=True)
        self.db.delete_call(call_id)
        return True

    async def delete_calls(self, call_ids: list[str], *, delete_remote: bool = False) -> list[str]:
        active_id = self._active_meta.call_id if self._active_meta is not None else None
        deletable = [cid for cid in call_ids if cid != active_id]
        metas = self.db.delete_calls(deletable)
        deleted_ids: list[str] = []
        for meta in metas:
            if delete_remote and meta.remote_uri and self.uploader.enabled:
                await self.uploader.delete_remote_dir(meta.remote_uri)
            call_dir = self.settings.recordings_dir / meta.local_rel_dir
            if call_dir.exists():
                shutil.rmtree(call_dir, ignore_errors=True)
            deleted_ids.append(meta.call_id)
        return deleted_ids

    async def _monitor_loop(self) -> None:
        loop = asyncio.get_running_loop()
        while not self._stop_event.is_set():
            try:
                if self.auto_detect:
                    capture = await self.pulse.active_browser_capture()
                    if capture is not None:
                        self._mic_lost_at = None
                        if not self.recorder.is_recording:
                            await self.start_call(trigger="auto")
                    else:
                        if (
                            self.recorder.is_recording
                            and self._active_meta is not None
                            and self._active_meta.trigger == "auto"
                        ):
                            now_mono = loop.time()
                            if self._mic_lost_at is None:
                                self._mic_lost_at = now_mono
                            elif now_mono - self._mic_lost_at >= self.settings.stop_grace_seconds:
                                await self.stop_call(reason="auto")
            except asyncio.CancelledError:
                raise
            except (OSError, RuntimeError) as exc:
                logger.warning("Monitor loop error: %s", exc)

            try:
                await asyncio.wait_for(
                    self._stop_event.wait(), timeout=self.settings.poll_interval_seconds
                )
            except TimeoutError:
                pass

    async def _upload_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                await self.uploader.process_pending_once()
            except asyncio.CancelledError:
                raise
            except (OSError, RuntimeError) as exc:
                logger.warning("Upload loop error: %s", exc)

            self._upload_wake.clear()
            try:
                await asyncio.wait_for(
                    self._upload_wake.wait(), timeout=self.settings.upload_poll_seconds
                )
            except TimeoutError:
                pass
