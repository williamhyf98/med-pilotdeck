"""User-scoped asynchronous MinerU ingestion service.

The service ends at normalized document artifacts. Embedding and knowledge-base
persistence are deliberately owned by the next-stage personal KB orchestrator.
"""

from __future__ import annotations

import concurrent.futures
import hashlib
import html
import json
import os
import re
import shutil
import subprocess
import threading
import time
import zipfile
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping
from xml.etree import ElementTree as ET

from .mineru_paths import (
    assert_mineru_output_path,
    assert_mineru_source_path,
    resolve_mineru_root,
    to_mineru_user_relative_path,
)
from .rag.mineru_adapter import MinerUInvocation, run_mineru, validate_mineru_output
from .rag.mineru_chunking import ChunkingConfig, build_mineru_chunks
from .rag.mineru_runtime import (
    MINERU_LAUNCHER_ENV,
    MINERU_MODEL_ROOT_ENV,
    MinerURuntime,
    MinerURuntimeConfigError,
)


INGEST_ROOT_ENV = "MED_RAG_MINERU_INGEST_ROOT"
DEFAULT_CPU_THREADS_ENV = "MED_RAG_MINERU_DEFAULT_CPU_THREADS"
DEFAULT_DEVICE_ENV = "MED_RAG_MINERU_DEFAULT_DEVICE"
MAX_WORKERS_ENV = "MED_RAG_MINERU_MAX_WORKERS"
MCP_TRANSPORT_ENV = "MED_RAG_MINERU_MCP_TRANSPORT"
SCHEMA_VERSION = "mineru-ingest-chunks-v1"
BATCH_SCHEMA_VERSION = "mineru-ingest-batch-v1"
PDF_SUFFIXES = {".pdf"}
DOCX_SUFFIXES = {".docx"}
LEGACY_DOC_SUFFIXES = {".doc"}
TEXT_SUFFIXES = {
    ".txt",
    ".md",
    ".markdown",
    ".rst",
    ".csv",
    ".tsv",
    ".json",
    ".jsonl",
    ".xml",
    ".html",
    ".htm",
    ".yaml",
    ".yml",
    ".log",
}
SUPPORTED_INPUT_SUFFIXES = sorted(
    PDF_SUFFIXES | DOCX_SUFFIXES | LEGACY_DOC_SUFFIXES | TEXT_SUFFIXES
)

_EXECUTORS: dict[int, concurrent.futures.ThreadPoolExecutor] = {}
_FUTURES: dict[str, concurrent.futures.Future[None]] = {}
_FUTURE_ROOTS: dict[str, Path] = {}
_LOCK = threading.Lock()


@dataclass(frozen=True)
class IngestRequest:
    pdf_path: str
    book_id: str | None = None
    title: str | None = None
    volume: str | None = None
    language: str = "ch"
    device: str = "cpu"
    start_page: int | None = None
    end_page: int | None = None
    page_index_offset: int = 0
    formula_enabled: bool = False
    table_enabled: bool = False
    timeout_seconds: int = 3_600
    cpu_threads: int = 8
    max_chars: int = 1_200
    overlap_chars: int = 160

    def normalized(self) -> "IngestRequest":
        start_page = _optional_non_negative(self.start_page, "start_page")
        end_page = _optional_non_negative(self.end_page, "end_page")
        if start_page is not None and end_page is not None and end_page < start_page:
            raise ValueError("end_page must not be smaller than start_page")
        page_index_offset = int(self.page_index_offset)
        if page_index_offset < 0:
            raise ValueError("page_index_offset must be non-negative")
        timeout_seconds = int(self.timeout_seconds)
        if timeout_seconds < 1:
            raise ValueError("timeout_seconds must be positive")
        cpu_threads = int(self.cpu_threads)
        if not 1 <= cpu_threads <= 64:
            raise ValueError("cpu_threads must be between 1 and 64")
        ChunkingConfig(max_chars=int(self.max_chars), overlap_chars=int(self.overlap_chars))
        return IngestRequest(
            pdf_path=str(self.pdf_path),
            book_id=_clean_optional(self.book_id),
            title=_clean_optional(self.title),
            volume=_clean_optional(self.volume),
            language=(self.language or "ch").strip() or "ch",
            device=(self.device or "cpu").strip().lower() or "cpu",
            start_page=start_page,
            end_page=end_page,
            page_index_offset=page_index_offset,
            formula_enabled=bool(self.formula_enabled),
            table_enabled=bool(self.table_enabled),
            timeout_seconds=timeout_seconds,
            cpu_threads=cpu_threads,
            max_chars=int(self.max_chars),
            overlap_chars=int(self.overlap_chars),
        )

    def fingerprint_payload(
        self,
        *,
        source_sha256: str,
        input_type: str,
        runtime: MinerURuntime | None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "schema_version": SCHEMA_VERSION,
            "source_path": self.pdf_path,
            "input_type": input_type,
            "source_sha256": source_sha256,
            "book_id": self.book_id,
            "title": self.title,
            "volume": self.volume,
            "language": self.language,
            "device": self.device,
            "start_page": self.start_page,
            "end_page": self.end_page,
            "page_index_offset": self.page_index_offset,
            "formula_enabled": self.formula_enabled,
            "table_enabled": self.table_enabled,
            "timeout_seconds": self.timeout_seconds,
            "cpu_threads": self.cpu_threads,
            "max_chars": self.max_chars,
            "overlap_chars": self.overlap_chars,
        }
        if runtime is not None:
            payload["mineru_launcher"] = list(runtime.launcher)
            payload["mineru_model_root"] = str(runtime.model_root)
        return payload


