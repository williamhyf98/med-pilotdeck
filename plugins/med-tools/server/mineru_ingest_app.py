"""Independent stdio MCP entrypoint for MinerU document ingestion."""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from typing import Any, Callable, Optional

from mcp.server.fastmcp import FastMCP

from .mineru_ingest import MinerUIngestService
from .mineru_paths import sanitize_mineru_payload
from .mineru_remote_client import RemoteMinerUIngestService


mcp = FastMCP(
    "mineru-ingest-tools",
    instructions=(
        "Ingest authorized user documents into normalized MinerU artifacts. "
        "PDF files use the externally configured MinerU runtime; DOC, DOCX and "
        "text files use lightweight extraction. This service is asynchronous, "
        "user-scoped, and does not generate embeddings or perform retrieval."
    ),
)


def _service() -> MinerUIngestService:
    if os.environ.get("MED_RAG_MINERU_REMOTE_MODE", "local").strip().lower() == "remote":
        return RemoteMinerUIngestService()
    return MinerUIngestService()


def _json(payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=False, indent=2)


def _public_payload(service: MinerUIngestService, payload: Any) -> Any:
    environment = getattr(service, "environment", None)
    if not isinstance(environment, Mapping):
        environment = None
    return sanitize_mineru_payload(payload, environment)


def _call(service: MinerUIngestService, action: Callable[[], Any]) -> str:
    try:
        payload = action()
    except Exception as exc:
        payload = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    return _json(_public_payload(service, payload))


@mcp.tool()
def mineru_ingest_health() -> str:
    """Check ingestion configuration and worker readiness."""

    service = _service()
    return _call(service, service.health)


@mcp.tool()
def mineru_ingest_submit(
    source_path: str = "",
    pdf_path: str = "",
    book_id: Optional[str] = None,
    title: Optional[str] = None,
    volume: Optional[str] = None,
    language: str = "ch",
    device: str = "cpu",
    start_page: Optional[int] = None,
    end_page: Optional[int] = None,
    page_index_offset: Optional[int] = None,
    formula_enabled: bool = False,
    table_enabled: bool = False,
    timeout_seconds: int = 3600,
    cpu_threads: Optional[int] = None,
    max_chars: int = 1200,
    overlap_chars: int = 160,
    force: bool = False,
) -> str:
    """Submit one user-scoped document ingestion job."""

    path = source_path.strip() or pdf_path.strip()
    if not path:
        raise ValueError("source_path is required")
    service = _service()
    return _call(
        service,
        lambda: service.submit(
            pdf_path=path,
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
            force=force,
        ),
    )


@mcp.tool()
def mineru_ingest_status(job_id: str) -> str:
    """Return persisted status for one ingestion job."""

    service = _service()
    return _call(service, lambda: service.status(job_id))


@mcp.tool()
def mineru_ingest_result(
    job_id: str, include_samples: bool = False, sample_limit: int = 3
) -> str:
    """Return artifact metadata and optional small chunk samples."""

    service = _service()
    return _call(
        service,
        lambda: service.result(
            job_id, include_samples=include_samples, sample_limit=sample_limit
        ),
    )


@mcp.tool()
def mineru_ingest_validate(job_id: str) -> str:
    """Validate the normalized artifacts for one job."""

    service = _service()
    return _call(service, lambda: service.validate(job_id))


@mcp.tool()
def mineru_ingest_batch_submit(
    documents: Optional[list[Any]] = None,
    pdfs: Optional[list[Any]] = None,
    language: str = "ch",
    device: str = "cpu",
    formula_enabled: bool = False,
    table_enabled: bool = False,
    timeout_seconds: int = 3600,
    cpu_threads: Optional[int] = None,
    max_chars: int = 1200,
    overlap_chars: int = 160,
    force_jobs: bool = False,
) -> str:
    """Submit multiple documents, isolating failures per document."""

    resolved = documents if documents is not None else pdfs
    if resolved is None:
        raise ValueError("documents is required")
    service = _service()
    return _call(
        service,
        lambda: service.submit_batch(
            documents=resolved,
            language=language,
            device=device,
            formula_enabled=formula_enabled,
            table_enabled=table_enabled,
            timeout_seconds=timeout_seconds,
            cpu_threads=cpu_threads,
            max_chars=max_chars,
            overlap_chars=overlap_chars,
            force_jobs=force_jobs,
        ),
    )


@mcp.tool()
def mineru_ingest_batch_status(batch_id: str) -> str:
    """Return aggregate status for a batch."""

    service = _service()
    return _call(service, lambda: service.batch_status(batch_id))


@mcp.tool()
def mineru_ingest_batch_result(
    batch_id: str,
    include_samples: bool = False,
    sample_limit: int = 3,
    build_bundle: bool = True,
    allow_partial: bool = False,
) -> str:
    """Return child results and optionally build a merged artifact bundle."""

    service = _service()
    return _call(
        service,
        lambda: service.batch_result(
            batch_id,
            include_samples=include_samples,
            sample_limit=sample_limit,
            build_bundle=build_bundle,
            allow_partial=allow_partial,
        ),
    )


@mcp.tool()
def mineru_ingest_batch_validate(batch_id: str) -> str:
    """Validate child jobs and the merged batch bundle."""

    service = _service()
    return _call(service, lambda: service.batch_validate(batch_id))


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
