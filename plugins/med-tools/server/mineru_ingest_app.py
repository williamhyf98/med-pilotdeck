"""MCP entrypoint for the MinerU ingestion service."""

from __future__ import annotations

import json
import os
from typing import Any, Optional

from mcp.server.fastmcp import FastMCP

from .mineru_ingest import MinerUIngestService


HTTP_HOST_ENV = "MED_RAG_MINERU_MCP_HOST"
HTTP_PORT_ENV = "MED_RAG_MINERU_MCP_PORT"


def _http_host() -> str:
    """Return the loopback-only default for the optional HTTP MCP service."""

    host = os.environ.get(HTTP_HOST_ENV, "127.0.0.1").strip() or "127.0.0.1"
    if host not in {"127.0.0.1", "::1", "localhost"}:
        raise ValueError(f"{HTTP_HOST_ENV} must be a loopback address (127.0.0.1, ::1, or localhost)")
    return host


def _http_port() -> int:
    raw = os.environ.get(HTTP_PORT_ENV, "18890").strip() or "18890"
    try:
        port = int(raw)
    except ValueError as exc:
        raise ValueError(f"{HTTP_PORT_ENV} must be an integer between 1 and 65535") from exc
    if not 1 <= port <= 65535:
        raise ValueError(f"{HTTP_PORT_ENV} must be between 1 and 65535")
    return port


mcp = FastMCP(
    "mineru-ingest-tools",
    instructions=(
        "Convert authorized PDFs and common text documents into Med-PilotDeck normalized "
        "chunk artifacts. PDFs use an externally configured MinerU runtime; doc/docx/text "
        "inputs use lightweight text extraction. This service is asynchronous and does "
        "not create embeddings."
    ),
    host=_http_host(),
    port=_http_port(),
    streamable_http_path="/mcp",
    stateless_http=True,
)


def _service() -> MinerUIngestService:
    return MinerUIngestService()


@mcp.tool()
def mineru_ingest_health() -> str:
    """Check whether the async document ingestion service is configured."""

    return json.dumps(_service().health(), ensure_ascii=False, indent=2)


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
    """Submit one document parse job and return immediately.

    Args:
        source_path: Absolute or project-relative path to a PDF/doc/docx/text-like file.
        pdf_path: Backward-compatible alias for source_path.
        book_id: Optional stable document id used in chunk_id/doc_id.
        title: Optional display title; defaults to the source file stem.
        volume: Optional volume/subtitle metadata.
        language: MinerU language argument for PDFs, default ``ch``.
        device: MinerU device argument for PDFs, default ``cpu``.
        start_page: Optional 0-based MinerU start page for PDF partial parsing.
        end_page: Optional 0-based MinerU end page for PDF partial parsing.
        page_index_offset: Added to MinerU page_idx+1 for PDFs; defaults to start_page for partial parsing.
        formula_enabled: Enable MinerU formula recognition for PDFs.
        table_enabled: Enable MinerU table recognition for PDFs.
        timeout_seconds: Per-document timeout; for PDFs this is the MinerU timeout.
        cpu_threads: CPU thread cap for BLAS/OpenMP; defaults to service config, currently 8.
        max_chars: Target max chunk characters.
        overlap_chars: Sliding overlap characters.
        force: If true, create a new timestamped job instead of reusing a completed one.
    """

    resolved_source_path = source_path.strip() or pdf_path.strip()
    if not resolved_source_path:
        raise ValueError("source_path is required")
    payload = _service().submit(
        pdf_path=resolved_source_path,
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
    )
    return json.dumps(payload, ensure_ascii=False, indent=2)


@mcp.tool()
def mineru_ingest_status(job_id: str) -> str:
    """Return persisted status for a submitted MinerU ingest job."""

    return json.dumps(_service().status(job_id), ensure_ascii=False, indent=2)


@mcp.tool()
def mineru_ingest_result(job_id: str, include_samples: bool = False, sample_limit: int = 3) -> str:
    """Return artifact paths and optional chunk samples for a completed job."""

    return json.dumps(
        _service().result(job_id, include_samples=include_samples, sample_limit=sample_limit),
        ensure_ascii=False,
        indent=2,
    )


@mcp.tool()
def mineru_ingest_validate(job_id: str) -> str:
    """Validate manifest/chunks/pages/assets artifacts for a completed job."""

    return json.dumps(_service().validate(job_id), ensure_ascii=False, indent=2)


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
    """Submit multiple document parse jobs as one batch.

    ``documents`` accepts either path strings or objects with ``source_path`` plus
    optional per-document metadata/overrides: ``book_id``, ``title``,
    ``volume``, ``start_page``, ``end_page``, ``page_index_offset``,
    ``language``, ``device``, ``formula_enabled``, ``table_enabled``,
    ``timeout_seconds``, ``cpu_threads``, ``max_chars`` and ``overlap_chars``.
    ``pdfs`` remains accepted as a backward-compatible alias.
    Jobs are queued through the service's single-worker executor by default.
    """

    resolved_documents = documents if documents is not None else pdfs
    if resolved_documents is None:
        raise ValueError("documents is required")
    return json.dumps(
        _service().submit_batch(
            pdfs=resolved_documents,
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
        ensure_ascii=False,
        indent=2,
    )


@mcp.tool()
def mineru_ingest_batch_status(batch_id: str) -> str:
    """Return aggregate status for a submitted multi-PDF batch."""

    return json.dumps(_service().batch_status(batch_id), ensure_ascii=False, indent=2)


@mcp.tool()
def mineru_ingest_batch_result(
    batch_id: str,
    include_samples: bool = False,
    sample_limit: int = 3,
    build_bundle: bool = True,
    allow_partial: bool = False,
) -> str:
    """Return per-PDF results and optionally build a merged batch corpus bundle."""

    return json.dumps(
        _service().batch_result(
            batch_id,
            include_samples=include_samples,
            sample_limit=sample_limit,
            build_bundle=build_bundle,
            allow_partial=allow_partial,
        ),
        ensure_ascii=False,
        indent=2,
    )


@mcp.tool()
def mineru_ingest_batch_validate(batch_id: str) -> str:
    """Validate child jobs and the merged batch bundle when present."""

    return json.dumps(_service().batch_validate(batch_id), ensure_ascii=False, indent=2)


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