class MinerUIngestService:
    def __init__(
        self,
        *,
        output_root: Path | None = None,
        environment: Mapping[str, str] | None = None,
    ) -> None:
        self.environment = dict(os.environ if environment is None else environment)
        self.output_root = (
            assert_mineru_output_path(str(output_root), self.environment)
            if output_root is not None
            else resolve_mineru_root(self.environment)
        )
        self.max_workers = _max_workers(self.environment)

    def _executor(self) -> concurrent.futures.ThreadPoolExecutor:
        with _LOCK:
            executor = _EXECUTORS.get(self.max_workers)
            if executor is None:
                executor = concurrent.futures.ThreadPoolExecutor(
                    max_workers=self.max_workers,
                    thread_name_prefix="mineru-ingest",
                )
                _EXECUTORS[self.max_workers] = executor
            return executor

    def _queue_stats(self) -> dict[str, int]:
        with _LOCK:
            futures = [
                future
                for job_id, future in _FUTURES.items()
                if _FUTURE_ROOTS.get(job_id) == self.output_root
            ]
        return {
            "running_jobs": sum(1 for future in futures if future.running() and not future.done()),
            "queued_jobs": sum(1 for future in futures if not future.running() and not future.done()),
        }

    def health(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "ok": True,
            "service": "mineru-ingest-tools",
            "schema_version": SCHEMA_VERSION,
            "supported_inputs": SUPPORTED_INPUT_SUFFIXES,
            "input_modes": {
                "pdf": "MinerU OCR/layout parse",
                "docx": "OOXML text extraction",
                "doc": "best-effort legacy Word text extraction",
                "text": "plain/common text extraction",
            },
            "async": True,
            "transport": str(self.environment.get(MCP_TRANSPORT_ENV, "stdio")).strip()
            or "stdio",
            "embedding": {"enabled": False, "reason": "ingest stage only"},
            "batching": {
                "enabled": True,
                "schema_version": BATCH_SCHEMA_VERSION,
                "execution": "bounded_worker_queue",
                "max_workers": self.max_workers,
                **self._queue_stats(),
            },
            "output_root": str(self.output_root),
            "output_root_exists": self.output_root.is_dir(),
            "output_root_parent_exists": self.output_root.parent.is_dir(),
            "output_root_parent_writable": os.access(self.output_root.parent, os.W_OK),
            "default_cpu_threads": _default_cpu_threads(self.environment),
            "default_device": _default_device(self.environment),
            "runtime": {
                "configured": False,
                "launcher": "",
                "model_root": "",
                "model_root_exists": False,
                "valid": False,
                "error": "",
            },
        }
        try:
            runtime = MinerURuntime.from_environment(self.environment)
            payload["runtime"].update(
                {
                    "configured": True,
                    "launcher": " ".join(runtime.launcher),
                    "model_root": str(runtime.model_root),
                    "model_root_exists": runtime.model_root.is_dir(),
                }
            )
            runtime.validate()
            payload["runtime"]["valid"] = True
        except Exception as exc:  # health is diagnostic by design
            payload["ok"] = False
            payload["runtime"]["error"] = f"{type(exc).__name__}: {exc}"
        if not payload["output_root_parent_exists"] or not payload["output_root_parent_writable"]:
            payload["ok"] = False
        return payload

    def submit(
        self,
        *,
        pdf_path: str,
        book_id: str | None = None,
        title: str | None = None,
        volume: str | None = None,
        language: str = "ch",
        device: str | None = None,
        start_page: int | None = None,
        end_page: int | None = None,
        page_index_offset: int | None = None,
        formula_enabled: bool = False,
        table_enabled: bool = False,
        timeout_seconds: int = 3_600,
        cpu_threads: int | None = None,
        max_chars: int = 1_200,
        overlap_chars: int = 160,
        force: bool = False,
    ) -> dict[str, Any]:
        request = self._make_request(
            pdf_path=pdf_path,
            book_id=book_id,
            title=title,
            volume=volume,
            language=language,
            device=device,
            start_page=start_page,
            end_page=end_page,
            page_index_offset=page_index_offset,
            formula_enabled=formula_enabled,
            table_enabled=table_enabled,
            timeout_seconds=timeout_seconds,
            cpu_threads=cpu_threads,
            max_chars=max_chars,
            overlap_chars=overlap_chars,
        )
        source = assert_mineru_source_path(request.pdf_path, self.environment)
        input_type = _input_type(source)
        runtime = self._runtime_for(input_type)
        source_sha256 = _sha256_file(source)
        job_id = _job_id(
            request.fingerprint_payload(
                source_sha256=source_sha256,
                input_type=input_type,
                runtime=runtime,
            )
        )
        if force:
            job_id = f"{job_id}-{time.time_ns()}"
        job_dir = self._job_dir(job_id)
        existing = self.status(job_id)
        if existing.get("exists") and not force:
            return existing
        self.output_root.mkdir(parents=True, exist_ok=True)
        job_dir.mkdir(parents=True, exist_ok=False)
        self._write_job(
            job_id,
            {
                "job_id": job_id,
                "status": "queued",
                "phase": "queued",
                "schema_version": SCHEMA_VERSION,
                "created_at": _now(),
                "updated_at": _now(),
                "request": asdict(request),
                "runtime": _runtime_payload(runtime),
                "source": {
                    "path": str(source),
                    "file_name": source.name,
                    "input_type": input_type,
                    "sha256": source_sha256,
                },
                "job_dir": str(job_dir),
            },
        )
        future = self._executor().submit(
            self._run_job, job_id, request, runtime, source_sha256
        )
        with _LOCK:
            if not future.done():
                _FUTURES[job_id] = future
                _FUTURE_ROOTS[job_id] = self.output_root
            else:
                _FUTURES.pop(job_id, None)
                _FUTURE_ROOTS.pop(job_id, None)
        return self.status(job_id)

    def status(self, job_id: str) -> dict[str, Any]:
        job_id = _validate_job_id(job_id)
        job_path = self._job_dir(job_id) / "job.json"
        if not job_path.is_file():
            return {"exists": False, "job_id": job_id, "status": "not_found"}
        payload = _read_json(job_path)
        with _LOCK:
            future = _FUTURES.get(job_id)
        live = future is not None and not future.done()
        payload["exists"] = True
        payload["live"] = live
        if payload.get("status") in {"queued", "running"} and not live:
            payload["warning"] = "job is not live in this MCP process; the server may have restarted"
        return payload

    def result(
        self, job_id: str, *, include_samples: bool = False, sample_limit: int = 3
    ) -> dict[str, Any]:
        status = self.status(job_id)
        if not status.get("exists") or status.get("status") != "succeeded":
            return status
        job_dir = Path(str(status["job_dir"]))
        result = {
            **status,
            "manifest_path": str(job_dir / "manifest.json"),
            "quality_report_path": str(job_dir / "quality_report.json"),
            "artifact_paths": {
                "chunks_jsonl": str(job_dir / "corpus" / "chunks.jsonl"),
                "pages_jsonl": str(job_dir / "corpus" / "pages.jsonl"),
                "assets_jsonl": str(job_dir / "corpus" / "assets.jsonl"),
                "assets_dir": str(job_dir / "assets"),
                "mineru_raw_dir": str(job_dir / "mineru_raw"),
            },
        }
        if Path(result["manifest_path"]).is_file():
            result["manifest"] = _read_json(Path(result["manifest_path"]))
        if Path(result["quality_report_path"]).is_file():
            result["quality"] = _read_json(Path(result["quality_report_path"]))
        if include_samples:
            result["samples"] = _read_jsonl(
                Path(result["artifact_paths"]["chunks_jsonl"]),
                max_rows=max(0, min(int(sample_limit), 100)),
            )
        return result

    def validate(self, job_id: str) -> dict[str, Any]:
        status = self.status(job_id)
        if not status.get("exists"):
            return {"ok": False, **status, "errors": ["job not found"], "warnings": []}
        return _validate_artifact_bundle(Path(str(status["job_dir"])), status=status)

    def submit_batch(
        self,
        *,
        documents: list[Any],
        language: str = "ch",
        device: str | None = None,
        formula_enabled: bool = False,
        table_enabled: bool = False,
        timeout_seconds: int = 3_600,
        cpu_threads: int | None = None,
        max_chars: int = 1_200,
        overlap_chars: int = 160,
        force_jobs: bool = False,
    ) -> dict[str, Any]:
        if not isinstance(documents, list) or not documents:
            raise ValueError("documents must be a non-empty list")
        defaults = {
            "language": language,
            "device": device or _default_device(self.environment),
            "formula_enabled": bool(formula_enabled),
            "table_enabled": bool(table_enabled),
            "timeout_seconds": int(timeout_seconds),
            "cpu_threads": cpu_threads or _default_cpu_threads(self.environment),
            "max_chars": int(max_chars),
            "overlap_chars": int(overlap_chars),
        }
        batch_id = _batch_id(
            {
                "schema_version": BATCH_SCHEMA_VERSION,
                "documents": documents,
                "defaults": defaults,
                "force_jobs": bool(force_jobs),
            }
        )
        batch_dir = self._batch_dir(batch_id)
        self.output_root.mkdir(parents=True, exist_ok=True)
        batch_dir.mkdir(parents=True, exist_ok=False)
        items: list[dict[str, Any]] = []
        for index, raw_spec in enumerate(documents):
            try:
                request = _batch_item_request(raw_spec, defaults=defaults)
                status = self.submit(**request, force=force_jobs)
                items.append(
                    {
                        "index": index,
                        "source_path": request["pdf_path"],
                        "job_id": status.get("job_id"),
                        "job_dir": status.get("job_dir"),
                        "status": status.get("status"),
                        "phase": status.get("phase"),
                        "input_type": _input_type(Path(request["pdf_path"])),
                    }
                )
            except Exception as exc:
                items.append(
                    {
                        "index": index,
                        "source_path": "",
                        "job_id": None,
                        "status": "submit_failed",
                        "phase": "submit_failed",
                        "error": f"{type(exc).__name__}: {exc}",
                    }
                )
        _write_json(
            batch_dir / "batch.json",
            {
                "batch_id": batch_id,
                "status": _batch_overall_status([str(i.get("status")) for i in items]),
                "phase": "submitted",
                "schema_version": BATCH_SCHEMA_VERSION,
                "created_at": _now(),
                "updated_at": _now(),
                "batch_dir": str(batch_dir),
                "request": {
                    "document_count": len(documents),
                    "defaults": defaults,
                    "force_jobs": bool(force_jobs),
                    "execution": "bounded_worker_queue",
                    "max_workers": self.max_workers,
                },
                "items": items,
                "counts": _batch_counts(items),
            },
        )
        return self.batch_status(batch_id)

    def batch_status(self, batch_id: str) -> dict[str, Any]:
        batch_id = _validate_batch_id(batch_id)
        batch_path = self._batch_dir(batch_id) / "batch.json"
        if not batch_path.is_file():
            return {"exists": False, "batch_id": batch_id, "status": "not_found"}
        payload = _read_json(batch_path)
        items: list[dict[str, Any]] = []
        for raw_item in payload.get("items", []):
            item = dict(raw_item)
            job_id = item.get("job_id")
            if isinstance(job_id, str) and job_id:
                child = self.status(job_id)
                item.update(
                    {
                        "status": child.get("status"),
                        "phase": child.get("phase"),
                        "live": child.get("live"),
                        "job_dir": child.get("job_dir", item.get("job_dir")),
                    }
                )
                if child.get("error"):
                    item["error"] = child["error"]
            items.append(item)
        status = _batch_overall_status([str(item.get("status") or "") for item in items])
        return {
            **payload,
            "exists": True,
            "status": status,
            "phase": "complete" if status in {"succeeded", "failed", "partial_failed"} else "running",
            "updated_at": _now(),
            "items": items,
            "counts": _batch_counts(items),
        }

    def batch_result(
        self,
        batch_id: str,
        *,
        include_samples: bool = False,
        sample_limit: int = 3,
        build_bundle: bool = True,
        allow_partial: bool = False,
    ) -> dict[str, Any]:
        status = self.batch_status(batch_id)
        if not status.get("exists"):
            return status
        results: list[dict[str, Any]] = []
        succeeded: list[str] = []
        for item in status.get("items", []):
            job_id = item.get("job_id")
            if not isinstance(job_id, str) or not job_id:
                results.append(dict(item))
                continue
            result = self.result(
                job_id,
                include_samples=include_samples,
                sample_limit=sample_limit,
            )
            results.append(_compact_job_result(result))
            if result.get("status") == "succeeded":
                succeeded.append(job_id)
        response: dict[str, Any] = {**status, "job_results": results}
        if include_samples:
            response["samples"] = _batch_samples(results, sample_limit=sample_limit)
        if build_bundle:
            if status["status"] == "succeeded" or (allow_partial and succeeded):
                response["bundle"] = self._build_batch_bundle(
                    batch_id=batch_id,
                    status=status,
                    succeeded_job_ids=succeeded,
                    partial=status["status"] != "succeeded",
                )
            else:
                response["bundle"] = {
                    "built": False,
                    "reason": "batch is not fully succeeded; pass allow_partial=true to build from succeeded jobs",
                }
        return response

    def batch_validate(self, batch_id: str) -> dict[str, Any]:
        status = self.batch_status(batch_id)
        if not status.get("exists"):
            return {"ok": False, **status, "errors": ["batch not found"], "warnings": []}
        errors: list[str] = []
        validations: list[dict[str, Any]] = []
        for item in status.get("items", []):
            job_id = item.get("job_id")
            if not isinstance(job_id, str) or not job_id:
                errors.append(f"item {item.get('index')} has no job_id")
                continue
            validation = self.validate(job_id)
            validations.append(validation)
            if not validation.get("ok"):
                errors.append(f"job {job_id} failed validation")
        bundle = self._batch_dir(batch_id) / "bundle"
        bundle_validation = (
            _validate_artifact_bundle(bundle) if bundle.is_dir() else None
        )
        if bundle_validation and not bundle_validation["ok"]:
            errors.append("batch bundle failed validation")
        return {
            "ok": not errors and status["status"] == "succeeded",
            "batch_id": batch_id,
            "status": status["status"],
            "schema_version": BATCH_SCHEMA_VERSION,
            "counts": status["counts"],
            "job_validations": validations,
            "bundle_validation": bundle_validation,
            "errors": errors,
            "warnings": [],
        }

    def run_sync(self, **kwargs: Any) -> dict[str, Any]:
        request = self._make_request(
            pdf_path=str(kwargs["pdf_path"]),
            book_id=kwargs.get("book_id"),
            title=kwargs.get("title"),
            volume=kwargs.get("volume"),
            language=kwargs.get("language", "ch"),
            device=kwargs.get("device") or _default_device(self.environment),
            start_page=kwargs.get("start_page"),
            end_page=kwargs.get("end_page"),
            page_index_offset=kwargs.get("page_index_offset"),
            formula_enabled=kwargs.get("formula_enabled", False),
            table_enabled=kwargs.get("table_enabled", False),
            timeout_seconds=kwargs.get("timeout_seconds", 3_600),
            cpu_threads=kwargs.get("cpu_threads"),
            max_chars=kwargs.get("max_chars", 1_200),
            overlap_chars=kwargs.get("overlap_chars", 160),
        )
        source = assert_mineru_source_path(request.pdf_path, self.environment)
        input_type = _input_type(source)
        runtime = self._runtime_for(input_type)
        source_sha256 = _sha256_file(source)
        job_id = _job_id(
            request.fingerprint_payload(
                source_sha256=source_sha256,
                input_type=input_type,
                runtime=runtime,
            )
        )
        job_dir = self._job_dir(job_id)
        existing = self.status(job_id)
        if existing.get("exists") and existing.get("status") == "succeeded":
            return self.result(
                job_id,
                include_samples=bool(kwargs.get("include_samples", False)),
            )
        self.output_root.mkdir(parents=True, exist_ok=True)
        job_dir.mkdir(parents=True, exist_ok=True)
        self._write_job(
            job_id,
            {
                "job_id": job_id,
                "status": "queued",
                "phase": "queued",
                "schema_version": SCHEMA_VERSION,
                "created_at": _now(),
                "updated_at": _now(),
                "request": asdict(request),
                "runtime": _runtime_payload(runtime),
                "source": {
                    "path": str(source),
                    "file_name": source.name,
                    "input_type": input_type,
                    "sha256": source_sha256,
                },
                "job_dir": str(job_dir),
            },
        )
        self._run_job(job_id, request, runtime, source_sha256)
        return self.result(
            job_id,
            include_samples=bool(kwargs.get("include_samples", False)),
        )

    def _make_request(self, **kwargs: Any) -> IngestRequest:
        start_page = kwargs.get("start_page")
        offset = kwargs.get("page_index_offset")
        if offset is None:
            offset = int(start_page) if start_page is not None else 0
        cpu_threads = kwargs.get("cpu_threads")
        if cpu_threads is None:
            cpu_threads = _default_cpu_threads(self.environment)
        return IngestRequest(
            pdf_path=str(kwargs["pdf_path"]),
            book_id=kwargs.get("book_id"),
            title=kwargs.get("title"),
            volume=kwargs.get("volume"),
            language=kwargs.get("language", "ch"),
            device=kwargs.get("device") or _default_device(self.environment),
            start_page=start_page,
            end_page=kwargs.get("end_page"),
            page_index_offset=offset,
            formula_enabled=kwargs.get("formula_enabled", False),
            table_enabled=kwargs.get("table_enabled", False),
            timeout_seconds=kwargs.get("timeout_seconds", 3_600),
            cpu_threads=cpu_threads,
            max_chars=kwargs.get("max_chars", 1_200),
            overlap_chars=kwargs.get("overlap_chars", 160),
        ).normalized()

    def _runtime_for(self, input_type: str) -> MinerURuntime | None:
        if input_type != "pdf":
            return None
        runtime = MinerURuntime.from_environment(self.environment)
        runtime.validate()
        return runtime

    def _run_job(
        self,
        job_id: str,
        request: IngestRequest,
        runtime: MinerURuntime | None,
        source_sha256: str,
    ) -> None:
        try:
            source = Path(request.pdf_path)
            input_type = _input_type(source)
            if input_type == "pdf":
                if runtime is None:
                    raise MinerURuntimeConfigError("MinerU runtime is required for PDF input")
                self._run_pdf_job(job_id, request, runtime, source, source_sha256)
            else:
                self._run_text_job(job_id, request, source, source_sha256, input_type)
        except Exception as exc:
            self._update_job(
                job_id,
                status="failed",
                phase="failed",
                error=f"{type(exc).__name__}: {exc}",
            )
        finally:
            with _LOCK:
                _FUTURES.pop(job_id, None)
                _FUTURE_ROOTS.pop(job_id, None)

    def _run_pdf_job(
        self,
        job_id: str,
        request: IngestRequest,
        runtime: MinerURuntime,
        source: Path,
        source_sha256: str,
    ) -> None:
        job_dir = self._job_dir(job_id)
        self._update_job(job_id, status="running", phase="mineru_parse")
        invocation = MinerUInvocation.from_runtime(
            runtime=runtime,
            source=source,
            output_dir=job_dir / "mineru_raw",
            language=request.language,
            device=request.device,
            start_page=request.start_page,
            end_page=request.end_page,
            formula_enabled=request.formula_enabled,
            table_enabled=request.table_enabled,
            timeout_seconds=request.timeout_seconds,
            cpu_threads=request.cpu_threads,
        )
        completed = run_mineru(invocation)
        logs = job_dir / "logs"
        logs.mkdir(exist_ok=True)
        (logs / "mineru.stdout.log").write_text(completed.stdout or "", encoding="utf-8")
        (logs / "mineru.stderr.log").write_text(completed.stderr or "", encoding="utf-8")
        output = validate_mineru_output(invocation)
        self._update_job(job_id, status="running", phase="build_chunks")
        chunks = build_mineru_chunks(
            source_pdf=source,
            content_list_path=output.content_list_path,
            config=ChunkingConfig(
                max_chars=request.max_chars, overlap_chars=request.overlap_chars
            ),
            page_index_offset=request.page_index_offset,
        )
        chunks = _apply_document_metadata(
            chunks,
            request=request,
            source=source,
            source_file=to_mineru_user_relative_path(source, self.environment),
            source_sha256=source_sha256,
        )
        self._update_job(job_id, status="running", phase="copy_assets")
        chunks, assets, warnings = _copy_assets_and_rewrite_refs(
            chunks=chunks,
            assets_root=job_dir / "assets",
            allowed_root=job_dir / "mineru_raw",
        )
        pages = _build_pdf_page_records(
            source=source,
            content_list_path=output.content_list_path,
            chunks=chunks,
            assets=assets,
            request=request,
        )
        self._write_artifacts(
            job_id=job_id,
            request=request,
            source=source,
            source_path=to_mineru_user_relative_path(source, self.environment),
            source_sha256=source_sha256,
            chunks=chunks,
            pages=pages,
            assets=assets,
            warnings=warnings,
            parser={"input_type": "pdf", "name": "mineru"},
            mineru={
                "used": True,
                "language": request.language,
                "device": request.device,
                "formula_enabled": request.formula_enabled,
                "table_enabled": request.table_enabled,
                "cpu_threads": request.cpu_threads,
            },
        )

    def _run_text_job(
        self,
        job_id: str,
        request: IngestRequest,
        source: Path,
        source_sha256: str,
        input_type: str,
    ) -> None:
        self._update_job(job_id, status="running", phase="extract_text")
        extracted = _extract_text_document(source)
        self._update_job(job_id, status="running", phase="build_chunks")
        chunks = _build_text_chunks(
            source=source,
            request=request,
            source_file=to_mineru_user_relative_path(source, self.environment),
            source_sha256=source_sha256,
            text=extracted["text"],
            parser=extracted["parser"],
        )
        pages = _build_text_page_records(
            source=source,
            request=request,
            chunks=chunks,
            text=extracted["text"],
        )
        self._write_artifacts(
            job_id=job_id,
            request=request,
            source=source,
            source_path=to_mineru_user_relative_path(source, self.environment),
            source_sha256=source_sha256,
            chunks=chunks,
            pages=pages,
            assets=[],
            warnings=extracted["warnings"],
            parser={
                "input_type": input_type,
                "name": extracted["parser"],
                "warnings": extracted["warnings"],
            },
            mineru={"used": False, "reason": "non_pdf_input"},
        )

    def _write_artifacts(
        self,
        *,
        job_id: str,
        request: IngestRequest,
        source: Path,
        source_path: str,
        source_sha256: str,
        chunks: list[dict[str, Any]],
        pages: list[dict[str, Any]],
        assets: list[dict[str, Any]],
        warnings: list[str],
        parser: Mapping[str, Any],
        mineru: Mapping[str, Any],
    ) -> None:
        self._update_job(job_id, status="running", phase="write_artifacts")
        root = self._job_dir(job_id)
        corpus = root / "corpus"
        _write_jsonl(corpus / "chunks.jsonl", chunks)
        _write_jsonl(corpus / "pages.jsonl", pages)
        _write_jsonl(corpus / "assets.jsonl", assets)
        document = _source_document_record(
            request=request,
            source=source,
            source_path=source_path,
            source_sha256=source_sha256,
            chunks=chunks,
            pages=pages,
            assets=assets,
        )
        manifest = {
            "schema_version": SCHEMA_VERSION,
            "corpus_id": request.book_id or job_id,
            "name": request.title or source.stem,
            "version": job_id,
            "created_at": _now(),
            "source_documents": [document],
            "artifacts": {
                "chunks_path": "corpus/chunks.jsonl",
                "pages_path": "corpus/pages.jsonl",
                "assets_path": "corpus/assets.jsonl",
                "assets_dir": "assets",
                "mineru_raw_dir": "mineru_raw",
            },
            "embedding": {
                "ready": False,
                "dimension": None,
                "embedding_path": None,
            },
            "quality": {"report_path": "quality_report.json"},
            "chunking": {
                "max_chars": request.max_chars,
                "overlap_chars": request.overlap_chars,
                "page_index_offset": request.page_index_offset,
            },
            "parser": dict(parser),
            "mineru": dict(mineru),
        }
        _write_json(root / "manifest.json", manifest)
        _write_json(
            root / "quality_report.json",
            _quality_report(
                chunks=chunks, pages=pages, assets=assets, warnings=warnings
            ),
        )
        self._update_job(
            job_id,
            status="succeeded",
            phase="complete",
            result={
                "manifest_path": str(root / "manifest.json"),
                "quality_report_path": str(root / "quality_report.json"),
                "chunk_count": len(chunks),
                "page_count": len(pages),
                "asset_count": len(assets),
                "chunks_with_images": sum(
                    1 for chunk in chunks if chunk.get("image_refs")
                ),
            },
        )

    def _build_batch_bundle(
        self,
        *,
        batch_id: str,
        status: Mapping[str, Any],
        succeeded_job_ids: list[str],
        partial: bool,
    ) -> dict[str, Any]:
        root = self._batch_dir(batch_id) / "bundle"
        chunks: list[dict[str, Any]] = []
        pages: list[dict[str, Any]] = []
        assets_by_id: dict[str, dict[str, Any]] = {}
        documents: list[dict[str, Any]] = []
        source_jobs: list[dict[str, Any]] = []
        warnings: list[str] = []
        for job_id in succeeded_job_ids:
            result = self.result(job_id)
            if result.get("status") != "succeeded":
                continue
            job_dir = Path(str(result["job_dir"]))
            manifest = result["manifest"]
            documents.extend(
                dict(doc)
                for doc in manifest.get("source_documents", [])
                if isinstance(doc, Mapping)
            )
            source_jobs.append(
                {
                    "job_id": job_id,
                    "manifest_path": result["manifest_path"],
                    "quality_report_path": result["quality_report_path"],
                }
            )
            asset_map: dict[str, dict[str, str]] = {}
            for asset in _read_jsonl(Path(result["artifact_paths"]["assets_jsonl"])):
                old_id = str(asset.get("asset_id") or "")
                old_path = str(asset.get("path") or "")
                source_file = job_dir / old_path
                if not old_id or not source_file.is_file():
                    warnings.append(f"skip malformed asset in job {job_id}")
                    continue
                digest = str(asset.get("sha256") or _sha256_file(source_file))
                doc_id = _slug(str(asset.get("doc_id") or job_id))
                relative = f"assets/{doc_id}/{digest[:2]}/{digest}{source_file.suffix.lower() or '.bin'}"
                destination = root / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                if not destination.is_file():
                    shutil.copyfile(source_file, destination)
                new_id = f"asset-{doc_id[:48]}-{digest[:24]}"
                asset_map[old_id] = {"asset_id": new_id, "path": relative}
                item = dict(asset)
                item.update(
                    {
                        "asset_id": new_id,
                        "path": relative,
                        "available": True,
                        "sha256": digest,
                        "bytes": destination.stat().st_size,
                    }
                )
                if new_id not in assets_by_id:
                    item["linked_chunk_ids"] = list(item.get("linked_chunk_ids") or [])
                    assets_by_id[new_id] = item
            for chunk in _read_jsonl(Path(result["artifact_paths"]["chunks_jsonl"])):
                item = dict(chunk)
                refs: list[dict[str, Any]] = []
                for raw_ref in item.get("image_refs") or []:
                    if not isinstance(raw_ref, Mapping):
                        continue
                    ref = dict(raw_ref)
                    mapped = asset_map.get(str(ref.get("asset_id") or ""))
                    if mapped:
                        ref.update(mapped, available=True)
                        assets_by_id[mapped["asset_id"]].setdefault(
                            "linked_chunk_ids", []
                        ).append(str(item.get("chunk_id") or ""))
                    refs.append(ref)
                item["image_refs"] = refs
                item["contents"] = _contextual_contents(
                    title=str(item.get("title") or ""),
                    chapter_path=str(item.get("chapter_path") or ""),
                    text=str(item.get("text") or ""),
                    image_refs=refs,
                )
                chunks.append(item)
            for page in _read_jsonl(Path(result["artifact_paths"]["pages_jsonl"])):
                item = dict(page)
                item["asset_ids"] = [
                    asset_map[asset_id]["asset_id"]
                    for asset_id in item.get("asset_ids") or []
                    if asset_id in asset_map
                ]
                pages.append(item)
        assets = sorted(
            assets_by_id.values(),
            key=lambda item: (
                str(item.get("doc_id") or ""),
                int(item.get("page") or 0),
                str(item.get("asset_id") or ""),
            ),
        )
        corpus = root / "corpus"
        _write_jsonl(corpus / "chunks.jsonl", chunks)
        _write_jsonl(corpus / "pages.jsonl", pages)
        _write_jsonl(corpus / "assets.jsonl", assets)
        _write_json(
            root / "manifest.json",
            {
                "schema_version": SCHEMA_VERSION,
                "corpus_id": batch_id,
                "name": f"MinerU batch {batch_id}",
                "version": batch_id,
                "created_at": _now(),
                "source_documents": documents,
                "source_jobs": source_jobs,
                "batch": {
                    "batch_id": batch_id,
                    "status": status.get("status"),
                    "partial": partial,
                    "counts": status.get("counts"),
                },
                "artifacts": {
                    "chunks_path": "corpus/chunks.jsonl",
                    "pages_path": "corpus/pages.jsonl",
                    "assets_path": "corpus/assets.jsonl",
                    "assets_dir": "assets",
                },
                "quality": {"report_path": "quality_report.json"},
                "embedding": {
                    "ready": False,
                    "dimension": None,
                    "embedding_path": None,
                },
            },
        )
        _write_json(
            root / "quality_report.json",
            _quality_report(
                chunks=chunks,
                pages=pages,
                assets=assets,
                warnings=warnings + (["partial batch bundle"] if partial else []),
            ),
        )
        return {
            "built": True,
            "partial": partial,
            "bundle_dir": str(root),
            "manifest_path": str(root / "manifest.json"),
            "quality_report_path": str(root / "quality_report.json"),
            "artifact_paths": {
                "chunks_jsonl": str(corpus / "chunks.jsonl"),
                "pages_jsonl": str(corpus / "pages.jsonl"),
                "assets_jsonl": str(corpus / "assets.jsonl"),
                "assets_dir": str(root / "assets"),
            },
            "counts": {
                "chunks": len(chunks),
                "pages": len(pages),
                "assets": len(assets),
                "source_documents": len(documents),
            },
            "validation": _validate_artifact_bundle(root),
        }

    def _job_dir(self, job_id: str) -> Path:
        return self.output_root / "jobs" / _validate_job_id(job_id)

    def _batch_dir(self, batch_id: str) -> Path:
        return self.output_root / "batches" / _validate_batch_id(batch_id)

    def _write_job(self, job_id: str, payload: Mapping[str, Any]) -> None:
        _write_json(self._job_dir(job_id) / "job.json", payload)

    def _update_job(
        self,
        job_id: str,
        *,
        status: str,
        phase: str,
        result: Mapping[str, Any] | None = None,
        error: str | None = None,
    ) -> None:
        path = self._job_dir(job_id) / "job.json"
        payload = _read_json(path)
        payload.update({"status": status, "phase": phase, "updated_at": _now()})
        if result is not None:
            payload["result"] = dict(result)
        if error is not None:
            payload["error"] = error[:4_000]
        _write_json(path, payload)


