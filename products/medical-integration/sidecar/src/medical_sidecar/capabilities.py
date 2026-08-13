"""Public capability reporting without paths, PHI, credentials, or endpoints."""

from __future__ import annotations

from importlib.util import find_spec
from typing import Any

from . import __version__
from .config import SidecarSettings


def _installed(module: str) -> bool:
    try:
        return find_spec(module) is not None
    except (ImportError, ValueError):
        return False


def capability_document(settings: SidecarSettings) -> dict[str, Any]:
    optional = {
        "text_json_xml_aecg": True,
        "pdf_text_preview": _installed("fitz"),
        "dicom_metadata_frames": _installed("pydicom"),
        "wfdb_waveform": _installed("wfdb"),
        "npy_volume": True,
        "nifti_volume": _installed("numpy") and _installed("nibabel"),
        "image_resize": _installed("PIL"),
        "resampling": _installed("scipy"),
    }
    return {
        "service": "pilotdeck-medical-sidecar",
        "version": __version__,
        "network": {
            "api_bind": settings.api_host,
            "api_port": settings.api_port,
            "localhost_only": True,
            "mcp_enabled": settings.mcp_enabled,
            "mcp_bind": settings.mcp_host,
            "mcp_port": settings.mcp_port,
            "mcp_path": settings.mcp_path,
        },
        "generation": {
            "owner": "pilotdeck",
            "sidecar_calls_llm": False,
            "sidecar_accepts_llm_api_key": False,
        },
        "embedding": {
            "enabled": settings.embedding.enabled,
            "allowlist_required": True,
            "credentials_supported": False,
            "text_query_available": settings.embedding.enabled,
        },
        "storage": {
            "volume_mode": settings.volume_storage.mode,
            "ttl_enabled": settings.volume_storage.configured,
            "phi_persisted": settings.volume_storage.mode == "filesystem",
            "paths_exposed": False,
        },
        "feature_flags": {
            "gallery": settings.gallery.enabled,
            "m3d": settings.m3d.enabled,
        },
        "limits": {
            "ingestion": {
                "max_files": settings.ingestion.max_files,
                "max_file_bytes": settings.ingestion.max_file_bytes,
                "max_total_bytes": settings.ingestion.max_total_bytes,
                "max_directory_depth": settings.ingestion.max_directory_depth,
                "max_pages": settings.ingestion.max_pages,
                "max_frames": settings.ingestion.max_frames,
                "max_pixels": settings.ingestion.max_pixels,
            },
            "rag": {
                "default_top_k": settings.rag.default_top_k,
                "max_top_k": settings.rag.max_top_k,
                "default_min_score": settings.rag.default_min_score,
                "max_rows": settings.rag.max_rows,
                "max_dimension": settings.rag.max_dimension,
            },
            "table": {
                "max_columns": settings.table.max_columns,
                "max_rows": settings.table.max_rows,
                "max_cell_chars": settings.table.max_cell_chars,
            },
            "imaging": {
                "max_volume_bytes": settings.imaging.max_volume_bytes,
                "max_voxels": settings.imaging.max_voxels,
                "max_preview_slices": settings.imaging.max_preview_slices,
                "max_gallery_slices": settings.imaging.max_gallery_slices,
            },
        },
        "contracts": {
            "attachment_manifest": "2",
            "rag_result": "1",
            "table_document": "1",
            "trauma_prompt": "1",
            "volume_metadata": "1",
            "gallery_metadata": "1",
            "gallery_scan": "1",
            "volume_storage": "1",
            "table_ocr": "table-ocr.v1",
            "clinical_workflows": "clinical-workflows.v1",
            "m3d_adapter": "m3d-adapter.v1",
        },
        "tools": [
            "medical_sidecar_describe_attachment",
            "medical_sidecar_prepare_attachments",
            "medical_sidecar_rag_contract",
            "medical_sidecar_rag_status",
            "medical_sidecar_rag_search",
            "medical_sidecar_rag_query",
            "medical_sidecar_normalize_table",
            "medical_sidecar_safe_csv",
            "medical_sidecar_build_table_ocr_prompt",
            "medical_sidecar_parse_table_ocr",
            "medical_sidecar_clinical_contract",
            "medical_sidecar_build_clinical_prompt",
            "medical_sidecar_parse_clinical_output",
            "medical_sidecar_build_trauma_prompt",
            "medical_sidecar_validate_volume",
            "medical_sidecar_prepare_volume",
            "medical_sidecar_volume_storage_status",
            "medical_sidecar_upload_volume",
            "medical_sidecar_list_volumes",
            "medical_sidecar_get_volume",
            "medical_sidecar_get_volume_slice",
            "medical_sidecar_delete_volume",
            "medical_sidecar_validate_gallery",
            "medical_sidecar_gallery_status",
            "medical_sidecar_gallery_datasets",
            "medical_sidecar_gallery_cases",
            "medical_sidecar_gallery_case",
            "medical_sidecar_gallery_slice",
            "medical_sidecar_m3d_health",
            "medical_sidecar_m3d_infer",
        ],
        "optional_parsers": optional,
        "readiness": {
            "contract_tools": True,
            "format_parsing": True,
            "rag_configured": settings.rag.configured,
            "rag_corpus_loaded": False,
            "embedding_configured": settings.embedding.enabled,
            "gallery_configured": settings.gallery.configured,
            "storage_configured": settings.volume_storage.configured,
            "m3d_feature_enabled": settings.m3d.enabled,
            "m3d_available": False,
        },
    }

