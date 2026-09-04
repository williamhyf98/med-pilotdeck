"""Async MinerU PDF ingestion service for producing portable chunk artifacts.

This module intentionally stops before embedding.  Its job is to turn one PDF
into the normalized records used by the RAG pipeline:

* ``corpus/chunks.jsonl`` for text retrieval ingestion
* ``corpus/assets.jsonl`` for copied figures/images
* ``corpus/pages.jsonl`` for page-level provenance
* ``manifest.json`` and ``quality_report.json`` for handoff/validation

MinerU itself remains an external runtime configured by environment variables;
the service never packages MinerU or hard-codes a shared installation path.
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

from .rag.mineru_adapter import (
    MinerUInvocation,
    run_mineru,
    validate_mineru_output,
)
from .rag.mineru_chunking import ChunkingConfig, build_mineru_chunks
from .rag.mineru_runtime import (
    MINERU_LAUNCHER_ENV,
    MINERU_MODEL_ROOT_ENV,
    MinerURuntime,
    MinerURuntimeConfigError,
)


INGEST_ROOT_ENV = "MED_RAG_MINERU_INGEST_ROOT"
DEFAULT_CPU_THREADS_ENV = "MED_RAG_MINERU_DEFAULT_CPU_THREADS"
MAX_WORKERS_ENV = "MED_RAG_MINERU_MAX_WORKERS"
MCP_TRANSPORT_ENV = "MED_RAG_MINERU_MCP_TRANSPORT"
DEFAULT_INGEST_ROOT = Path("/slow_share/jiangzhenming/mineru-ingest")
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
SUPPORTED_INPUT_SUFFIXES = sorted(PDF_SUFFIXES | DOCX_SUFFIXES | LEGACY_DOC_SUFFIXES | TEXT_SUFFIXES)

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
        pdf = str(Path(self.pdf_path).expanduser().resolve())
        book_id = _clean_optional(self.book_id)
        title = _clean_optional(self.title)
        volume = _clean_optional(self.volume)
        language = (self.language or "ch").strip() or "ch"
        device = (self.device or "cpu").strip().lower() or "cpu"
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
        max_chars = int(self.max_chars)
        overlap_chars = int(self.overlap_chars)
        ChunkingConfig(max_chars=max_chars, overlap_chars=overlap_chars)
        return IngestRequest(
            pdf_path=pdf,
            book_id=book_id,
            title=title,
            volume=volume,
            language=language,
            device=device,
            start_page=start_page,
            end_page=end_page,
            page_index_offset=page_index_offset,
            formula_enabled=bool(self.formula_enabled),
            table_enabled=bool(self.table_enabled),
            timeout_seconds=timeout_seconds,
            cpu_threads=cpu_threads,
            max_chars=max_chars,
            overlap_chars=overlap_chars,
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
            "pdf_path": self.pdf_path,
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
            payload.update(
                {
                    "mineru_launcher": list(runtime.launcher),
                    "mineru_model_root": str(runtime.model_root),
                }
            )
        return payload


class MinerUIngestService:
    def __init__(
        self,
        *,
        output_root: Path | None = None,
        environment: Mapping[str, str] | None = None,
    ) -> None:
        self.environment = dict(os.environ if environment is None else environment)
        root = output_root or Path(self.environment.get(INGEST_ROOT_ENV, str(DEFAULT_INGEST_ROOT)))
        self.output_root = root.expanduser().resolve()
        self.max_workers = _max_workers(self.environment)

    def _executor(self) -> concurrent.futures.ThreadPoolExecutor:
        """Return the process-local worker pool for this configured capacity.

        The MCP transport does not determine concurrency.  Both stdio and HTTP
        use this same bounded queue, so an HTTP endpoint cannot accidentally
        launch an unbounded number of MinerU subprocesses.
        """

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
        """Return service readiness without creating output directories."""

        payload: dict[str, Any] = {
            "ok": True,
            "service": "mineru-ingest-tools",
            "schema_version": SCHEMA_VERSION,
            "supported_inputs": SUPPORTED_INPUT_SUFFIXES,
            "input_modes": {
                "pdf": "MinerU OCR/layout parse",
                "docx": "OOXML text extraction with normalized chunks",
                "doc": "legacy Word best-effort text extraction; external converter used when available",
                "text": "plain/common text extraction with normalized chunks",
            },
            "async": True,
            "transport": str(self.environment.get(MCP_TRANSPORT_ENV, "stdio")).strip() or "stdio",
            "embedding": {"enabled": False, "reason": "MVP only writes normalized chunks"},
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
            "runtime": {
                "configured": False,
                "launcher": self.environment.get(MINERU_LAUNCHER_ENV, ""),
                "model_root": self.environment.get(MINERU_MODEL_ROOT_ENV, ""),
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
        except Exception as exc:  # noqa: BLE001 - health should explain all config failures
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
        device: str = "cpu",
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
        """Create an async job and return immediately."""

        request = IngestRequest(
            pdf_path=pdf_path,
            book_id=book_id,
            title=title,
            volume=volume,
            language=language,
            device=device,
            start_page=start_page,
            end_page=end_page,
            page_index_offset=_resolve_page_index_offset(start_page, page_index_offset),
            formula_enabled=formula_enabled,
            table_enabled=table_enabled,
            timeout_seconds=timeout_seconds,
            cpu_threads=cpu_threads or _default_cpu_threads(self.environment),
            max_chars=max_chars,
            overlap_chars=overlap_chars,
        ).normalized()
        source = _validate_source(request.pdf_path)
        input_type = _input_type(source)
        runtime: MinerURuntime | None = None
        if input_type == "pdf":
            runtime = MinerURuntime.from_environment(self.environment)
            runtime.validate()
        source_sha256 = _sha256_file(source)
        payload = request.fingerprint_payload(source_sha256=source_sha256, input_type=input_type, runtime=runtime)
        job_id = _job_id(payload)
        if force:
            job_id = f"{job_id}-{int(time.time())}"
        job_dir = self._job_dir(job_id)
        existing = self.status(job_id)
        live_running = bool(existing.get("live")) and existing.get("status") == "running"
        if existing.get("exists") and not force:
            return existing
        self.output_root.mkdir(parents=True, exist_ok=True)
        job_dir.mkdir(parents=True, exist_ok=False)
        _write_json(
            job_dir / "job.json",
            {
                "job_id": job_id,
                "status": "queued",
                "phase": "queued",
                "schema_version": SCHEMA_VERSION,
                "created_at": _now(),
                "updated_at": _now(),
                "live": live_running,
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
        future = self._executor().submit(self._run_job, job_id, request, runtime, source_sha256)
        with _LOCK:
            _FUTURES[job_id] = future
            _FUTURE_ROOTS[job_id] = self.output_root
        return self.status(job_id)

    def status(self, job_id: str) -> dict[str, Any]:
        job_id = _validate_job_id(job_id)
        job_dir = self._job_dir(job_id)
        job_path = job_dir / "job.json"
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

    def result(self, job_id: str, *, include_samples: bool = False, sample_limit: int = 3) -> dict[str, Any]:
        status = self.status(job_id)
        if not status.get("exists"):
            return status
        if status.get("status") != "succeeded":
            return status
        job_dir = Path(str(status["job_dir"]))
        manifest_path = job_dir / "manifest.json"
        quality_path = job_dir / "quality_report.json"
        result = {
            **status,
            "manifest_path": str(manifest_path),
            "quality_report_path": str(quality_path),
            "artifact_paths": {
                "chunks_jsonl": str(job_dir / "corpus" / "chunks.jsonl"),
                "pages_jsonl": str(job_dir / "corpus" / "pages.jsonl"),
                "assets_jsonl": str(job_dir / "corpus" / "assets.jsonl"),
                "assets_dir": str(job_dir / "assets"),
                "mineru_raw_dir": str(job_dir / "mineru_raw"),
            },
        }
        if manifest_path.is_file():
            result["manifest"] = _read_json(manifest_path)
        if quality_path.is_file():
            result["quality"] = _read_json(quality_path)
        if include_samples:
            result["samples"] = _read_jsonl(job_dir / "corpus" / "chunks.jsonl", max_rows=sample_limit)
        return result

    def validate(self, job_id: str) -> dict[str, Any]:
        status = self.status(job_id)
        if not status.get("exists"):
            return {"ok": False, **status, "errors": ["job not found"], "warnings": []}
        job_dir = Path(str(status["job_dir"]))
        errors: list[str] = []
        warnings: list[str] = []
        manifest_path = job_dir / "manifest.json"
        chunks_path = job_dir / "corpus" / "chunks.jsonl"
        pages_path = job_dir / "corpus" / "pages.jsonl"
        assets_path = job_dir / "corpus" / "assets.jsonl"
        for path in (manifest_path, chunks_path, pages_path, assets_path):
            if not path.is_file():
                errors.append(f"missing artifact: {path}")
        chunks = _read_jsonl(chunks_path) if chunks_path.is_file() else []
        pages = _read_jsonl(pages_path) if pages_path.is_file() else []
        assets = _read_jsonl(assets_path) if assets_path.is_file() else []
        chunk_ids = [str(item.get("chunk_id") or "") for item in chunks]
        if len(chunk_ids) != len(set(chunk_ids)):
            errors.append("duplicate chunk_id values")
        if not chunks:
            errors.append("chunks.jsonl is empty")
        asset_ids = {str(item.get("asset_id") or "") for item in assets}
        for asset in assets:
            path_value = str(asset.get("path") or "")
            if not path_value.startswith("assets/"):
                errors.append(f"asset path must start with assets/: {path_value}")
                continue
            if ".." in Path(path_value).parts:
                errors.append(f"asset path contains traversal: {path_value}")
                continue
            if bool(asset.get("available")) and not (job_dir / path_value).is_file():
                errors.append(f"asset file missing: {path_value}")
        for chunk in chunks:
            refs = chunk.get("image_refs") or []
            if not isinstance(refs, list):
                errors.append(f"chunk image_refs is not a list: {chunk.get('chunk_id')}")
                continue
            for ref in refs:
                if not isinstance(ref, dict):
                    errors.append(f"chunk image_ref is not an object: {chunk.get('chunk_id')}")
                    continue
                ref_asset_id = str(ref.get("asset_id") or "")
                if ref_asset_id and ref_asset_id not in asset_ids:
                    errors.append(f"chunk references missing asset_id: {ref_asset_id}")
                ref_path = str(ref.get("path") or "")
                if ref_path and (ref_path.startswith("/") or ".." in Path(ref_path).parts):
                    errors.append(f"chunk has unsafe image path: {ref_path}")
        if status.get("status") != "succeeded":
            warnings.append(f"job status is {status.get('status')}, artifacts may be incomplete")
        return {
            "ok": not errors,
            "job_id": status["job_id"],
            "status": status.get("status"),
            "schema_version": SCHEMA_VERSION,
            "counts": {
                "chunks": len(chunks),
                "pages": len(pages),
                "assets": len(assets),
                "chunks_with_images": sum(1 for chunk in chunks if chunk.get("image_refs")),
            },
            "manifest_path": str(manifest_path),
            "errors": errors,
            "warnings": warnings,
        }

    def submit_batch(
        self,
        *,
        pdfs: list[Any],
        language: str = "ch",
        device: str = "cpu",
        formula_enabled: bool = False,
        table_enabled: bool = False,
        timeout_seconds: int = 3_600,
        cpu_threads: int | None = None,
        max_chars: int = 1_200,
        overlap_chars: int = 160,
        force_jobs: bool = False,
    ) -> dict[str, Any]:
        """Submit multiple PDFs as one managed batch.

        The batch layer only manages child jobs. Jobs use the service's bounded
        worker queue; its capacity is set by ``MED_RAG_MINERU_MAX_WORKERS``
        and defaults to one to protect shared CPU/GPU resources.
        """

        if not isinstance(pdfs, list) or not pdfs:
            raise ValueError("pdfs must be a non-empty list")
        defaults = {
            "language": language,
            "device": device,
            "formula_enabled": bool(formula_enabled),
            "table_enabled": bool(table_enabled),
            "timeout_seconds": int(timeout_seconds),
            "cpu_threads": cpu_threads or _default_cpu_threads(self.environment),
            "max_chars": int(max_chars),
            "overlap_chars": int(overlap_chars),
        }
        # Validate shared MinerU runtime only when this batch contains PDFs.
        # Text/doc/docx ingestion does not need MinerU and should remain usable
        # even when the OCR runtime is not configured.
        runtime: MinerURuntime | None = None
        if any(_batch_item_requires_mineru(raw_spec) for raw_spec in pdfs):
            runtime = MinerURuntime.from_environment(self.environment)
            runtime.validate()
        batch_payload = {
            "schema_version": BATCH_SCHEMA_VERSION,
            "documents": pdfs,
            "pdfs": pdfs,
            "defaults": defaults,
            "force_jobs": bool(force_jobs),
            "runtime": _runtime_payload(runtime),
        }
        batch_id = _batch_id(batch_payload)
        batch_dir = self._batch_dir(batch_id)
        self.output_root.mkdir(parents=True, exist_ok=True)
        batch_dir.mkdir(parents=True, exist_ok=False)

        items: list[dict[str, Any]] = []
        for index, raw_spec in enumerate(pdfs):
            try:
                request = _batch_item_request(raw_spec, defaults=defaults)
                status = self.submit(**request, force=force_jobs)
                items.append(
                    {
                        "index": index,
                        "source_path": request["pdf_path"],
                        "pdf_path": request["pdf_path"],
                        "input_type": _input_type(Path(request["pdf_path"])),
                        "book_id": request.get("book_id"),
                        "title": request.get("title"),
                        "volume": request.get("volume"),
                        "job_id": status.get("job_id"),
                        "job_dir": status.get("job_dir"),
                        "status": status.get("status"),
                        "phase": status.get("phase"),
                        "error": status.get("error"),
                    }
                )
            except Exception as exc:  # noqa: BLE001 - batch must isolate bad PDFs
                items.append(
                    {
                        "index": index,
                        "source_path": _raw_source_path(raw_spec),
                        "pdf_path": _raw_pdf_path(raw_spec),
                        "job_id": None,
                        "status": "submit_failed",
                        "phase": "submit_failed",
                        "error": f"{type(exc).__name__}: {exc}",
                    }
                )

        payload = {
            "batch_id": batch_id,
            "status": _batch_overall_status([item["status"] for item in items]),
            "phase": "submitted",
            "schema_version": BATCH_SCHEMA_VERSION,
            "created_at": _now(),
            "updated_at": _now(),
            "batch_dir": str(batch_dir),
            "request": {
                "document_count": len(pdfs),
                "pdf_count": len(pdfs),
                "defaults": defaults,
                "force_jobs": bool(force_jobs),
                "execution": "bounded_worker_queue",
                "max_workers": self.max_workers,
            },
            "items": items,
            "counts": _batch_counts(items),
        }
        _write_json(batch_dir / "batch.json", payload)
        return self.batch_status(batch_id)

    def batch_status(self, batch_id: str) -> dict[str, Any]:
        batch_id = _validate_batch_id(batch_id)
        batch_dir = self._batch_dir(batch_id)
        batch_path = batch_dir / "batch.json"
        if not batch_path.is_file():
            return {"exists": False, "batch_id": batch_id, "status": "not_found"}
        payload = _read_json(batch_path)
        refreshed_items: list[dict[str, Any]] = []
        for raw_item in payload.get("items", []):
            item = dict(raw_item) if isinstance(raw_item, Mapping) else {"status": "invalid_item"}
            job_id = item.get("job_id")
            if isinstance(job_id, str) and job_id:
                status = self.status(job_id)
                item.update(
                    {
                        "job_id": job_id,
                        "job_dir": status.get("job_dir", item.get("job_dir")),
                        "status": status.get("status"),
                        "phase": status.get("phase"),
                        "live": status.get("live"),
                    }
                )
                if status.get("error"):
                    item["error"] = status.get("error")
                if status.get("warning"):
                    item["warning"] = status.get("warning")
            refreshed_items.append(item)
        counts = _batch_counts(refreshed_items)
        status = _batch_overall_status([str(item.get("status") or "") for item in refreshed_items])
        return {
            **payload,
            "exists": True,
            "status": status,
            "phase": "complete" if status in {"succeeded", "failed", "partial_failed"} else "running",
            "updated_at": _now(),
            "items": refreshed_items,
            "counts": counts,
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
        job_results: list[dict[str, Any]] = []
        succeeded_job_ids: list[str] = []
        for item in status.get("items", []):
            job_id = item.get("job_id") if isinstance(item, Mapping) else None
            if not isinstance(job_id, str) or not job_id:
                job_results.append(dict(item) if isinstance(item, Mapping) else {"status": "invalid_item"})
                continue
            result = self.result(job_id, include_samples=include_samples, sample_limit=sample_limit)
            job_results.append(_compact_job_result(result))
            if result.get("status") == "succeeded":
                succeeded_job_ids.append(job_id)

        response: dict[str, Any] = {
            **status,
            "job_results": job_results,
        }
        if include_samples:
            response["samples"] = _batch_samples(job_results, sample_limit=sample_limit)

        if build_bundle:
            if status.get("status") == "succeeded" or (allow_partial and succeeded_job_ids):
                response["bundle"] = self._build_batch_bundle(
                    batch_id=str(status["batch_id"]),
                    status=status,
                    succeeded_job_ids=succeeded_job_ids,
                    partial=status.get("status") != "succeeded",
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
        warnings: list[str] = []
        job_validations: list[dict[str, Any]] = []
        for item in status.get("items", []):
            if not isinstance(item, Mapping):
                errors.append("invalid batch item")
                continue
            job_id = item.get("job_id")
            if not isinstance(job_id, str) or not job_id:
                errors.append(f"item {item.get('index')} has no job_id: {item.get('error')}")
                continue
            validation = self.validate(job_id)
            job_validations.append(validation)
            if not validation.get("ok"):
                errors.append(f"job {job_id} failed validation")
        bundle_root = self._batch_dir(str(status["batch_id"])) / "bundle"
        bundle_validation = _validate_artifact_bundle(bundle_root) if bundle_root.is_dir() else None
        if bundle_validation and not bundle_validation.get("ok"):
            errors.append("batch bundle failed validation")
        if status.get("status") not in {"succeeded", "partial_failed", "failed"}:
            warnings.append(f"batch status is {status.get('status')}, artifacts may be incomplete")
        if status.get("status") == "succeeded" and bundle_validation is None:
            warnings.append("batch is succeeded but merged bundle has not been built yet")
        return {
            "ok": not errors and status.get("status") == "succeeded",
            "batch_id": status["batch_id"],
            "status": status.get("status"),
            "schema_version": BATCH_SCHEMA_VERSION,
            "counts": status.get("counts"),
            "job_validations": job_validations,
            "bundle_validation": bundle_validation,
            "errors": errors,
            "warnings": warnings,
        }

    def run_sync(self, **kwargs: Any) -> dict[str, Any]:
        """Synchronous helper used by tests and command-line smoke checks."""

        start_page = kwargs.get("start_page")
        request = IngestRequest(
            pdf_path=str(kwargs["pdf_path"]),
            book_id=kwargs.get("book_id"),
            title=kwargs.get("title"),
            volume=kwargs.get("volume"),
            language=kwargs.get("language", "ch"),
            device=kwargs.get("device", "cpu"),
            start_page=start_page,
            end_page=kwargs.get("end_page"),
            page_index_offset=_resolve_page_index_offset(start_page, kwargs.get("page_index_offset")),
            formula_enabled=kwargs.get("formula_enabled", False),
            table_enabled=kwargs.get("table_enabled", False),
            timeout_seconds=kwargs.get("timeout_seconds", 3_600),
            cpu_threads=kwargs.get("cpu_threads") or _default_cpu_threads(self.environment),
            max_chars=kwargs.get("max_chars", 1_200),
            overlap_chars=kwargs.get("overlap_chars", 160),
        ).normalized()
        source = _validate_source(request.pdf_path)
        input_type = _input_type(source)
        runtime: MinerURuntime | None = None
        if input_type == "pdf":
            runtime = MinerURuntime.from_environment(self.environment)
            runtime.validate()
        source_sha256 = _sha256_file(source)
        payload = request.fingerprint_payload(source_sha256=source_sha256, input_type=input_type, runtime=runtime)
        job_id = _job_id(payload)
        job_dir = self._job_dir(job_id)
        self.output_root.mkdir(parents=True, exist_ok=True)
        job_dir.mkdir(parents=True, exist_ok=True)
        _write_json(
            job_dir / "job.json",
            {
                "job_id": job_id,
                "status": "queued",
                "phase": "queued",
                "schema_version": SCHEMA_VERSION,
                "created_at": _now(),
                "updated_at": _now(),
                "request": asdict(request),
                "runtime": _runtime_payload(runtime),
                "source": {"path": str(source), "file_name": source.name, "input_type": input_type, "sha256": source_sha256},
                "job_dir": str(job_dir),
            },
        )
        self._run_job(job_id, request, runtime, source_sha256)
        return self.result(job_id, include_samples=bool(kwargs.get("include_samples", False)))

    def _run_job(
        self,
        job_id: str,
        request: IngestRequest,
        runtime: MinerURuntime | None,
        source_sha256: str,
    ) -> None:
        job_dir = self._job_dir(job_id)
        try:
            source = Path(request.pdf_path)
            input_type = _input_type(source)
            if input_type != "pdf":
                self._run_text_job(
                    job_id=job_id,
                    request=request,
                    source=source,
                    source_sha256=source_sha256,
                    input_type=input_type,
                )
                return
            if runtime is None:
                raise MinerURuntimeConfigError("MinerU runtime is required for PDF input")
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
            mineru_result = run_mineru(invocation)
            (job_dir / "logs").mkdir(exist_ok=True)
            (job_dir / "logs" / "mineru.stdout.log").write_text(mineru_result.stdout or "", encoding="utf-8")
            (job_dir / "logs" / "mineru.stderr.log").write_text(mineru_result.stderr or "", encoding="utf-8")
            mineru_output = validate_mineru_output(invocation)

            self._update_job(job_id, status="running", phase="build_chunks")
            chunks = build_mineru_chunks(
                source_pdf=source,
                content_list_path=mineru_output.content_list_path,
                config=ChunkingConfig(max_chars=request.max_chars, overlap_chars=request.overlap_chars),
                page_index_offset=request.page_index_offset,
            )
            chunks = _apply_document_metadata(chunks, request=request, source=source, source_sha256=source_sha256)

            self._update_job(job_id, status="running", phase="copy_assets")
            bundle_root = job_dir
            chunks, assets, asset_warnings = _copy_assets_and_rewrite_refs(
                chunks=chunks,
                assets_root=bundle_root / "assets",
            )
            pages = _build_page_records(
                source_pdf=source,
                content_list_path=mineru_output.content_list_path,
                chunks=chunks,
                assets=assets,
                request=request,
            )
            document = _source_document_record(
                request=request,
                source=source,
                source_sha256=source_sha256,
                chunks=chunks,
                pages=pages,
                assets=assets,
            )

            self._update_job(job_id, status="running", phase="write_artifacts")
            corpus_dir = bundle_root / "corpus"
            corpus_dir.mkdir(parents=True, exist_ok=True)
            _write_jsonl(corpus_dir / "chunks.jsonl", chunks)
            _write_jsonl(corpus_dir / "assets.jsonl", assets)
            _write_jsonl(corpus_dir / "pages.jsonl", pages)
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
                "chunking": {
                    "max_chars": request.max_chars,
                    "overlap_chars": request.overlap_chars,
                    "page_index_offset": request.page_index_offset,
                },
                "mineru": {
                    "language": request.language,
                    "device": request.device,
                    "formula_enabled": request.formula_enabled,
                    "table_enabled": request.table_enabled,
                    "cpu_threads": request.cpu_threads,
                },
            }
            _write_json(bundle_root / "manifest.json", manifest)
            quality = _quality_report(chunks=chunks, pages=pages, assets=assets, warnings=asset_warnings)
            _write_json(bundle_root / "quality_report.json", quality)
            self._update_job(
                job_id,
                status="succeeded",
                phase="complete",
                result={
                    "manifest_path": str(bundle_root / "manifest.json"),
                    "quality_report_path": str(bundle_root / "quality_report.json"),
                    "chunk_count": len(chunks),
                    "page_count": len(pages),
                    "asset_count": len(assets),
                    "chunks_with_images": sum(1 for chunk in chunks if chunk.get("image_refs")),
                },
            )
        except Exception as exc:  # noqa: BLE001 - persisted failures are part of the service contract
            self._update_job(job_id, status="failed", phase="failed", error=f"{type(exc).__name__}: {exc}")
        finally:
            with _LOCK:
                _FUTURES.pop(job_id, None)
                _FUTURE_ROOTS.pop(job_id, None)

    def _run_text_job(
        self,
        *,
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
            source_sha256=source_sha256,
            text=extracted["text"],
            parser=extracted["parser"],
        )
        pages = _build_text_page_records(source=source, request=request, chunks=chunks, text=extracted["text"])
        assets: list[dict[str, Any]] = []
        document = _source_document_record(
            request=request,
            source=source,
            source_sha256=source_sha256,
            chunks=chunks,
            pages=pages,
            assets=assets,
        )

        self._update_job(job_id, status="running", phase="write_artifacts")
        bundle_root = self._job_dir(job_id)
        corpus_dir = bundle_root / "corpus"
        corpus_dir.mkdir(parents=True, exist_ok=True)
        _write_jsonl(corpus_dir / "chunks.jsonl", chunks)
        _write_jsonl(corpus_dir / "assets.jsonl", assets)
        _write_jsonl(corpus_dir / "pages.jsonl", pages)
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
            },
            "embedding": {
                "ready": False,
                "dimension": None,
                "embedding_path": None,
            },
            "chunking": {
                "max_chars": request.max_chars,
                "overlap_chars": request.overlap_chars,
                "page_index_offset": request.page_index_offset,
            },
            "parser": {
                "input_type": input_type,
                "name": extracted["parser"],
                "warnings": extracted["warnings"],
            },
            "mineru": {
                "used": False,
                "reason": "non_pdf_input",
            },
        }
        _write_json(bundle_root / "manifest.json", manifest)
        quality = _quality_report(chunks=chunks, pages=pages, assets=assets, warnings=extracted["warnings"])
        _write_json(bundle_root / "quality_report.json", quality)
        self._update_job(
            job_id,
            status="succeeded",
            phase="complete",
            result={
                "manifest_path": str(bundle_root / "manifest.json"),
                "quality_report_path": str(bundle_root / "quality_report.json"),
                "chunk_count": len(chunks),
                "page_count": len(pages),
                "asset_count": len(assets),
                "chunks_with_images": 0,
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
        batch_dir = self._batch_dir(batch_id)
        bundle_root = batch_dir / "bundle"
        chunks: list[dict[str, Any]] = []
        pages: list[dict[str, Any]] = []
        assets_by_id: dict[str, dict[str, Any]] = {}
        source_documents: list[dict[str, Any]] = []
        source_jobs: list[dict[str, Any]] = []
        warnings: list[str] = []

        for job_id in succeeded_job_ids:
            result = self.result(job_id, include_samples=False)
            if result.get("status") != "succeeded":
                warnings.append(f"skip non-succeeded job: {job_id}")
                continue
            job_dir = Path(str(result["job_dir"]))
            manifest = result.get("manifest") or _read_json(Path(str(result["manifest_path"])))
            if isinstance(manifest.get("source_documents"), list):
                source_documents.extend(dict(doc) for doc in manifest["source_documents"] if isinstance(doc, Mapping))
            source_jobs.append(
                {
                    "job_id": job_id,
                    "manifest_path": result.get("manifest_path"),
                    "quality_report_path": result.get("quality_report_path"),
                }
            )

            child_assets = _read_jsonl(Path(str(result["artifact_paths"]["assets_jsonl"])))
            asset_map: dict[str, dict[str, str]] = {}
            for asset in child_assets:
                old_asset_id = str(asset.get("asset_id") or "")
                old_path = str(asset.get("path") or "")
                source_file = job_dir / old_path
                doc_id = str(asset.get("doc_id") or _first_source_document_id(manifest) or job_id)
                if not old_asset_id or not old_path:
                    warnings.append(f"skip malformed asset in job {job_id}")
                    continue
                if not source_file.is_file():
                    warnings.append(f"missing asset file in job {job_id}: {old_path}")
                    continue
                digest = str(asset.get("sha256") or _sha256_file(source_file))
                suffix = source_file.suffix.lower() or ".bin"
                doc_slug = _slug(doc_id)
                new_relative_path = f"assets/{doc_slug}/{digest[:2]}/{digest}{suffix}"
                destination = bundle_root / new_relative_path
                destination.parent.mkdir(parents=True, exist_ok=True)
                if not destination.is_file():
                    shutil.copyfile(source_file, destination)
                new_asset_id = f"asset-{doc_slug[:64]}-{digest[:24]}"
                asset_map[old_asset_id] = {
                    "asset_id": new_asset_id,
                    "path": new_relative_path,
                }
                new_asset = dict(asset)
                new_asset.update(
                    {
                        "asset_id": new_asset_id,
                        "path": new_relative_path,
                        "available": True,
                        "sha256": digest,
                        "bytes": destination.stat().st_size,
                    }
                )
                existing = assets_by_id.get(new_asset_id)
                if existing is None:
                    linked = [
                        str(item)
                        for item in new_asset.get("linked_chunk_ids", [])
                        if str(item).strip()
                    ]
                    new_asset["linked_chunk_ids"] = linked
                    assets_by_id[new_asset_id] = new_asset
                else:
                    linked = set(str(item) for item in existing.get("linked_chunk_ids", []))
                    linked.update(str(item) for item in new_asset.get("linked_chunk_ids", []) if str(item).strip())
                    existing["linked_chunk_ids"] = sorted(linked)

            child_chunks = _read_jsonl(Path(str(result["artifact_paths"]["chunks_jsonl"])))
            for chunk in child_chunks:
                item = dict(chunk)
                rewritten_refs: list[dict[str, Any]] = []
                for ref in item.get("image_refs") or []:
                    if not isinstance(ref, Mapping):
                        continue
                    rewritten = dict(ref)
                    mapped = asset_map.get(str(ref.get("asset_id") or ""))
                    if mapped:
                        rewritten["asset_id"] = mapped["asset_id"]
                        rewritten["path"] = mapped["path"]
                        rewritten["available"] = True
                    elif rewritten.get("available"):
                        rewritten["available"] = False
                        warnings.append(f"chunk {item.get('chunk_id')} references missing batch asset")
                    rewritten_refs.append(rewritten)
                item["image_refs"] = rewritten_refs
                item["contents"] = _contextual_contents(
                    title=str(item.get("title") or ""),
                    chapter_path=str(item.get("chapter_path") or ""),
                    text=str(item.get("text") or ""),
                    image_refs=rewritten_refs,
                )
                chunks.append(item)

            child_pages = _read_jsonl(Path(str(result["artifact_paths"]["pages_jsonl"])))
            for page in child_pages:
                item = dict(page)
                rewritten_asset_ids = []
                for old_asset_id in item.get("asset_ids") or []:
                    mapped = asset_map.get(str(old_asset_id))
                    if mapped:
                        rewritten_asset_ids.append(mapped["asset_id"])
                item["asset_ids"] = rewritten_asset_ids
                pages.append(item)

        assets = list(assets_by_id.values())
        assets.sort(key=lambda asset: (asset.get("doc_id") or "", asset.get("page") or 0, asset.get("asset_id") or ""))
        corpus_dir = bundle_root / "corpus"
        corpus_dir.mkdir(parents=True, exist_ok=True)
        _write_jsonl(corpus_dir / "chunks.jsonl", chunks)
        _write_jsonl(corpus_dir / "pages.jsonl", pages)
        _write_jsonl(corpus_dir / "assets.jsonl", assets)
        manifest = {
            "schema_version": SCHEMA_VERSION,
            "corpus_id": batch_id,
            "name": f"MinerU batch {batch_id}",
            "version": batch_id,
            "created_at": _now(),
            "source_documents": source_documents,
            "source_jobs": source_jobs,
            "batch": {
                "batch_id": batch_id,
                "status": status.get("status"),
                "partial": bool(partial),
                "counts": status.get("counts"),
            },
            "artifacts": {
                "chunks_path": "corpus/chunks.jsonl",
                "pages_path": "corpus/pages.jsonl",
                "assets_path": "corpus/assets.jsonl",
                "assets_dir": "assets",
            },
            "embedding": {
                "ready": False,
                "dimension": None,
                "embedding_path": None,
            },
        }
        _write_json(bundle_root / "manifest.json", manifest)
        if partial:
            warnings.append("partial batch bundle built from succeeded jobs only")
        quality = _quality_report(chunks=chunks, pages=pages, assets=assets, warnings=warnings)
        _write_json(bundle_root / "quality_report.json", quality)
        validation = _validate_artifact_bundle(bundle_root)
        return {
            "built": True,
            "partial": bool(partial),
            "bundle_dir": str(bundle_root),
            "manifest_path": str(bundle_root / "manifest.json"),
            "quality_report_path": str(bundle_root / "quality_report.json"),
            "artifact_paths": {
                "chunks_jsonl": str(corpus_dir / "chunks.jsonl"),
                "pages_jsonl": str(corpus_dir / "pages.jsonl"),
                "assets_jsonl": str(corpus_dir / "assets.jsonl"),
                "assets_dir": str(bundle_root / "assets"),
            },
            "counts": {
                "chunks": len(chunks),
                "pages": len(pages),
                "assets": len(assets),
                "source_documents": len(source_documents),
            },
            "validation": validation,
        }

    def _update_job(
        self,
        job_id: str,
        *,
        status: str,
        phase: str,
        result: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> None:
        job_path = self._job_dir(job_id) / "job.json"
        payload = _read_json(job_path)
        payload["status"] = status
        payload["phase"] = phase
        payload["updated_at"] = _now()
        if result is not None:
            payload["result"] = result
        if error is not None:
            payload["error"] = error[:4_000]
        _write_json(job_path, payload)

    def _job_dir(self, job_id: str) -> Path:
        return self.output_root / "jobs" / _validate_job_id(job_id)

    def _batch_dir(self, batch_id: str) -> Path:
        return self.output_root / "batches" / _validate_batch_id(batch_id)


def _validate_source(path_value: str) -> Path:
    path = Path(path_value).expanduser().resolve()
    if not path.is_file():
        raise FileNotFoundError(f"source document does not exist: {path}")
    suffix = path.suffix.lower()
    if suffix not in SUPPORTED_INPUT_SUFFIXES:
        if _try_decode_text(path)[0].strip():
            return path
        raise ValueError(
            f"unsupported input type: {suffix or '(no suffix)'}; supported: {', '.join(SUPPORTED_INPUT_SUFFIXES)}"
        )
    return path


def _validate_pdf(path_value: str) -> Path:
    path = _validate_source(path_value)
    if path.suffix.lower() != ".pdf":
        raise ValueError(f"only PDF input is supported: {path}")
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
        text = _extract_docx_text(source, warnings)
        parser = "docx_ooxml_text"
    elif suffix in LEGACY_DOC_SUFFIXES:
        text = _extract_legacy_doc_text(source, warnings)
        parser = "legacy_doc_text"
    else:
        text, encoding = _try_decode_text(source)
        parser = f"text_decode_{encoding}"
        if suffix not in TEXT_SUFFIXES:
            warnings.append(f"unknown suffix {suffix or '(none)'} decoded as text")
        if suffix in {".html", ".htm"}:
            text = _strip_html(text)
            parser = f"html_text_decode_{encoding}"
    text = _normalize_document_text(text)
    if not text:
        raise ValueError(f"no extractable text from {source}")
    return {"text": text, "parser": parser, "warnings": warnings}


def _extract_docx_text(source: Path, warnings: list[str]) -> str:
    try:
        with zipfile.ZipFile(source) as archive:
            xml_bytes = archive.read("word/document.xml")
    except KeyError as exc:
        raise ValueError(f"docx document.xml is missing: {source}") from exc
    except zipfile.BadZipFile as exc:
        raise ValueError(f"invalid docx zip container: {source}") from exc

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
        text = "".join(parts).strip()
        if text:
            paragraphs.append(text)
    if not paragraphs:
        warnings.append("docx contains no paragraph text")
    return "\n\n".join(paragraphs)


def _extract_legacy_doc_text(source: Path, warnings: list[str]) -> str:
    converted = _try_external_doc_converter(source, warnings)
    if converted.strip():
        return converted
    warnings.append(
        "legacy .doc parsed with low-confidence binary text extraction; install antiword/catdoc/wvText for better quality"
    )
    data = source.read_bytes()
    candidates = [
        data.decode("utf-16le", errors="ignore"),
        data.decode("gb18030", errors="ignore"),
        data.decode("latin1", errors="ignore"),
    ]
    joined = "\n".join(_printable_runs(candidate) for candidate in candidates)
    return joined


def _try_external_doc_converter(source: Path, warnings: list[str]) -> str:
    commands = (
        ("antiword", str(source)),
        ("catdoc", str(source)),
        ("wvText", str(source), "-"),
    )
    for command in commands:
        if shutil.which(command[0]) is None:
            continue
        try:
            completed = subprocess.run(
                command,
                check=False,
                capture_output=True,
                text=True,
                timeout=120,
            )
        except Exception as exc:  # noqa: BLE001 - converter fallback should keep trying
            warnings.append(f"{command[0]} failed to start: {type(exc).__name__}: {exc}")
            continue
        if completed.returncode == 0 and completed.stdout.strip():
            warnings.append(f"legacy .doc converted with {command[0]}")
            return completed.stdout
        if completed.stderr.strip():
            warnings.append(f"{command[0]} stderr: {completed.stderr.strip()[:300]}")
    return ""


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
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    return html.unescape(text)


def _printable_runs(text: str) -> str:
    allowed = re.findall(r"[\u4e00-\u9fffA-Za-z0-9，。；：、！？（）《》〈〉【】“”‘’.,;:!?()\\[\\]{}<>/%+\\-=\\s]{4,}", text)
    return "\n".join(part.strip() for part in allowed if part.strip())


def _normalize_document_text(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t\f\v]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _xml_local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _build_text_chunks(
    *,
    source: Path,
    request: IngestRequest,
    source_sha256: str,
    text: str,
    parser: str,
) -> list[dict[str, Any]]:
    doc_id = _document_id(source, request)
    title = request.title or source.stem
    chunks: list[dict[str, Any]] = []
    for index, chunk_text in enumerate(
        _split_text_for_chunks(text, max_chars=request.max_chars, overlap_chars=request.overlap_chars)
    ):
        item = {
            "chunk_id": f"{doc_id}-{index:04d}-000",
            "doc_id": doc_id,
            "title": title,
            "volume": request.volume or "",
            "chapter_path": "",
            "content_type": "text",
            "text": chunk_text,
            "content": chunk_text,
            "page_start": 1,
            "page_end": 1,
            "image_refs": [],
            "source_file": str(source),
            "source_sha256": source_sha256,
            "parser": parser,
        }
        item["contents"] = _contextual_contents(title=title, chapter_path="", text=chunk_text, image_refs=[])
        chunks.append(item)
    return chunks


def _split_text_for_chunks(text: str, *, max_chars: int, overlap_chars: int) -> list[str]:
    config = ChunkingConfig(max_chars=max_chars, overlap_chars=overlap_chars)
    paragraphs = [part.strip() for part in re.split(r"\n{2,}", text) if part.strip()]
    if not paragraphs:
        paragraphs = [text.strip()]
    chunks: list[str] = []
    current = ""
    for paragraph in paragraphs:
        if len(paragraph) > config.max_chars:
            if current:
                chunks.append(current.strip())
                current = _chunk_overlap(current, config.overlap_chars)
            for piece in _split_long_paragraph(paragraph, config.max_chars, config.overlap_chars):
                if piece:
                    chunks.append(piece)
            current = _chunk_overlap(chunks[-1], config.overlap_chars) if chunks else ""
            continue
        candidate = f"{current}\n\n{paragraph}".strip() if current else paragraph
        if len(candidate) <= config.max_chars:
            current = candidate
            continue
        if current:
            chunks.append(current.strip())
        overlap = _chunk_overlap(current, config.overlap_chars)
        current = f"{overlap}\n\n{paragraph}".strip() if overlap else paragraph
    if current.strip():
        chunks.append(current.strip())
    return chunks


def _split_long_paragraph(text: str, max_chars: int, overlap_chars: int) -> list[str]:
    chunks: list[str] = []
    start = 0
    step_back = min(max(overlap_chars, 0), max_chars - 1)
    while start < len(text):
        end = min(len(text), start + max_chars)
        chunks.append(text[start:end].strip())
        if end >= len(text):
            break
        start = max(end - step_back, start + 1)
    return chunks


def _chunk_overlap(text: str, overlap_chars: int) -> str:
    if overlap_chars <= 0:
        return ""
    return text[-overlap_chars:].strip()


def _build_text_page_records(
    *,
    source: Path,
    request: IngestRequest,
    chunks: list[dict[str, Any]],
    text: str,
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
            "chunk_ids": [str(chunk.get("chunk_id") or "") for chunk in chunks],
            "asset_ids": [],
        }
    ]


def _resolve_page_index_offset(start_page: int | None, page_index_offset: int | None) -> int:
    """Keep partial-page MinerU outputs aligned to original PDF page numbers.

    MinerU restarts ``page_idx`` from zero when ``-s/-e`` parse only a slice of
    the PDF.  For handoff artifacts and RAG source citations, callers almost
    always want original physical PDF pages, so an omitted offset means
    ``start_page``.  A caller may still pass an explicit offset to remap pages.
    """

    if page_index_offset is None:
        return int(start_page) if start_page is not None else 0
    return int(page_index_offset)


def _source_document_record(
    *,
    request: IngestRequest,
    source: Path,
    source_sha256: str,
    chunks: list[dict[str, Any]],
    pages: list[dict[str, Any]],
    assets: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "document_id": chunks[0]["doc_id"] if chunks else _document_id(source, request),
        "title": request.title or source.stem,
        "volume": request.volume or "",
        "source_path": str(source),
        "source_file_name": source.name,
        "input_type": _input_type(source),
        "source_sha256": source_sha256,
        "page_start": min((int(page["page"]) for page in pages), default=None),
        "page_end": max((int(page["page"]) for page in pages), default=None),
        "chunk_count": len(chunks),
        "asset_count": len(assets),
    }


def _apply_document_metadata(
    chunks: list[dict[str, Any]],
    *,
    request: IngestRequest,
    source: Path,
    source_sha256: str,
) -> list[dict[str, Any]]:
    doc_id = _document_id(source, request)
    result: list[dict[str, Any]] = []
    for chunk in chunks:
        item = dict(chunk)
        suffix = "-".join(str(item.get("chunk_id") or "").split("-")[-2:])
        if not re.fullmatch(r"\d{4}-\d{3}", suffix):
            suffix = f"{len(result):04d}-000"
        item["chunk_id"] = f"{doc_id}-{suffix}"
        item["doc_id"] = doc_id
        item["title"] = request.title or source.stem
        if request.volume:
            item["volume"] = request.volume
        else:
            item.setdefault("volume", "")
        item["source_file"] = str(source)
        item["source_sha256"] = source_sha256
        item["contents"] = _contextual_contents(
            title=str(item["title"]),
            chapter_path=str(item.get("chapter_path") or ""),
            text=str(item.get("text") or ""),
            image_refs=item.get("image_refs") if isinstance(item.get("image_refs"), list) else [],
        )
        result.append(item)
    return result


def _copy_assets_and_rewrite_refs(
    *,
    chunks: list[dict[str, Any]],
    assets_root: Path,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str]]:
    copied: dict[Path, dict[str, Any]] = {}
    assets_by_id: dict[str, dict[str, Any]] = {}
    warnings: list[str] = []
    rewritten_chunks: list[dict[str, Any]] = []
    for chunk in chunks:
        item = dict(chunk)
        refs = item.get("image_refs")
        rewritten_refs: list[dict[str, Any]] = []
        if not isinstance(refs, list):
            item["image_refs"] = []
            rewritten_chunks.append(item)
            continue
        for ref_index, raw_ref in enumerate(refs):
            if not isinstance(raw_ref, Mapping):
                continue
            ref = dict(raw_ref)
            source_value = str(ref.pop("source_path", "") or "").strip()
            source = Path(source_value).expanduser().resolve() if source_value else None
            base_ref = {
                "caption": str(ref.get("caption") or "")[:1_000],
                "page": _optional_positive_int(ref.get("page")),
                "relation": str(ref.get("relation") or "same_page")[:50],
            }
            if source is None or not source.is_file():
                warning = f"missing image asset for chunk {item.get('chunk_id')} ref {ref_index}"
                warnings.append(warning)
                base_ref.update(
                    {
                        "asset_id": "",
                        "asset_type": "figure",
                        "path": str(ref.get("path") or "")[:2_000],
                        "available": False,
                    }
                )
                rewritten_refs.append(base_ref)
                continue
            existing = copied.get(source)
            if existing is None:
                digest = _sha256_file(source)
                suffix = source.suffix.lower() or ".bin"
                destination = assets_root / digest[:2] / f"{digest}{suffix}"
                destination.parent.mkdir(parents=True, exist_ok=True)
                if not destination.is_file():
                    shutil.copyfile(source, destination)
                asset_id = f"asset-{digest[:24]}"
                relative_path = destination.relative_to(assets_root.parent).as_posix()
                existing = {
                    "asset_id": asset_id,
                    "asset_type": "figure",
                    "path": relative_path,
                    "available": True,
                    "sha256": digest,
                    "bytes": destination.stat().st_size,
                }
                copied[source] = existing
            asset = {
                **existing,
                "doc_id": str(item.get("doc_id") or ""),
                "page": base_ref["page"],
                "caption": base_ref["caption"],
                "figure_no": _figure_no(base_ref["caption"]),
                "linked_chunk_ids": [],
            }
            assets_by_id.setdefault(asset["asset_id"], asset)
            assets_by_id[asset["asset_id"]]["linked_chunk_ids"].append(str(item.get("chunk_id") or ""))
            rewritten_refs.append(
                {
                    **base_ref,
                    "asset_id": asset["asset_id"],
                    "asset_type": asset["asset_type"],
                    "path": asset["path"],
                    "available": True,
                    "figure_no": asset["figure_no"],
                }
            )
        item["image_refs"] = rewritten_refs
        item["contents"] = _contextual_contents(
            title=str(item.get("title") or ""),
            chapter_path=str(item.get("chapter_path") or ""),
            text=str(item.get("text") or ""),
            image_refs=rewritten_refs,
        )
        rewritten_chunks.append(item)
    assets = list(assets_by_id.values())
    assets.sort(key=lambda asset: (asset.get("doc_id") or "", asset.get("page") or 0, asset.get("asset_id") or ""))
    return rewritten_chunks, assets, warnings


def _build_page_records(
    *,
    source_pdf: Path,
    content_list_path: Path,
    chunks: list[dict[str, Any]],
    assets: list[dict[str, Any]],
    request: IngestRequest,
) -> list[dict[str, Any]]:
    raw = json.loads(content_list_path.read_text(encoding="utf-8"))
    text_by_page: dict[int, list[str]] = {}
    if isinstance(raw, list):
        for block in raw:
            if not isinstance(block, Mapping) or block.get("type") != "text":
                continue
            text = _normalize_text(str(block.get("text") or ""))
            if not text:
                continue
            page = int(block.get("page_idx", 0)) + 1 + request.page_index_offset
            text_by_page.setdefault(page, []).append(text)
    chunks_by_page: dict[int, list[str]] = {}
    for chunk in chunks:
        page_start = _optional_positive_int(chunk.get("page_start")) or 1
        page_end = _optional_positive_int(chunk.get("page_end")) or page_start
        for page in range(page_start, page_end + 1):
            chunks_by_page.setdefault(page, []).append(str(chunk.get("chunk_id") or ""))
    assets_by_page: dict[int, list[str]] = {}
    for asset in assets:
        page = _optional_positive_int(asset.get("page"))
        if page is None:
            continue
        assets_by_page.setdefault(page, []).append(str(asset.get("asset_id") or ""))
    pages = sorted(set(text_by_page) | set(chunks_by_page) | set(assets_by_page))
    doc_id = _document_id(source_pdf, request)
    return [
        {
            "page_id": f"{doc_id}-p{page:04d}",
            "doc_id": doc_id,
            "title": request.title or source_pdf.stem,
            "volume": request.volume or "",
            "page": page,
            "text": "\n".join(text_by_page.get(page, [])),
            "chunk_ids": chunks_by_page.get(page, []),
            "asset_ids": assets_by_page.get(page, []),
        }
        for page in pages
    ]


def _quality_report(
    *,
    chunks: list[dict[str, Any]],
    pages: list[dict[str, Any]],
    assets: list[dict[str, Any]],
    warnings: list[str],
) -> dict[str, Any]:
    text_lengths = [len(str(chunk.get("text") or "")) for chunk in chunks]
    empty_caption_count = sum(1 for asset in assets if not str(asset.get("caption") or "").strip())
    chunks_by_content_type: dict[str, int] = {}
    for chunk in chunks:
        content_type = str(chunk.get("content_type") or "unknown")
        chunks_by_content_type[content_type] = chunks_by_content_type.get(content_type, 0) + 1
    page_numbers = [_optional_positive_int(page.get("page")) for page in pages]
    page_numbers = [page for page in page_numbers if page is not None]
    available_assets = sum(1 for asset in assets if bool(asset.get("available")))
    return {
        "schema_version": SCHEMA_VERSION,
        "created_at": _now(),
        "counts": {
            "chunks": len(chunks),
            "pages": len(pages),
            "assets": len(assets),
            "chunks_with_images": sum(1 for chunk in chunks if chunk.get("image_refs")),
            "empty_caption_assets": empty_caption_count,
            "captioned_assets": len(assets) - empty_caption_count,
            "available_assets": available_assets,
            "unavailable_assets": len(assets) - available_assets,
            "pages_with_text": sum(1 for page in pages if str(page.get("text") or "").strip()),
            "pages_with_assets": sum(1 for page in pages if page.get("asset_ids")),
        },
        "pages": {
            "min_page": min(page_numbers, default=None),
            "max_page": max(page_numbers, default=None),
        },
        "chunks_by_content_type": chunks_by_content_type,
        "text": {
            "min_chars": min(text_lengths, default=0),
            "max_chars": max(text_lengths, default=0),
            "avg_chars": round(sum(text_lengths) / len(text_lengths), 2) if text_lengths else 0.0,
        },
        "reliability": {
            "parse_quality": "medium" if empty_caption_count else "high",
            "structure_reliable": empty_caption_count == 0,
            "reason": "empty image captions detected" if empty_caption_count else "basic artifact checks passed",
        },
        "warnings": warnings,
    }


def _document_id(source: Path, request: IngestRequest) -> str:
    if request.book_id:
        return _slug(request.book_id)
    digest = hashlib.sha256(str(source.resolve()).encode("utf-8")).hexdigest()[:12]
    return f"mineru-{_slug(source.stem)}-{digest}"


def _contextual_contents(
    *,
    title: str,
    chapter_path: str,
    text: str,
    image_refs: list[dict[str, Any]],
) -> str:
    context = f"书名：{title}"
    if chapter_path:
        context += f"\n章节：{chapter_path}"
    captions = []
    seen = set()
    for ref in image_refs:
        caption = _normalize_text(str(ref.get("caption") or ""))
        if caption and caption not in seen:
            seen.add(caption)
            captions.append(caption)
    if captions:
        context += "\n相关图示：" + "；".join(captions)
    return f"{context}\n\n{text}"


def _figure_no(caption: str) -> str:
    match = re.search(r"(图|Fig(?:ure)?\.?)\s*([0-9０-９一二三四五六七八九十百.-]+)", caption, flags=re.I)
    if not match:
        return ""
    return f"{match.group(1)}{match.group(2)}"


def _slug(value: str) -> str:
    cleaned = re.sub(r"\s+", "-", value.strip())
    cleaned = re.sub(r"[^\w\u4e00-\u9fff.-]+", "-", cleaned)
    cleaned = cleaned.strip(".-_")
    return cleaned[:120] or "document"


def _job_id(payload: Mapping[str, Any]) -> str:
    digest = hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
    return f"job-{digest[:24]}"


def _validate_job_id(job_id: str) -> str:
    value = (job_id or "").strip()
    if not re.fullmatch(r"job-[a-f0-9]{24}(?:-\d{10})?", value):
        raise ValueError("invalid job_id")
    return value


def _batch_id(payload: Mapping[str, Any]) -> str:
    digest = hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
    return f"batch-{digest[:24]}-{time.time_ns()}"


def _validate_batch_id(batch_id: str) -> str:
    value = (batch_id or "").strip()
    if not re.fullmatch(r"batch-[a-f0-9]{24}-\d{10,20}", value):
        raise ValueError("invalid batch_id")
    return value


def _raw_pdf_path(raw_spec: Any) -> str:
    return _raw_source_path(raw_spec)


def _raw_source_path(raw_spec: Any) -> str:
    if isinstance(raw_spec, Mapping):
        return str(raw_spec.get("source_path") or raw_spec.get("pdf_path") or raw_spec.get("path") or "")
    return str(raw_spec or "")


def _batch_item_requires_mineru(raw_spec: Any) -> bool:
    source_path = _raw_source_path(raw_spec).strip()
    return Path(source_path).suffix.lower() == ".pdf"


def _batch_item_request(raw_spec: Any, *, defaults: Mapping[str, Any]) -> dict[str, Any]:
    if isinstance(raw_spec, str):
        spec: Mapping[str, Any] = {"pdf_path": raw_spec}
    elif isinstance(raw_spec, Mapping):
        spec = raw_spec
    else:
        raise ValueError("each document item must be a path string or object")
    pdf_path = str(spec.get("source_path") or spec.get("pdf_path") or spec.get("path") or "").strip()
    if not pdf_path:
        raise ValueError("source_path is required for each document item")
    start_page = spec.get("start_page")
    page_index_offset = spec.get("page_index_offset")
    return {
        "pdf_path": pdf_path,
        "book_id": _clean_optional(spec.get("book_id") if spec.get("book_id") is not None else None),
        "title": _clean_optional(spec.get("title") if spec.get("title") is not None else None),
        "volume": _clean_optional(spec.get("volume") if spec.get("volume") is not None else None),
        "language": spec.get("language", defaults["language"]),
        "device": spec.get("device", defaults["device"]),
        "start_page": start_page,
        "end_page": spec.get("end_page"),
        "page_index_offset": _resolve_page_index_offset(start_page, page_index_offset),
        "formula_enabled": spec.get("formula_enabled", defaults["formula_enabled"]),
        "table_enabled": spec.get("table_enabled", defaults["table_enabled"]),
        "timeout_seconds": spec.get("timeout_seconds", defaults["timeout_seconds"]),
        "cpu_threads": spec.get("cpu_threads", defaults["cpu_threads"]),
        "max_chars": spec.get("max_chars", defaults["max_chars"]),
        "overlap_chars": spec.get("overlap_chars", defaults["overlap_chars"]),
    }


def _batch_counts(items: list[dict[str, Any]]) -> dict[str, int]:
    counts = {
        "total": len(items),
        "queued": 0,
        "running": 0,
        "succeeded": 0,
        "failed": 0,
        "not_found": 0,
    }
    for item in items:
        status = str(item.get("status") or "")
        if status == "queued":
            counts["queued"] += 1
        elif status == "running":
            counts["running"] += 1
        elif status == "succeeded":
            counts["succeeded"] += 1
        elif status in {"failed", "submit_failed", "invalid_item"}:
            counts["failed"] += 1
        elif status == "not_found":
            counts["not_found"] += 1
            counts["failed"] += 1
    counts["pending"] = counts["queued"] + counts["running"]
    counts["terminal"] = counts["succeeded"] + counts["failed"]
    return counts


def _batch_overall_status(statuses: list[str]) -> str:
    if not statuses:
        return "failed"
    normalized = [str(status or "") for status in statuses]
    if any(status in {"queued", "running"} for status in normalized):
        return "running"
    failed = sum(1 for status in normalized if status in {"failed", "submit_failed", "not_found", "invalid_item"})
    succeeded = sum(1 for status in normalized if status == "succeeded")
    if failed and succeeded:
        return "partial_failed"
    if failed:
        return "failed"
    if succeeded == len(normalized):
        return "succeeded"
    return "failed"


def _compact_job_result(result: Mapping[str, Any]) -> dict[str, Any]:
    payload = {
        "job_id": result.get("job_id"),
        "status": result.get("status"),
        "phase": result.get("phase"),
        "job_dir": result.get("job_dir"),
        "manifest_path": result.get("manifest_path"),
        "quality_report_path": result.get("quality_report_path"),
        "artifact_paths": result.get("artifact_paths"),
        "result": result.get("result"),
        "quality": result.get("quality"),
    }
    if result.get("error"):
        payload["error"] = result.get("error")
    if result.get("samples"):
        payload["samples"] = result.get("samples")
    return payload


def _batch_samples(job_results: list[dict[str, Any]], *, sample_limit: int) -> list[dict[str, Any]]:
    samples: list[dict[str, Any]] = []
    for result in job_results:
        for sample in result.get("samples") or []:
            if isinstance(sample, Mapping):
                item = dict(sample)
                item.setdefault("job_id", result.get("job_id"))
                samples.append(item)
                if len(samples) >= sample_limit:
                    return samples
    return samples


def _first_source_document_id(manifest: Mapping[str, Any]) -> str:
    docs = manifest.get("source_documents")
    if isinstance(docs, list):
        for doc in docs:
            if isinstance(doc, Mapping) and doc.get("document_id"):
                return str(doc["document_id"])
    return ""


def _validate_artifact_bundle(root: Path) -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []
    manifest_path = root / "manifest.json"
    chunks_path = root / "corpus" / "chunks.jsonl"
    pages_path = root / "corpus" / "pages.jsonl"
    assets_path = root / "corpus" / "assets.jsonl"
    for path in (manifest_path, chunks_path, pages_path, assets_path):
        if not path.is_file():
            errors.append(f"missing artifact: {path}")
    chunks = _read_jsonl(chunks_path) if chunks_path.is_file() else []
    pages = _read_jsonl(pages_path) if pages_path.is_file() else []
    assets = _read_jsonl(assets_path) if assets_path.is_file() else []
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
    asset_id_set = set(asset_ids)
    for asset in assets:
        path_value = str(asset.get("path") or "")
        if not path_value.startswith("assets/"):
            errors.append(f"asset path must start with assets/: {path_value}")
            continue
        if ".." in Path(path_value).parts or Path(path_value).is_absolute():
            errors.append(f"unsafe asset path: {path_value}")
            continue
        if bool(asset.get("available")) and not (root / path_value).is_file():
            errors.append(f"asset file missing: {path_value}")
    for chunk in chunks:
        refs = chunk.get("image_refs") or []
        if not isinstance(refs, list):
            errors.append(f"chunk image_refs is not a list: {chunk.get('chunk_id')}")
            continue
        for ref in refs:
            if not isinstance(ref, Mapping):
                errors.append(f"chunk image_ref is not an object: {chunk.get('chunk_id')}")
                continue
            ref_asset_id = str(ref.get("asset_id") or "")
            if ref_asset_id and ref_asset_id not in asset_id_set:
                errors.append(f"chunk references missing asset_id: {ref_asset_id}")
            ref_path = str(ref.get("path") or "")
            if ref_path and (Path(ref_path).is_absolute() or ".." in Path(ref_path).parts):
                errors.append(f"chunk has unsafe image path: {ref_path}")
    for page in pages:
        for asset_id in page.get("asset_ids") or []:
            if str(asset_id) not in asset_id_set:
                errors.append(f"page references missing asset_id: {asset_id}")
    if not assets:
        warnings.append("assets.jsonl is empty")
    return {
        "ok": not errors,
        "schema_version": SCHEMA_VERSION,
        "manifest_path": str(manifest_path),
        "counts": {
            "chunks": len(chunks),
            "pages": len(pages),
            "assets": len(assets),
            "chunks_with_images": sum(1 for chunk in chunks if chunk.get("image_refs")),
        },
        "errors": errors,
        "warnings": warnings,
    }


def _clean_optional(value: str | None) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _optional_non_negative(value: int | None, name: str) -> int | None:
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
        return 8
    return max(1, min(value, 64))


def _max_workers(environment: Mapping[str, str]) -> int:
    """Read the bounded document-job concurrency for either MCP transport."""

    raw = str(environment.get(MAX_WORKERS_ENV, "")).strip() or "1"
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"{MAX_WORKERS_ENV} must be an integer between 1 and 8") from exc
    if not 1 <= value <= 8:
        raise ValueError(f"{MAX_WORKERS_ENV} must be between 1 and 8")
    return value


def _normalize_text(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


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
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
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