def _validate_source(path_value: str, environment: Mapping[str, str]) -> Path:
    path = assert_mineru_source_path(path_value, environment)
    if path.suffix.lower() not in SUPPORTED_INPUT_SUFFIXES and not _try_decode_text(path)[0].strip():
        raise ValueError(
            f"unsupported input type: {path.suffix or '(no suffix)'}; "
            f"supported: {', '.join(SUPPORTED_INPUT_SUFFIXES)}"
        )
    return path


def _input_type(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in PDF_SUFFIXES:
        return "pdf"
    if suffix in DOCX_SUFFIXES:
        return "docx"
    if suffix in LEGACY_DOC_SUFFIXES:
        return "doc"
    if suffix in TEXT_SUFFIXES:
        return suffix.lstrip(".")
    return "text"


def _runtime_payload(runtime: MinerURuntime | None) -> dict[str, Any]:
    if runtime is None:
        return {"required": False, "configured": False}
    return {
        "required": True,
        "configured": True,
        "launcher": list(runtime.launcher),
        "model_root": str(runtime.model_root),
    }


def _extract_text_document(source: Path) -> dict[str, Any]:
    suffix = source.suffix.lower()
    warnings: list[str] = []
    if suffix in DOCX_SUFFIXES:
        text = _extract_docx_text(source)
        parser = "docx_ooxml_text"
    elif suffix in LEGACY_DOC_SUFFIXES:
        text = _extract_legacy_doc_text(source, warnings)
        parser = "legacy_doc_text"
    else:
        text, encoding = _try_decode_text(source)
        parser = f"text_decode_{encoding}"
        if suffix in {".html", ".htm"}:
            text = _strip_html(text)
            parser = f"html_text_decode_{encoding}"
    text = _normalize_document_text(text)
    if not text:
        raise ValueError(f"no extractable text from {source}")
    return {"text": text, "parser": parser, "warnings": warnings}


def _extract_docx_text(source: Path) -> str:
    try:
        with zipfile.ZipFile(source) as archive:
            xml_bytes = archive.read("word/document.xml")
    except (KeyError, zipfile.BadZipFile) as exc:
        raise ValueError(f"invalid docx document: {source}") from exc
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError as exc:
        raise ValueError(f"invalid docx document.xml: {source}") from exc
    paragraphs: list[str] = []
    for paragraph in root.iter():
        if _xml_local_name(paragraph.tag) != "p":
            continue
        parts: list[str] = []
        for node in paragraph.iter():
            local = _xml_local_name(node.tag)
            if local == "t" and node.text:
                parts.append(node.text)
            elif local == "tab":
                parts.append("\t")
            elif local in {"br", "cr"}:
                parts.append("\n")
        if "".join(parts).strip():
            paragraphs.append("".join(parts).strip())
    return "\n\n".join(paragraphs)


def _extract_legacy_doc_text(source: Path, warnings: list[str]) -> str:
    for command in (("antiword", str(source)), ("catdoc", str(source))):
        if shutil.which(command[0]) is None:
            continue
        completed = subprocess.run(
            command, check=False, capture_output=True, text=True, timeout=120
        )
        if completed.returncode == 0 and completed.stdout.strip():
            warnings.append(f"legacy .doc converted with {command[0]}")
            return completed.stdout
    warnings.append("legacy .doc used best-effort binary text extraction")
    data = source.read_bytes()
    return "\n".join(
        part.strip()
        for part in re.findall(
            r"[\u4e00-\u9fffA-Za-z0-9，。；：、！？（）《》【】“”‘’.,;:!?()\s]{4,}",
            data.decode("latin1", errors="ignore"),
        )
        if part.strip()
    )


def _try_decode_text(source: Path) -> tuple[str, str]:
    data = source.read_bytes()
    for encoding in ("utf-8-sig", "utf-8", "gb18030", "utf-16"):
        try:
            return data.decode(encoding), encoding
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="ignore"), "utf-8-ignore"


