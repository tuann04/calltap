from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum

from pydantic import BaseModel, Field


class CallStatus(StrEnum):
    RECORDING = "recording"
    FINALIZING = "finalizing"
    COMPLETED = "completed"
    ERROR = "error"


class UploadStatus(StrEnum):
    PENDING = "pending"
    UPLOADING = "uploading"
    UPLOADED = "uploaded"
    FAILED = "failed"
    DISABLED = "disabled"


class CallFiles(BaseModel):
    you: str = "you.flac"
    agent: str = "agent.flac"
    mix: str | None = "mix.opus"


class CallMetadata(BaseModel):
    call_id: str
    service: str = "generic"
    trigger: str = "auto"  # "auto" | "manual"
    page_url: str | None = None
    page_title: str | None = None
    started_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    ended_at: datetime | None = None
    duration_seconds: float | None = None
    sample_rate: int = 48000
    files: CallFiles = Field(default_factory=CallFiles)
    tags: list[str] = Field(default_factory=list)
    notes: str = ""
    local_rel_dir: str
    status: CallStatus = CallStatus.RECORDING
    upload_status: UploadStatus = UploadStatus.PENDING
    upload_attempts: int = 0
    upload_error: str | None = None
    remote_uri: str | None = None
    uploaded_at: datetime | None = None
    local_pruned: bool = False
