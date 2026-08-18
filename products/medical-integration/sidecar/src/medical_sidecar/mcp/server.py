"""Streamable HTTP MCP server factory."""

from __future__ import annotations

from typing import Any

from ..config import SidecarSettings, require_loopback_host
from ..imaging.gallery import GalleryScanner
from ..imaging.m3d import M3DClient
from ..imaging.volume_store import VolumeStore
from ..rag.artifacts import RagArtifactLoader
from ..rag.embedding import EmbeddingClient
from . import tools


def build_mcp_server(settings: SidecarSettings | None = None) -> Any:
    resolved = (settings or SidecarSettings()).validate()
    if not resolved.mcp_enabled:
        raise ValueError("MCP is disabled by configuration")
    require_loopback_host(resolved.mcp_host)

    try:
        from mcp.server.fastmcp import FastMCP
    except ImportError as exc:
        raise RuntimeError("MCP runtime is not installed; install the base sidecar requirements") from exc

    server = FastMCP(
        "PilotDeck Medical Sidecar",
        instructions=(
            "Local medical contract tools. No generative model calls, no LLM keys, "
            "PHI persistence is disabled by default, and no diagnostic authority."
        ),
        host=resolved.mcp_host,
        port=resolved.mcp_port,
        streamable_http_path=resolved.mcp_path,
        stateless_http=True,
        json_response=True,
    )
    rag_loader = RagArtifactLoader(resolved.rag, data_root=resolved.data.root)
    embedding_client = (
        EmbeddingClient(
            resolved.embedding.endpoint or "",
            resolved.embedding.allowed_hosts,
            timeout_seconds=resolved.embedding.timeout_seconds,
            max_response_bytes=resolved.embedding.max_response_bytes,
        )
        if resolved.embedding.enabled
        else None
    )
    gallery_scanner = GalleryScanner(
        resolved.gallery,
        resolved.imaging,
        data_root=resolved.data.root,
        max_pixels=resolved.ingestion.max_pixels,
    )
    volume_store = VolumeStore(
        resolved.volume_storage,
        resolved.imaging,
        data_root=resolved.data.root,
    )
    m3d_client = M3DClient(resolved.m3d)

    @server.tool()
    def medical_sidecar_describe_attachment(
        filename: str,
        relative_path: str = "",
        media_type: str = "",
        byte_size: int = 0,
        sha256: str = "",
    ) -> dict[str, Any]:
        """Validate attachment metadata and report the registered parser format."""

        return tools.describe_attachment(
            filename,
            relative_path,
            media_type,
            byte_size,
            sha256,
            resolved.ingestion.max_file_bytes,
            resolved.ingestion.max_directory_depth,
        )

    @server.tool()
    def medical_sidecar_prepare_attachments(
        attachments: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Parse base64 attachments without persistent storage or model calls."""

        return tools.prepare_attachments(attachments, limits=resolved.ingestion)

    @server.tool()
    def medical_sidecar_rag_contract(
        query: str,
        corpus_id: str,
        top_k: int = resolved.rag.default_top_k,
        min_score: float = resolved.rag.default_min_score,
        filters: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        """Validate a RAG query and return the required result/source contract."""

        return tools.rag_contract(
            query,
            corpus_id,
            top_k,
            min_score,
            filters,
            resolved.rag.max_top_k,
        )

    @server.tool()
    def medical_sidecar_rag_status(validate: bool = True) -> dict[str, Any]:
        """Report configured RAG artifact readiness without exposing local paths."""

        return rag_loader.status(validate=validate)

    @server.tool()
    def medical_sidecar_rag_search(
        query_vector: list[float],
        query: str = "vector-query",
        corpus_id: str = resolved.rag.corpus_id,
        top_k: int = resolved.rag.default_top_k,
        min_score: float = resolved.rag.default_min_score,
        filters: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        """Search validated JSONL+NPY artifacts using a caller-provided vector."""

        return tools.search_rag(
            rag_loader,
            query=query,
            corpus_id=corpus_id,
            query_vector=query_vector,
            top_k=top_k,
            min_score=min_score,
            filters=filters,
        )

    @server.tool()
    def medical_sidecar_rag_query(
        query: str,
        corpus_id: str = resolved.rag.corpus_id,
        top_k: int = resolved.rag.default_top_k,
        min_score: float = resolved.rag.default_min_score,
        filters: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        """Embed text only when the embedding boundary is explicitly configured."""

        return tools.query_rag(
            rag_loader,
            embedding_client,
            query=query,
            corpus_id=corpus_id,
            top_k=top_k,
            min_score=min_score,
            filters=filters,
        )

    @server.tool()
    def medical_sidecar_normalize_table(
        model_output: str,
        include_raw: bool = True,
    ) -> dict[str, Any]:
        """Normalize JSON, Markdown, or HTML model output into a table document."""

        return tools.normalize_table(
            model_output,
            include_raw,
            max_columns=resolved.table.max_columns,
            max_rows=resolved.table.max_rows,
            max_cell_chars=resolved.table.max_cell_chars,
        )

    @server.tool()
    def medical_sidecar_safe_csv(
        columns: list[Any],
        rows: list[list[Any]],
        include_utf8_bom: bool = False,
    ) -> dict[str, Any]:
        """Export CSV with spreadsheet formula-injection protection."""

        return tools.safe_csv(
            columns,
            rows,
            include_utf8_bom,
            max_columns=resolved.table.max_columns,
            max_rows=resolved.table.max_rows,
            max_cell_chars=resolved.table.max_cell_chars,
        )

    @server.tool()
    def medical_sidecar_build_table_ocr_prompt(
        images: list[dict[str, Any]],
        language: str = "zh-CN",
        instructions: str = "",
    ) -> dict[str, Any]:
        """Build a table OCR prompt for PilotDeck without calling a model."""

        return tools.table_ocr_prompt(
            images,
            language=language,
            instructions=instructions,
        )

    @server.tool()
    def medical_sidecar_parse_table_ocr(
        model_output: str,
        include_raw: bool = True,
    ) -> dict[str, Any]:
        """Parse PilotDeck table OCR output under the versioned contract."""

        return tools.table_ocr_parse(
            model_output,
            include_raw=include_raw,
            max_columns=resolved.table.max_columns,
            max_rows=resolved.table.max_rows,
            max_cell_chars=resolved.table.max_cell_chars,
        )

    @server.tool()
    def medical_sidecar_clinical_contract(workflow: str) -> dict[str, Any]:
        """Return a treatment, translation, case, Eval, or Compare contract."""

        return tools.clinical_contract(workflow)

    @server.tool()
    def medical_sidecar_build_clinical_prompt(
        workflow: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        """Build a structured clinical prompt for PilotDeck-owned generation."""

        return tools.clinical_prompt(
            workflow,
            payload,
            limits=resolved.workflows,
        )

    @server.tool()
    def medical_sidecar_parse_clinical_output(
        workflow: str,
        model_output: str,
    ) -> dict[str, Any]:
        """Validate PilotDeck output against a structured clinical contract."""

        return tools.clinical_parse(
            workflow,
            model_output,
            limits=resolved.workflows,
        )

    @server.tool()
    def medical_sidecar_build_trauma_prompt(
        stage: str,
        description: str = "",
        scene: str = "",
        images: list[dict[str, Any]] | None = None,
        style: str = "eval",
    ) -> dict[str, Any]:
        """Build a versioned six-stage prompt for PilotDeck to send to its model."""

        return tools.trauma_prompt(stage, description, scene, images or [], style)

    @server.tool()
    def medical_sidecar_validate_volume(metadata: dict[str, Any]) -> dict[str, Any]:
        """Validate storage-neutral NIfTI/NPY volume metadata and budgets."""

        return tools.validate_volume(
            metadata,
            max_volume_bytes=resolved.imaging.max_volume_bytes,
            max_voxels=resolved.imaging.max_voxels,
            max_preview_slices=resolved.imaging.max_preview_slices,
        )

    @server.tool()
    def medical_sidecar_prepare_volume(
        filename: str,
        data_base64: str,
        max_slices: int = 8,
    ) -> dict[str, Any]:
        """Parse NPY/NIfTI metadata and return limited non-diagnostic previews."""

        return tools.prepare_volume(
            filename=filename,
            data_base64=data_base64,
            requested_slices=max_slices,
            limits=resolved.imaging,
        )

    @server.tool()
    def medical_sidecar_volume_storage_status() -> dict[str, Any]:
        """Report TTL storage mode without exposing local paths."""

        return volume_store.status()

    @server.tool()
    def medical_sidecar_upload_volume(
        filename: str,
        data_base64: str,
        max_slices: int = 8,
        ttl_seconds: int | None = None,
    ) -> dict[str, Any]:
        """Upload a Volume to TTL memory or explicitly configured storage."""

        return tools.upload_volume(
            volume_store,
            filename=filename,
            data_base64=data_base64,
            requested_slices=max_slices,
            ttl_seconds=ttl_seconds,
        )

    @server.tool()
    def medical_sidecar_list_volumes() -> dict[str, Any]:
        """List non-expired Volumes without bytes or storage paths."""

        return tools.list_volumes(volume_store)

    @server.tool()
    def medical_sidecar_get_volume(volume_id: str) -> dict[str, Any]:
        """Return one non-expired Volume descriptor."""

        return tools.get_volume(volume_store, volume_id)

    @server.tool()
    def medical_sidecar_get_volume_slice(
        volume_id: str,
        index: int,
    ) -> dict[str, Any]:
        """Render one non-diagnostic axial slice from a stored Volume."""

        return tools.get_volume_slice(volume_store, volume_id, index)

    @server.tool()
    def medical_sidecar_delete_volume(volume_id: str) -> dict[str, Any]:
        """Delete a temporary or configured Volume before its TTL."""

        return tools.delete_volume(volume_store, volume_id)

    @server.tool()
    def medical_sidecar_validate_gallery(
        kind: str,
        metadata: dict[str, Any],
    ) -> dict[str, Any]:
        """Validate Gallery dataset or case metadata without scanning storage."""

        return tools.validate_gallery(
            kind,
            metadata,
            max_gallery_slices=resolved.imaging.max_gallery_slices,
        )

    @server.tool()
    def medical_sidecar_gallery_status() -> dict[str, Any]:
        """Report Gallery readiness without exposing configured roots."""

        return gallery_scanner.status()

    @server.tool()
    def medical_sidecar_gallery_datasets() -> dict[str, Any]:
        """Scan configured Gallery datasets under the trusted data root."""

        return tools.gallery_datasets(gallery_scanner)

    @server.tool()
    def medical_sidecar_gallery_cases(dataset_id: str) -> dict[str, Any]:
        """List safe case descriptors for one configured Gallery dataset."""

        return tools.gallery_cases(gallery_scanner, dataset_id)

    @server.tool()
    def medical_sidecar_gallery_case(
        dataset_id: str,
        case_id: str,
    ) -> dict[str, Any]:
        """Describe one Gallery case and its slice indexes."""

        return tools.gallery_case(gallery_scanner, dataset_id, case_id)

    @server.tool()
    def medical_sidecar_gallery_slice(
        dataset_id: str,
        case_id: str,
        index: int,
    ) -> dict[str, Any]:
        """Render one Gallery slice after root confinement checks."""

        return tools.gallery_slice(gallery_scanner, dataset_id, case_id, index)

    @server.tool()
    def medical_sidecar_m3d_health() -> dict[str, Any]:
        """Probe the optional localhost M3D service with a bounded timeout."""

        return tools.m3d_health(m3d_client)

    @server.tool()
    def medical_sidecar_m3d_infer(
        task: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        """Invoke a fixed localhost M3D inference endpoint when enabled."""

        return tools.m3d_infer(m3d_client, task, payload)

    return server


def run_mcp(settings: SidecarSettings | None = None) -> None:
    build_mcp_server(settings).run(transport="streamable-http")