def _strip_html(text: str) -> str:
    text = re.sub(r"(?is)<(script|style).*?>.*?</\1>", "\n", text)
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = re.sub(r"(?i)</(p|div|li|tr|h[1-6])>", "\n", text)
    return html.unescape(re.sub(r"(?s)<[^>]+>", " ", text))


def _normalize_document_text(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t\f\v]+", " ", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def _build_text_chunks(
    *,
    source: Path,
    request: IngestRequest,
    source_file: str,
    source_sha256: str,
    text: str,
    parser: str,
) -> list[dict[str, Any]]:
    doc_id = _document_id(source, request)
    title = request.title or source.stem
    chunks: list[dict[str, Any]] = []
    for index, chunk_text in enumerate(
        _split_text_for_chunks(
            text, max_chars=request.max_chars, overlap_chars=request.overlap_chars
        )
    ):
        chunks.append(
            {
                "chunk_id": f"{doc_id}-{index:04d}-000",
                "doc_id": doc_id,
                "title": title,
                "volume": request.volume or "",
                "chapter_path": "",
                "content_type": "text",
                "text": chunk_text,
                "contents": _contextual_contents(
                    title=title, chapter_path="", text=chunk_text, image_refs=[]
                ),
                "page_start": 1,
                "page_end": 1,
                "image_refs": [],
                "source_file": source_file,
                "source_sha256": source_sha256,
                "parser": parser,
            }
        )
    if not chunks:
        raise ValueError("document contains no usable text")
    return chunks


