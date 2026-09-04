"""Durable, local-only state for document ingestion jobs."""

from __future__ import annotations

import hashlib
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


@dataclass(frozen=True)
class IngestionJob:
    job_key: str
    source_path: str
    source_sha256: str
    status: str
    output_dir: str
    error: str | None


class IngestionLedger:
    """Tracks idempotent parse jobs without storing document contents in SQLite."""

    def __init__(self, path: Path):
        self.path = path.resolve()

    def initialize(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS ingestion_jobs_v2 (
                    job_key TEXT PRIMARY KEY,
                    source_path TEXT NOT NULL,
                    source_sha256 TEXT NOT NULL,
                    status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
                    output_dir TEXT NOT NULL,
                    error TEXT,
                    updated_at TEXT NOT NULL
                )
                """
            )

    def begin(self, *, source: Path, output_dir: Path, job_key: str) -> tuple[IngestionJob, bool]:
        """Return ``(job, should_run)``; only a matching parse fingerprint is skipped."""

        self.initialize()
        if not job_key.strip():
            raise ValueError("job_key must not be empty")
        source_path = str(source.resolve())
        source_sha256 = sha256_file(source)
        output = str(output_dir.resolve())
        with self._connect() as connection:
            existing = connection.execute(
                "SELECT source_sha256, status, output_dir, error FROM ingestion_jobs_v2 WHERE job_key = ?",
                (job_key,),
            ).fetchone()
            if existing and existing[0] == source_sha256 and existing[1] == "succeeded":
                return IngestionJob(job_key, source_path, source_sha256, existing[1], existing[2], existing[3]), False
            connection.execute(
                """
                INSERT INTO ingestion_jobs_v2(job_key, source_path, source_sha256, status, output_dir, error, updated_at)
                VALUES (?, ?, ?, 'running', ?, NULL, ?)
                ON CONFLICT(job_key) DO UPDATE SET
                    source_path = excluded.source_path,
                    source_sha256 = excluded.source_sha256,
                    status = 'running',
                    output_dir = excluded.output_dir,
                    error = NULL,
                    updated_at = excluded.updated_at
                """,
                (job_key, source_path, source_sha256, output, _now()),
            )
        return IngestionJob(job_key, source_path, source_sha256, "running", output, None), True

    def succeed(self, job: IngestionJob) -> IngestionJob:
        return self._finish(job, status="succeeded", error=None)

    def fail(self, job: IngestionJob, error: str) -> IngestionJob:
        return self._finish(job, status="failed", error=error[:2_000])

    def get(self, job_key: str) -> IngestionJob | None:
        self.initialize()
        with self._connect() as connection:
            row = connection.execute(
                "SELECT job_key, source_path, source_sha256, status, output_dir, error FROM ingestion_jobs_v2 WHERE job_key = ?",
                (job_key,),
            ).fetchone()
        return IngestionJob(*row) if row else None

    def _finish(self, job: IngestionJob, *, status: str, error: str | None) -> IngestionJob:
        self.initialize()
        with self._connect() as connection:
            result = connection.execute(
                """
                UPDATE ingestion_jobs_v2 SET status = ?, error = ?, updated_at = ?
                WHERE job_key = ? AND source_sha256 = ? AND status = 'running'
                """,
                (status, error, _now(), job.job_key, job.source_sha256),
            )
        if result.rowcount != 1:
            raise RuntimeError("ingestion job is not an active matching job")
        return IngestionJob(job.job_key, job.source_path, job.source_sha256, status, job.output_dir, error)

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self.path)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while block := stream.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()
