"""Pure implementations behind the MCP tool surface."""

from __future__ import annotations

import base64
import binascii
import re
from typing import Any, Sequence

from ..clinical.workflows import (
    build_clinical_prompt,
    contract_document as clinical_contract_document,
    parse_clinical_output,
)
from ..config import ImagingLimits, IngestionLimits, WorkflowLimits
from ..imaging.contracts import (
    GalleryCaseMetadata,
    GalleryDatasetMetadata,
    VolumeMetadata,
)
from ..imaging.gallery import GalleryScanner
from ..imaging.m3d import M3DClient
from ..imaging.volume import VolumeLimits, prepare_volume as prepare_volume_data
from ..imaging.volume_store import VolumeStore
from ..ingestion.contracts import detect_format, safe_filename, safe_relative_path
from ..ingestion.service import AttachmentInput, prepare_attachment_batch
from ..rag.artifacts import RagArtifactLoader
from ..rag.contracts import RagQuery
from ..rag.embedding import EmbeddingClient
from ..table.contracts import (
    TableBudget,
    normalize_table as normalize_table_shape,
    parse_table_output,
    table_to_safe_csv,
)
from ..table.ocr import build_table_ocr_prompt, parse_table_ocr_output
from ..trauma.prompt_builder import build_trauma_prompt


def describe_attachment(
    filename: str,
    relative_path: str = "",
    media_type: str = "",
    byte_size: int = 0,
    sha256: str = "",
    max_file_bytes: int = 50 * 1024 * 1024,
    max_directory_depth: int = 8,
) -> dict[str, Any]:
    normalized_filename = safe_filename(filename)
    path = relative_path or filename
    normalized_path = safe_relative_path(
        path,
        max_depth=max_directory_depth,
    ).as_posix()
    if byte_size < 0 or byte_size > max_file_bytes:
        raise ValueError("byte_size is outside the default per-file budget")
    if sha256 and not re.fullmatch(r"[0-9a-fA-F]{64}", sha256):
        raise ValueError("sha256 must be a SHA-256 hex digest")
    fmt = detect_format(normalized_filename, media_type)
    return {
        "filename": normalized_filename,
        "relative_path": normalized_path,
        "byte_size": byte_size,
        "sha256": sha256.lower(),
        "format": fmt.to_dict(),
        "supported": fmt.subtype != "unknown",
        "parsing_performed": False,
        "warnings": (
            [] if fmt.subtype != "unknown" else ["format is not registered"]
        ),
    }


def rag_contract(
    query: str,
    corpus_id: str,
    top_k: int = 3,
    min_score: float = 0.75,
    filters: dict[str, str] | None = None,
    max_top_k: int = 8,
) -> dict[str, Any]:
    request = RagQuery(
        query=query,
        corpus_id=corpus_id,
        top_k=top_k,
        min_score=min_score,
        filters=filters or {},
    ).validate(max_top_k=max_top_k)
    return {
        "request": {
            "query": request.query,
            "corpus_id": request.corpus_id,
            "top_k": request.top_k,
            "min_score": request.min_score,
            "filters": dict(request.filters),
        },
        "result_schema_version": 1,
        "required_source_fields": [
            "source_id",
            "chunk_id",
            "score",
            "chunk",
            "title",
            "section",
            "source",
            "preview",
        ],
        "status": "unavailable",
        "reason": "no RAG corpus or embedding artifact is shipped in the source pack",
    }


def prepare_attachments(
    attachments: Sequence[dict[str, Any]],
    *,
    limits: IngestionLimits,
) -> dict[str, Any]:
    if not attachments or len(attachments) > limits.max_files:
        raise ValueError(
            f"attachments must contain between 1 and {limits.max_files} items"
        )
    inputs: list[AttachmentInput] = []
    estimated_total = 0
    for index, item in enumerate(attachments):
        if not isinstance(item, dict):
            raise ValueError(f"attachments[{index}] must be an object")
        filename = str(item.get("name", item.get("filename", "")))
        encoded = item.get("data")
        if not isinstance(encoded, str):
            raise ValueError(f"attachments[{index}].data must be base64 text")
        estimated_bytes = (len(encoded) * 3) // 4
        if estimated_bytes > limits.max_file_bytes:
            raise ValueError(f"attachments[{index}] exceeds the per-file budget")
        estimated_total += estimated_bytes
        if estimated_total > limits.max_total_bytes:
            raise ValueError("attachment total exceeds the configured budget")
        inputs.append(
            AttachmentInput(
                filename=filename,
                relative_path=str(item.get("relativePath", item.get("relative_path", filename))),
                media_type=str(item.get("mimeType", item.get("media_type", ""))),
                data=_decode_base64(encoded, f"attachments[{index}].data"),
            )
        )
    return prepare_attachment_batch(inputs, limits=limits)