def _split_text_for_chunks(text: str, *, max_chars: int, overlap_chars: int) -> list[str]:
    config = ChunkingConfig(max_chars=max_chars, overlap_chars=overlap_chars)
    paragraphs = [part.strip() for part in re.split(r"\n{2,}", text) if part.strip()]
    chunks: list[str] = []
    current = ""
    for paragraph in paragraphs or [text.strip()]:
        if len(paragraph) > config.max_chars:
            if current:
                chunks.append(current)
            chunks.extend(
                paragraph[start : start + config.max_chars].strip()
                for start in range(
                    0,
                    len(paragraph),
                    max(1, config.max_chars - config.overlap_chars),
                )
            )
            current = ""
            continue
        candidate = f"{current}\n\n{paragraph}".strip() if current else paragraph
        if len(candidate) <= config.max_chars:
            current = candidate
        else:
            if current:
                chunks.append(current)
            overlap = current[-config.overlap_chars :].strip() if current else ""
            candidate = f"{overlap}\n\n{paragraph}".strip() if overlap else paragraph
            current = candidate if len(candidate) <= config.max_chars else paragraph
    if current:
        chunks.append(current)
    return chunks


def _build_text_page_records(
    *, source: Path, request: IngestRequest, chunks: list[dict[str, Any]], text: str
) -> list[dict[str, Any]]:
    doc_id = _document_id(source, request)
    return [
        {
            "page_id": f"{doc_id}-p0001",
            "doc_id": doc_id,
            "title": request.title or source.stem,
            "volume": request.volume or "",
            "page": 1,
            "text": text,
            "chunk_ids": [str(chunk["chunk_id"]) for chunk in chunks],
            "text_chunk_ids": [str(chunk["chunk_id"]) for chunk in chunks],
            "asset_ids": [],
        }
    ]


