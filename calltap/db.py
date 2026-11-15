from __future__ import annotations

import sqlite3
from datetime import UTC, datetime
from pathlib import Path

from calltap.models import CallMetadata, CallStatus, UploadStatus

_SCHEMA = """
CREATE TABLE IF NOT EXISTS calls (
    call_id TEXT PRIMARY KEY,
    service TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    status TEXT NOT NULL,
    upload_status TEXT NOT NULL,
    upload_attempts INTEGER NOT NULL DEFAULT 0,
    next_retry_at TEXT,
    local_pruned INTEGER NOT NULL DEFAULT 0,
    meta_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calls_started_at ON calls(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_calls_upload ON calls(upload_status, next_retry_at);
"""


class CallDB:
    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL;")
        self._conn.executescript(_SCHEMA)
        self._conn.commit()

    def close(self) -> None:
        self._conn.close()

    def upsert_call(
        self,
        meta: CallMetadata,
        *,
        next_retry_at: datetime | None = None,
    ) -> None:
        self._conn.execute(
            """
            INSERT INTO calls (
                call_id, service, started_at, ended_at, status,
                upload_status, upload_attempts, next_retry_at, local_pruned, meta_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(call_id) DO UPDATE SET
                service = excluded.service,
                started_at = excluded.started_at,
                ended_at = excluded.ended_at,
                status = excluded.status,
                upload_status = excluded.upload_status,
                upload_attempts = excluded.upload_attempts,
                next_retry_at = COALESCE(excluded.next_retry_at, calls.next_retry_at),
                local_pruned = excluded.local_pruned,
                meta_json = excluded.meta_json
            """,
            (
                meta.call_id,
                meta.service,
                meta.started_at.isoformat(),
                meta.ended_at.isoformat() if meta.ended_at else None,
                meta.status.value,
                meta.upload_status.value,
                meta.upload_attempts,
                next_retry_at.isoformat() if next_retry_at else None,
                1 if meta.local_pruned else 0,
                meta.model_dump_json(),
            ),
        )
        self._conn.commit()

    def get_call(self, call_id: str) -> CallMetadata | None:
        row = self._conn.execute(
            "SELECT meta_json FROM calls WHERE call_id = ?", (call_id,)
        ).fetchone()
        if not row:
            return None
        return CallMetadata.model_validate_json(row["meta_json"])

    def list_calls(
        self,
        *,
        limit: int = 100,
        service: str | None = None,
        upload_status: UploadStatus | None = None,
    ) -> list[CallMetadata]:
        clauses: list[str] = []
        params: list[object] = []
        if service:
            clauses.append("service = ?")
            params.append(service)
        if upload_status:
            clauses.append("upload_status = ?")
            params.append(upload_status.value)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        sql = f"SELECT meta_json FROM calls {where} ORDER BY started_at DESC LIMIT ?"
        params.append(limit)
        rows = self._conn.execute(sql, params).fetchall()
        return [CallMetadata.model_validate_json(r["meta_json"]) for r in rows]

    def recover_interrupted_on_boot(self) -> int:
        """Reset crashed in-flight states on startup."""
        fixed = 0
        rows = self._conn.execute(
            "SELECT meta_json FROM calls WHERE status = ? OR upload_status = ?",
            (CallStatus.RECORDING.value, UploadStatus.UPLOADING.value),
        ).fetchall()
        for row in rows:
            meta = CallMetadata.model_validate_json(row["meta_json"])
            if meta.status == CallStatus.RECORDING:
                meta.status = CallStatus.ERROR
                if meta.ended_at is None:
                    meta.ended_at = datetime.now(UTC)
            if meta.upload_status == UploadStatus.UPLOADING:
                meta.upload_status = UploadStatus.PENDING
            self.upsert_call(meta)
            fixed += 1
        return fixed

    def next_pending_upload(self, now: datetime | None = None) -> CallMetadata | None:
        now = now or datetime.now(UTC)
        row = self._conn.execute(
            """
            SELECT meta_json FROM calls
            WHERE status = ?
              AND upload_status IN (?, ?)
              AND (next_retry_at IS NULL OR next_retry_at <= ?)
            ORDER BY started_at ASC
            LIMIT 1
            """,
            (
                CallStatus.COMPLETED.value,
                UploadStatus.PENDING.value,
                UploadStatus.FAILED.value,
                now.isoformat(),
            ),
        ).fetchone()
        if not row:
            return None
        return CallMetadata.model_validate_json(row["meta_json"])

    def update_upload_state(
        self,
        call_id: str,
        upload_status: UploadStatus,
        *,
        attempts: int | None = None,
        error: str | None = None,
        remote_uri: str | None = None,
        uploaded_at: datetime | None = None,
        next_retry_at: datetime | None = None,
    ) -> CallMetadata | None:
        meta = self.get_call(call_id)
        if meta is None:
            return None
        meta.upload_status = upload_status
        if attempts is not None:
            meta.upload_attempts = attempts
        meta.upload_error = error
        if remote_uri is not None:
            meta.remote_uri = remote_uri
        if uploaded_at is not None:
            meta.uploaded_at = uploaded_at
        self.upsert_call(meta, next_retry_at=next_retry_at)
        return meta

    def prune_candidates(self, older_than: datetime) -> list[CallMetadata]:
        rows = self._conn.execute(
            """
            SELECT meta_json FROM calls
            WHERE upload_status = ?
              AND local_pruned = 0
              AND ended_at IS NOT NULL
              AND ended_at <= ?
            """,
            (UploadStatus.UPLOADED.value, older_than.isoformat()),
        ).fetchall()
        return [CallMetadata.model_validate_json(r["meta_json"]) for r in rows]

    def mark_pruned(self, call_id: str) -> CallMetadata | None:
        meta = self.get_call(call_id)
        if meta is None:
            return None
        meta.local_pruned = True
        self.upsert_call(meta)
        return meta

    def delete_call(self, call_id: str) -> CallMetadata | None:
        meta = self.get_call(call_id)
        if meta is None:
            return None
        self._conn.execute("DELETE FROM calls WHERE call_id = ?", (call_id,))
        self._conn.commit()
        return meta

    def delete_calls(self, call_ids: list[str]) -> list[CallMetadata]:
        deleted: list[CallMetadata] = []
        for cid in call_ids:
            meta = self.get_call(cid)
            if meta is not None:
                deleted.append(meta)
        if not deleted:
            return []
        placeholders = ",".join("?" for _ in deleted)
        self._conn.execute(
            f"DELETE FROM calls WHERE call_id IN ({placeholders})",
            [m.call_id for m in deleted],
        )
        self._conn.commit()
        return deleted

    def count_pending_uploads(self) -> int:
        row = self._conn.execute(
            "SELECT COUNT(*) AS cnt FROM calls WHERE status = ? AND upload_status IN (?, ?)",
            (CallStatus.COMPLETED.value, UploadStatus.PENDING.value, UploadStatus.UPLOADING.value),
        ).fetchone()
        return int(row["cnt"]) if row else 0
