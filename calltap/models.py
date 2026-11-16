from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Any, Literal

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


class StorageProvider(StrEnum):
    NONE = "none"
    R2 = "r2"
    S3 = "s3"
    B2 = "b2"
    CUSTOM_S3 = "custom_s3"
    GDRIVE = "gdrive"


class CallFiles(BaseModel):
    you: str = "you.flac"
    agent: str = "agent.flac"
    mix: str | None = "mix.opus"


class CallMetadata(BaseModel):
    call_id: str
    title: str = ""
    service: str = "unknown"
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

    def matches_query(self, needle: str) -> bool:
        return (
            needle in self.title.lower()
            or needle in self.service.lower()
            or needle in self.call_id.lower()
            or needle in self.notes.lower()
            or needle in (self.page_url or "").lower()
            or needle in (self.page_title or "").lower()
            or any(needle in t.lower() for t in self.tags)
        )


class StorageConfig(BaseModel):
    provider: StorageProvider = StorageProvider.NONE
    auto_upload: bool = True
    bucket: str = ""
    prefix: str = "calls"
    endpoint: str = ""
    region: str = "auto"
    access_key_id: str = ""
    secret_access_key: str = ""
    gdrive_token_json: str = ""
    gdrive_client_id: str = ""
    gdrive_client_secret: str = ""
    gdrive_root_folder_id: str = ""


class StoragePublicView(BaseModel):
    connected: bool
    source: str  # "ui" | "env" | "none"
    provider: StorageProvider
    auto_upload: bool
    bucket: str = ""
    prefix: str = "calls"
    endpoint: str = ""
    region: str = "auto"
    access_key_id: str = ""
    has_secret: bool = False
    secret_hint: str = ""
    has_gdrive_token: bool = False
    gdrive_client_id: str = ""
    gdrive_root_folder_id: str = ""
    remote_label: str = ""


class StartCallRequest(BaseModel):
    service: str | None = None
    title: str = ""
    tags: list[str] = Field(default_factory=list)


class PatchCallRequest(BaseModel):
    title: str | None = None
    service: str | None = None
    tags: list[str] | None = None
    notes: str | None = None


class AutoDetectRequest(BaseModel):
    enabled: bool


class BulkCallsRequest(BaseModel):
    call_ids: list[str] = Field(default_factory=list)
    delete_remote: bool = False


class StorageTestResponse(BaseModel):
    ok: bool
    message: str


class TelemetryEvent(BaseModel):
    event: str = Field(min_length=1, max_length=80)
    level: Literal["debug", "info", "warn", "warning", "error"] = "info"
    source: str = Field(default="web", max_length=40)
    message: str = Field(default="", max_length=500)
    data: dict[str, Any] = Field(default_factory=dict)


class TelemetryBatchRequest(BaseModel):
    events: list[TelemetryEvent] = Field(default_factory=list, max_length=50)