def _apply_document_metadata(
    chunks: list[dict[str, Any]],
    *,
    request: IngestRequest,
    source: Path,
    source_file: str,
    source_sha256: str,
) -> list[dict[str, Any]]:
    doc_id = _document_id(source, request)
    result: list[dict[str, Any]] = []
    for index, chunk in enumerate(chunks):
        item = dict(chunk)
        suffix = "-".join(str(item.get("chunk_id") or "").split("-")[-2:])
        if not re.fullmatch(r"\d{4}-\d{3}", suffix):
            suffix = f"{index:04d}-000"
        item.update(
            {
                "chunk_id": f"{doc_id}-{suffix}",
                "doc_id": doc_id,
                "title": request.title or source.stem,
                "volume": request.volume or "",
                "source_file": source_file,
                "source_sha256": source_sha256,
            }
        )
        item["contents"] = _contextual_contents(
            title=str(item["title"]),
            chapter_path=str(item.get("chapter_path") or ""),
            text=str(item.get("text") or ""),
            image_refs=item.get("image_refs") or [],
        )
        result.append(item)
    return result


def _copy_assets_and_rewrite_refs(
    *,
    chunks: list[dict[str, Any]],
    assets_root: Path,
    allowed_root: Path,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str]]:
    assets_by_id: dict[str, dict[str, Any]] = {}
    copied: dict[Path, dict[str, Any]] = {}
    warnings: list[str] = []
    rewritten_chunks: list[dict[str, Any]] = []
    allowed_root = allowed_root.resolve()
    for chunk in chunks:
        item = dict(chunk)
        refs: list[dict[str, Any]] = []
        for index, raw_ref in enumerate(item.get("image_refs") or []):
            if not isinstance(raw_ref, Mapping):
                continue
            ref = dict(raw_ref)
            source_value = str(ref.pop("source_path", "") or "")
            try:
                source = Path(source_value).resolve(strict=True)
                source.relative_to(allowed_root)
            except (OSError, RuntimeError, ValueError):
                warnings.append(f"unsafe or missing image asset at ref {index}")
                continue
            if not source.is_file():
                continue
            existing = copied.get(source)
            if existing is None:
                digest = _sha256_file(source)
                destination = assets_root / digest[:2] / f"{digest}{source.suffix.lower() or '.bin'}"
                destination.parent.mkdir(parents=True, exist_ok=True)
                if not destination.is_file():
                    shutil.copyfile(source, destination)
                existing = {
                    "asset_id": f"asset-{digest[:24]}",
                    "asset_type": "figure",
                    "path": destination.relative_to(assets_root.parent).as_posix(),
                    "available": True,
                    "sha256": digest,
                    "bytes": destination.stat().st_size,
                }
                copied[source] = existing
            asset = {
                **existing,
                "doc_id": str(item.get("doc_id") or ""),
                "page": _optional_positive_int(ref.get("page")),
                "caption": str(ref.get("caption") or "")[:1_000],
                "figure_no": _figure_no(str(ref.get("caption") or "")),
                "linked_chunk_ids": [],
            }
            assets_by_id.setdefault(asset["asset_id"], asset)
            assets_by_id[asset["asset_id"]]["linked_chunk_ids"].append(
                str(item.get("chunk_id") or "")
            )
            refs.append(
                {
                    "asset_id": asset["asset_id"],
                    "asset_type": "figure",
                    "path": asset["path"],
                    "available": True,
                    "caption": asset["caption"],
                    "page": asset["page"],
                    "relation": str(ref.get("relation") or "same_page"),
                    "figure_no": asset["figure_no"],
                }
            )
        item["image_refs"] = refs
        item["contents"] = _contextual_contents(
            title=str(item.get("title") or ""),
            chapter_path=str(item.get("chapter_path") or ""),
            text=str(item.get("text") or ""),
            image_refs=refs,
        )
        rewritten_chunks.append(item)
    return rewritten_chunks, list(assets_by_id.values()), warnings