def search_rag(
    loader: RagArtifactLoader,
    *,
    query: str,
    corpus_id: str,
    query_vector: Sequence[float],
    top_k: int,
    min_score: float,
    filters: dict[str, str] | None = None,
) -> dict[str, Any]:
    request = RagQuery(
        query=query,
        corpus_id=corpus_id,
        top_k=top_k,
        min_score=min_score,
        filters=filters or {},
    )
    result = loader.search(query_vector=query_vector, query=request)
    return {
        "status": "ready",
        "result": result.to_dict(),
        "generation_owner": "pilotdeck",
    }


def query_rag(
    loader: RagArtifactLoader,
    embedding_client: EmbeddingClient | None,
    *,
    query: str,
    corpus_id: str,
    top_k: int,
    min_score: float,
    filters: dict[str, str] | None = None,
) -> dict[str, Any]:
    request = RagQuery(
        query=query,
        corpus_id=corpus_id,
        top_k=top_k,
        min_score=min_score,
        filters=filters or {},
    ).validate(max_top_k=loader.settings.max_top_k)
    status = loader.status(validate=True)
    if not status["ready"]:
        from ..rag.artifacts import RagUnavailableError

        raise RagUnavailableError(str(status.get("reason") or "rag_artifacts_unavailable"))
    if embedding_client is None:
        result = loader.search_lexical(query=request)
        return {
            "status": "ready",
            "mode": "lexical-fallback",
            "result": result.to_dict(),
            "generation_owner": "pilotdeck",
        }
    try:
        vectors = embedding_client.embed_texts([request.query])
    except (OSError, ValueError) as exc:
        result = loader.search_lexical(query=request)
        body = {
            "status": "ready",
            "mode": "lexical-fallback",
            "result": result.to_dict(),
            "generation_owner": "pilotdeck",
        }
        body["result"].setdefault("warnings", []).append(
            f"embedding service unavailable ({type(exc).__name__}); used lexical fallback"
        )
        return body
    if not vectors:
        result = loader.search_lexical(query=request)
        return {
            "status": "ready",
            "mode": "lexical-fallback",
            "result": result.to_dict(),
            "generation_owner": "pilotdeck",
        }
    return search_rag(
        loader,
        query=request.query,
        corpus_id=request.corpus_id,
        query_vector=vectors[0],
        top_k=request.top_k,
        min_score=request.min_score,
        filters=dict(request.filters),
    )


def prepare_volume(
    *,
    filename: str,
    data_base64: str,
    requested_slices: int,
    limits: ImagingLimits,
) -> dict[str, Any]:
    data = _decode_base64(data_base64, "data")
    return prepare_volume_data(
        data,
        filename=safe_filename(filename),
        limits=VolumeLimits(
            max_volume_bytes=limits.max_volume_bytes,
            max_voxels=limits.max_voxels,
            max_preview_slices=limits.max_preview_slices,
        ),
        requested_slices=requested_slices,
    )


def upload_volume(
    store: VolumeStore,
    *,
    filename: str,
    data_base64: str,
    requested_slices: int,
    ttl_seconds: int | None = None,
) -> dict[str, Any]:
    return store.upload(
        _decode_base64(data_base64, "data"),
        filename=safe_filename(filename),
        requested_slices=requested_slices,
        ttl_seconds=ttl_seconds,
    )


def list_volumes(store: VolumeStore) -> dict[str, Any]:
    return store.list()


def get_volume(store: VolumeStore, volume_id: str) -> dict[str, Any]:
    return store.get(volume_id)


def get_volume_slice(
    store: VolumeStore,
    volume_id: str,
    index: int,
) -> dict[str, Any]:
    return store.slice(volume_id, index)


def delete_volume(store: VolumeStore, volume_id: str) -> dict[str, Any]:
    return store.delete(volume_id)


def gallery_datasets(scanner: GalleryScanner) -> dict[str, Any]:
    return scanner.list_datasets()


def gallery_cases(scanner: GalleryScanner, dataset_id: str) -> dict[str, Any]:
    return scanner.list_cases(dataset_id)