def _build_pdf_page_records(
    *,
    source: Path,
    content_list_path: Path,
    chunks: list[dict[str, Any]],
    assets: list[dict[str, Any]],
    request: IngestRequest,
) -> list[dict[str, Any]]:
    raw = json.loads(content_list_path.read_text(encoding="utf-8"))
    text_by_page: dict[int, list[str]] = {}
    for block in raw if isinstance(raw, list) else []:
        if not isinstance(block, Mapping) or block.get("type") != "text":
            continue
        text = _normalize_text(str(block.get("text") or ""))
        if text:
            page = int(block.get("page_idx", 0)) + 1 + request.page_index_offset
            text_by_page.setdefault(page, []).append(text)
    chunks_by_page: dict[int, list[str]] = {}
    for chunk in chunks:
        start = _optional_positive_int(chunk.get("page_start")) or 1
        end = _optional_positive_int(chunk.get("page_end")) or start
        for page in range(start, end + 1):
            chunks_by_page.setdefault(page, []).append(str(chunk["chunk_id"]))
    assets_by_page: dict[int, list[str]] = {}
    for asset in assets:
        page = _optional_positive_int(asset.get("page"))
        if page:
            assets_by_page.setdefault(page, []).append(str(asset["asset_id"]))
    doc_id = _document_id(source, request)
    return [
        {
            "page_id": f"{doc_id}-p{page:04d}",
            "doc_id": doc_id,
            "title": request.title or source.stem,
            "volume": request.volume or "",
            "page": page,
            "text": "\n".join(text_by_page.get(page, [])),
            "chunk_ids": chunks_by_page.get(page, []),
            "text_chunk_ids": chunks_by_page.get(page, []),
            "asset_ids": assets_by_page.get(page, []),
        }
        for page in sorted(set(text_by_page) | set(chunks_by_page) | set(assets_by_page))
    ]


def _source_document_record(
    *,
    request: IngestRequest,
    source: Path,
    source_path: str,
    source_sha256: str,
    chunks: list[dict[str, Any]],
    pages: list[dict[str, Any]],
    assets: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "document_id": chunks[0]["doc_id"] if chunks else _document_id(source, request),
        "title": request.title or source.stem,
        "volume": request.volume or "",
        "source_path": source_path,
        "source_file_name": source.name,
        "input_type": _input_type(source),
        "source_sha256": source_sha256,
        "page_start": min((int(page["page"]) for page in pages), default=None),
        "page_end": max((int(page["page"]) for page in pages), default=None),
        "chunk_count": len(chunks),
        "asset_count": len(assets),
    }


def _quality_report(
    *,
    chunks: list[dict[str, Any]],
    pages: list[dict[str, Any]],
    assets: list[dict[str, Any]],
    warnings: list[str],
) -> dict[str, Any]:
    lengths = [len(str(chunk.get("text") or "")) for chunk in chunks]
    by_type: dict[str, int] = {}
    for chunk in chunks:
        kind = str(chunk.get("content_type") or "unknown")
        by_type[kind] = by_type.get(kind, 0) + 1
    page_numbers = [_optional_positive_int(page.get("page")) for page in pages]
    page_numbers = [page for page in page_numbers if page]
    empty_captions = sum(not str(asset.get("caption") or "").strip() for asset in assets)
    return {
        "schema_version": SCHEMA_VERSION,
        "created_at": _now(),
        "counts": {
            "chunks": len(chunks),
            "pages": len(pages),
            "assets": len(assets),
            "chunks_with_images": sum(bool(chunk.get("image_refs")) for chunk in chunks),
            "available_assets": sum(bool(asset.get("available")) for asset in assets),
            "pages_with_assets": sum(bool(page.get("asset_ids")) for page in pages),
            "empty_caption_assets": empty_captions,
            "captioned_assets": len(assets) - empty_captions,
        },
        "pages": {
            "min_page": min(page_numbers, default=None),
            "max_page": max(page_numbers, default=None),
        },
        "chunks_by_content_type": by_type,
        "text": {
            "min_chars": min(lengths, default=0),
            "max_chars": max(lengths, default=0),
            "avg_chars": round(sum(lengths) / len(lengths), 2) if lengths else 0,
        },
        "warnings": warnings,
    }


def _validate_artifact_bundle(
    root: Path, *, status: Mapping[str, Any] | None = None
) -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []
    paths = {
        "manifest": root / "manifest.json",
        "chunks": root / "corpus" / "chunks.jsonl",
        "pages": root / "corpus" / "pages.jsonl",
        "assets": root / "corpus" / "assets.jsonl",
    }
    for path in paths.values():
        if not path.is_file():
            errors.append(f"missing artifact: {path.name}")
    chunks = _read_jsonl(paths["chunks"]) if paths["chunks"].is_file() else []
    pages = _read_jsonl(paths["pages"]) if paths["pages"].is_file() else []
    assets = _read_jsonl(paths["assets"]) if paths["assets"].is_file() else []
    chunk_ids = [str(item.get("chunk_id") or "") for item in chunks]
    page_ids = [str(item.get("page_id") or "") for item in pages]
    asset_ids = [str(item.get("asset_id") or "") for item in assets]
    if len(chunk_ids) != len(set(chunk_ids)):
        errors.append("duplicate chunk_id values")
    if len(page_ids) != len(set(page_ids)):
        errors.append("duplicate page_id values")
    if len(asset_ids) != len(set(asset_ids)):
        errors.append("duplicate asset_id values")
    if not chunks:
        errors.append("chunks.jsonl is empty")
    asset_set = set(asset_ids)
    for asset in assets:
        value = str(asset.get("path") or "")
        path = Path(value)
        if path.is_absolute() or ".." in path.parts or not value.startswith("assets/"):
            errors.append(f"unsafe asset path: {value}")
        elif asset.get("available") and not (root / path).is_file():
            errors.append(f"asset file missing: {value}")
    for chunk in chunks:
        refs = chunk.get("image_refs") or []
        if not isinstance(refs, list):
            errors.append(f"chunk image_refs is not a list: {chunk.get('chunk_id')}")
            continue
        for ref in refs:
            if not isinstance(ref, Mapping):
                errors.append(f"chunk image_ref is not an object: {chunk.get('chunk_id')}")
                continue
            if ref.get("asset_id") and str(ref["asset_id"]) not in asset_set:
                errors.append(f"chunk references missing asset_id: {ref['asset_id']}")
            value = str(ref.get("path") or "")
            if value and (Path(value).is_absolute() or ".." in Path(value).parts):
                errors.append(f"chunk has unsafe image path: {value}")
    for page in pages:
        for asset_id in page.get("asset_ids") or []:
            if str(asset_id) not in asset_set:
                errors.append(f"page references missing asset_id: {asset_id}")
    if not assets:
        warnings.append("assets.jsonl is empty")
    result = {
        "ok": not errors,
        "schema_version": SCHEMA_VERSION,
        "manifest_path": str(paths["manifest"]),
        "counts": {
            "chunks": len(chunks),
            "pages": len(pages),
            "assets": len(assets),
            "chunks_with_images": sum(bool(chunk.get("image_refs")) for chunk in chunks),
        },
        "errors": errors,
        "warnings": warnings,
    }
    if status is not None:
        result.update({"job_id": status.get("job_id"), "status": status.get("status")})
        if status.get("status") != "succeeded":
            result["warnings"].append(f"job status is {status.get('status')}")
    return result


def _batch_item_request(
    raw_spec: Any, *, defaults: Mapping[str, Any]
) -> dict[str, Any]:
    spec: Mapping[str, Any]
    if isinstance(raw_spec, str):
        spec = {"path": raw_spec}
    elif isinstance(raw_spec, Mapping):
        spec = raw_spec
    else:
        raise ValueError("each document item must be a path string or object")
    path = str(spec.get("source_path") or spec.get("pdf_path") or spec.get("path") or "").strip()
    if not path:
        raise ValueError("source_path is required for each document item")
    start_page = spec.get("start_page")
    return {
        "pdf_path": path,
        "book_id": spec.get("book_id"),
        "title": spec.get("title"),
        "volume": spec.get("volume"),
        "language": spec.get("language", defaults["language"]),
        "device": spec.get("device", defaults["device"]),
        "start_page": start_page,
        "end_page": spec.get("end_page"),
        "page_index_offset": spec.get(
            "page_index_offset",
            int(start_page) if start_page is not None else 0,
        ),
        "formula_enabled": spec.get("formula_enabled", defaults["formula_enabled"]),
        "table_enabled": spec.get("table_enabled", defaults["table_enabled"]),
        "timeout_seconds": spec.get("timeout_seconds", defaults["timeout_seconds"]),
        "cpu_threads": spec.get("cpu_threads", defaults["cpu_threads"]),
        "max_chars": spec.get("max_chars", defaults["max_chars"]),
        "overlap_chars": spec.get("overlap_chars", defaults["overlap_chars"]),
    }


def _raw_source_path(raw_spec: Any) -> str:
    if isinstance(raw_spec, Mapping):
        return str(raw_spec.get("source_path") or raw_spec.get("pdf_path") or raw_spec.get("path") or "")
    return str(raw_spec or "")


def _batch_counts(items: list[Mapping[str, Any]]) -> dict[str, int]:
    counts = {
        "total": len(items),
        "queued": 0,
        "running": 0,
        "succeeded": 0,
        "failed": 0,
        "pending": 0,
        "terminal": 0,
    }
    for item in items:
        status = str(item.get("status") or "")
        if status in {"queued", "running"}:
            counts[status] += 1
        elif status == "succeeded":
            counts["succeeded"] += 1
        else:
            counts["failed"] += 1
    counts["pending"] = counts["queued"] + counts["running"]
    counts["terminal"] = counts["succeeded"] + counts["failed"]
    return counts


def _batch_overall_status(statuses: list[str]) -> str:
    if any(status in {"queued", "running"} for status in statuses):
        return "running"
    failed = sum(status != "succeeded" for status in statuses)
    succeeded = sum(status == "succeeded" for status in statuses)
    if failed and succeeded:
        return "partial_failed"
    return "succeeded" if succeeded == len(statuses) and succeeded else "failed"


def _compact_job_result(result: Mapping[str, Any]) -> dict[str, Any]:
    keys = (
        "job_id",
        "status",
        "phase",
        "job_dir",
        "manifest_path",
        "quality_report_path",
        "artifact_paths",
        "result",
        "quality",
        "error",
        "samples",
    )
    return {key: result[key] for key in keys if key in result}


def _batch_samples(results: list[Mapping[str, Any]], *, sample_limit: int) -> list[dict[str, Any]]:
    samples: list[dict[str, Any]] = []
    for result in results:
        for sample in result.get("samples") or []:
            if isinstance(sample, Mapping):
                samples.append(dict(sample))
                if len(samples) >= sample_limit:
                    return samples
    return samples


def _clean_optional(value: Any) -> str | None:
    text = str(value).strip() if value is not None else ""
    return text or None


def _optional_non_negative(value: Any, name: str) -> int | None:
    if value is None:
        return None
    number = int(value)
    if number < 0:
        raise ValueError(f"{name} must be non-negative")
    return number


def _optional_positive_int(value: Any) -> int | None:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def _default_cpu_threads(environment: Mapping[str, str]) -> int:
    try:
        value = int(str(environment.get(DEFAULT_CPU_THREADS_ENV, "")).strip() or "8")
    except ValueError:
        value = 8
    return max(1, min(value, 64))


def _default_device(environment: Mapping[str, str]) -> str:
    value = str(environment.get(DEFAULT_DEVICE_ENV, "")).strip().lower()
    return value or "cpu"


def _max_workers(environment: Mapping[str, str]) -> int:
    try:
        value = int(str(environment.get(MAX_WORKERS_ENV, "")).strip() or "1")
    except ValueError as exc:
        raise ValueError(f"{MAX_WORKERS_ENV} must be an integer between 1 and 8") from exc
    if not 1 <= value <= 8:
        raise ValueError(f"{MAX_WORKERS_ENV} must be between 1 and 8")
    return value


def _document_id(source: Path, request: IngestRequest) -> str:
    if request.book_id:
        return _slug(request.book_id)
    digest = hashlib.sha256(str(source.resolve()).encode("utf-8")).hexdigest()[:12]
    return f"mineru-{_slug(source.stem)}-{digest}"


def _contextual_contents(
    *, title: str, chapter_path: str, text: str, image_refs: list[dict[str, Any]]
) -> str:
    context = f"书名：{title}"
    if chapter_path:
        context += f"\n章节：{chapter_path}"
    captions = []
    seen: set[str] = set()
    for ref in image_refs:
        caption = _normalize_text(str(ref.get("caption") or ""))
        if caption and caption not in seen:
            seen.add(caption)
            captions.append(caption)
    if captions:
        context += "\n相关图示：" + "；".join(captions)
    return f"{context}\n\n{text}"


def _figure_no(caption: str) -> str:
    match = re.search(
        r"(图|Fig(?:ure)?\.?)\s*([0-9０-９一二三四五六七八九十百.-]+)",
        caption,
        flags=re.I,
    )
    return f"{match.group(1)}{match.group(2)}" if match else ""


def _slug(value: str) -> str:
    value = re.sub(r"\s+", "-", value.strip())
    value = re.sub(r"[^\w\u4e00-\u9fff.-]+", "-", value).strip(".-_")
    return value[:120] or "document"


def _job_id(payload: Mapping[str, Any]) -> str:
    digest = hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()
    return f"job-{digest[:24]}"


def _validate_job_id(job_id: str) -> str:
    value = str(job_id or "").strip()
    if not re.fullmatch(r"job-[a-f0-9]{24}(?:-\d{10,20})?", value):
        raise ValueError("invalid job_id")
    return value


def _batch_id(payload: Mapping[str, Any]) -> str:
    digest = hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()
    return f"batch-{digest[:24]}-{time.time_ns()}"


def _validate_batch_id(batch_id: str) -> str:
    value = str(batch_id or "").strip()
    if not re.fullmatch(r"batch-[a-f0-9]{24}-\d{10,20}", value):
        raise ValueError("invalid batch_id")
    return value


def _normalize_text(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _xml_local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while block := stream.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def _read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _write_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def _read_jsonl(path: Path, *, max_rows: int | None = None) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as stream:
        for line in stream:
            if not line.strip():
                continue
            rows.append(json.loads(line))
            if max_rows is not None and len(rows) >= max_rows:
                break
    return rows


def _write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        for row in rows:
            stream.write(json.dumps(row, ensure_ascii=False, sort_keys=True))
            stream.write("\n")
    temporary.replace(path)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()