def gallery_case(
    scanner: GalleryScanner,
    dataset_id: str,
    case_id: str,
) -> dict[str, Any]:
    return scanner.get_case(dataset_id, case_id)


def gallery_slice(
    scanner: GalleryScanner,
    dataset_id: str,
    case_id: str,
    index: int,
) -> dict[str, Any]:
    return scanner.get_slice(dataset_id, case_id, index)


def normalize_table(
    model_output: str,
    include_raw: bool = True,
    *,
    max_columns: int = 256,
    max_rows: int = 10_000,
    max_cell_chars: int = 32_768,
) -> dict[str, Any]:
    budget = TableBudget(
        max_columns=max_columns,
        max_rows=max_rows,
        max_cell_chars=max_cell_chars,
    )
    return parse_table_output(model_output, budget=budget).to_dict(include_raw=include_raw)


def safe_csv(
    columns: Sequence[Any],
    rows: Sequence[Sequence[Any]],
    include_utf8_bom: bool = False,
    *,
    max_columns: int = 256,
    max_rows: int = 10_000,
    max_cell_chars: int = 32_768,
) -> dict[str, Any]:
    budget = TableBudget(
        max_columns=max_columns,
        max_rows=max_rows,
        max_cell_chars=max_cell_chars,
    )
    normalized_columns, normalized_rows = normalize_table_shape(
        columns,
        rows,
        budget=budget,
    )
    return {
        "csv": table_to_safe_csv(
            normalized_columns,
            normalized_rows,
            include_utf8_bom=include_utf8_bom,
        ),
        "content_type": "text/csv; charset=utf-8",
        "formula_injection_protection": True,
    }


def table_ocr_prompt(
    images: Sequence[dict[str, Any]],
    *,
    language: str = "zh-CN",
    instructions: str = "",
) -> dict[str, Any]:
    return build_table_ocr_prompt(
        images,
        language=language,
        instructions=instructions,
    )


def table_ocr_parse(
    model_output: str,
    *,
    include_raw: bool,
    max_columns: int,
    max_rows: int,
    max_cell_chars: int,
) -> dict[str, Any]:
    return parse_table_ocr_output(
        model_output,
        budget=TableBudget(
            max_columns=max_columns,
            max_rows=max_rows,
            max_cell_chars=max_cell_chars,
        ),
        include_raw=include_raw,
    )


def clinical_prompt(
    workflow: str,
    payload: dict[str, Any],
    *,
    limits: WorkflowLimits,
) -> dict[str, Any]:
    return build_clinical_prompt(workflow, payload, limits=limits)


def clinical_parse(
    workflow: str,
    model_output: str,
    *,
    limits: WorkflowLimits,
) -> dict[str, Any]:
    return parse_clinical_output(workflow, model_output, limits=limits)


def clinical_contract(workflow: str) -> dict[str, Any]:
    return clinical_contract_document(workflow)


def m3d_health(client: M3DClient) -> dict[str, Any]:
    return client.health()


def m3d_infer(
    client: M3DClient,
    task: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    return client.infer(task, payload)


def trauma_prompt(
    stage: str,
    description: str = "",
    scene: str = "",
    images: Sequence[dict[str, Any]] = (),
    style: str = "eval",
) -> dict[str, Any]:
    return build_trauma_prompt(
        stage=stage,
        description=description,
        scene=scene,
        images=images,
        style=style,
    ).to_dict()


def validate_volume(
    metadata: dict[str, Any],
    *,
    max_volume_bytes: int = 512 * 1024 * 1024,
    max_voxels: int = 512 * 1024 * 1024,
    max_preview_slices: int = 64,
) -> dict[str, Any]:
    return (
        VolumeMetadata.from_mapping(metadata)
        .validate(
            max_volume_bytes=max_volume_bytes,
            max_voxels=max_voxels,
            max_preview_slices=max_preview_slices,
        )
        .to_dict()
    )


def validate_gallery(
    kind: str,
    metadata: dict[str, Any],
    *,
    max_gallery_slices: int = 4096,
) -> dict[str, Any]:
    normalized_kind = (kind or "").strip().lower()
    if normalized_kind == "dataset":
        return GalleryDatasetMetadata.from_mapping(metadata).validate().to_dict()
    if normalized_kind == "case":
        return (
            GalleryCaseMetadata.from_mapping(metadata)
            .validate(max_slices=max_gallery_slices)
            .to_dict()
        )
    raise ValueError("gallery kind must be dataset or case")


def _decode_base64(value: str, field: str) -> bytes:
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError(f"{field} is invalid base64") from exc

