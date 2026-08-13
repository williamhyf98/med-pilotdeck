"""Local health and capability API."""

from __future__ import annotations

from typing import Any

from .. import __version__
from ..capabilities import capability_document
from ..config import SidecarSettings
from ..imaging.gallery import (
    GalleryNotFoundError,
    GalleryScanner,
    GalleryUnavailableError,
)
from ..imaging.m3d import M3DClient, M3DUnavailableError
from ..imaging.volume_store import (
    VolumeNotFoundError,
    VolumeStore,
    VolumeUnavailableError,
)
from ..mcp import tools
from ..rag.artifacts import RagArtifactLoader, RagUnavailableError
from ..rag.embedding import EmbeddingClient


def create_app(settings: SidecarSettings | None = None) -> Any:
    resolved = (settings or SidecarSettings()).validate()
    try:
        from fastapi import FastAPI, HTTPException, Request
        from fastapi.responses import JSONResponse
        from starlette.middleware.trustedhost import TrustedHostMiddleware
    except ImportError as exc:
        raise RuntimeError("FastAPI runtime is not installed; install the base sidecar requirements") from exc

    app = FastAPI(
        title="PilotDeck Medical Sidecar",
        version=__version__,
        description="Local-only capability API; model generation remains in PilotDeck.",
    )
    app.add_middleware(
        TrustedHostMiddleware,
        allowed_hosts=["127.0.0.1", "localhost", "::1", "[::1]"],
    )
    app.state.medical_settings = resolved
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
    app.state.rag_loader = rag_loader
    app.state.embedding_client = embedding_client
    app.state.gallery_scanner = gallery_scanner
    app.state.volume_store = volume_store
    app.state.m3d_client = m3d_client

    @app.middleware("http")
    async def enforce_request_budget(request: Request, call_next: Any) -> Any:
        declared = request.headers.get("content-length")
        maximum = (resolved.ingestion.max_total_bytes * 4 // 3) + 1_048_576
        if declared and declared.isdigit() and int(declared) > maximum:
            return JSONResponse(
                status_code=413,
                content={"detail": {"code": "request_too_large", "message": "request body exceeds the configured budget"}},
            )
        return await call_next(request)

    def health_document() -> dict[str, Any]:
        rag_status = rag_loader.status(validate=False)
        storage_status = volume_store.status()
        gallery_status = gallery_scanner.status()
        m3d_status = m3d_client.health()
        return {
            "status": "ok",
            "service": "pilotdeck-medical-sidecar",
            "version": __version__,
            "localhost_only": True,
            "generation_owner": "pilotdeck",
            "embedding": "enabled" if resolved.embedding.enabled else "disabled",
            "rag_corpus": (
                "ready"
                if rag_status["ready"]
                else "configured_not_loaded"
                if resolved.rag.configured
                else "not_configured"
            ),
            "storage": storage_status["mode"],
            "capabilities": {
                "rag": bool(rag_status["ready"]),
                "rag_text_query": bool(rag_status["ready"] and embedding_client),
                "attachments": True,
                "tables": True,
                "imaging": True,
                "gallery": gallery_status["available"],
                "volume_storage": storage_status["available"],
                "m3d": m3d_status["available"],
            },
            "unavailable": {
                "gallery": gallery_status.get("reason"),
                "m3d": m3d_status.get("reason"),
            },
        }

    @app.get("/health")
    @app.get("/v1/health")
    def health() -> dict[str, Any]:
        return health_document()

    @app.get("/capabilities")
    @app.get("/v1/capabilities")
    def capabilities() -> dict[str, Any]:
        return capability_document(resolved)

    @app.get("/v1/rag/corpora")
    def rag_corpora() -> dict[str, Any]:
        configured = rag_loader.status(validate=True)
        return {
            "corpora": [
                configured,
                {
                    "id": "general-medical",
                    "name": "通用医学知识库",
                    "description": "占位能力，默认禁用。",
                    "ready": False,
                    "documentCount": 0,
                    "reason": "not_implemented",
                },
            ],
            "default": resolved.rag.corpus_id,
        }

    @app.post("/v1/attachments/prepare")
    def prepare_attachments(payload: dict[str, Any]) -> dict[str, Any]:
        try:
            attachments = payload.get("attachments")
            if not isinstance(attachments, list) or not attachments:
                raise ValueError("attachments must be a non-empty list")
            normalized_attachments = []
            for item in attachments:
                if not isinstance(item, dict):
                    raise ValueError("each attachment must be an object")
                normalized = dict(item)
                encoded = normalized.get("data")
                if isinstance(encoded, str) and encoded.startswith("data:") and "," in encoded:
                    normalized["data"] = encoded.split(",", 1)[1]
                normalized_attachments.append(normalized)
            return tools.prepare_attachments(normalized_attachments, limits=resolved.ingestion)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.post("/v1/rag/search")
    def search_rag(payload: dict[str, Any]) -> dict[str, Any]:
        try:
            vector = payload.get("queryVector", payload.get("query_vector"))
            filters = payload.get("filters")
            if filters is not None and not isinstance(filters, dict):
                raise ValueError("filters must be an object")
            common = {
                "query": str(payload.get("query") or ""),
                "corpus_id": str(
                    payload.get(
                        "corpusId",
                        payload.get("corpus_id", resolved.rag.corpus_id),
                    )
                ),
                "top_k": int(
                    payload.get(
                        "topK",
                        payload.get("top_k", resolved.rag.default_top_k),
                    )
                ),
                "min_score": float(
                    payload.get(
                        "minScore",
                        payload.get("min_score", resolved.rag.default_min_score),
                    )
                ),
                "filters": {
                    str(key): str(value)
                    for key, value in (filters or {}).items()
                },
            }
            if vector is None:
                if not common["query"]:
                    raise ValueError("query is required when queryVector is absent")
                return tools.query_rag(
                    rag_loader,
                    embedding_client,
                    **common,
                )
            if not isinstance(vector, list):
                raise ValueError("queryVector must be a numeric list")
            return tools.search_rag(
                rag_loader,
                query=common["query"] or "vector-query",
                corpus_id=common["corpus_id"],
                query_vector=vector,
                top_k=common["top_k"],
                min_score=common["min_score"],
                filters=common["filters"],
            )
        except RagUnavailableError as exc:
            raise HTTPException(
                status_code=503,
                detail={"code": "rag_unavailable", "message": str(exc)},
            ) from exc
        except (OSError, ValueError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.post("/v1/tables/prepare")
    def prepare_table(payload: dict[str, Any]) -> dict[str, Any]:
        try:
            table = payload.get("table")
            if not isinstance(table, dict):
                raise ValueError("table must be an object")
            columns = table.get("columns")
            rows = table.get("rows")
            if not isinstance(columns, list) or not isinstance(rows, list):
                raise ValueError("table columns and rows must be lists")
            if any(not isinstance(row, list) for row in rows):
                raise ValueError("each table row must be a list")
            exported = tools.safe_csv(
                columns,
                rows,
                include_utf8_bom=True,
                max_columns=resolved.table.max_columns,
                max_rows=resolved.table.max_rows,
                max_cell_chars=resolved.table.max_cell_chars,
            )
            return {
                "status": "prepared",
                "table": {
                    "columns": columns,
                    "rows": rows,
                },
                **exported,
            }
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.post("/v1/tables/ocr/prompt")
    def table_ocr_prompt(payload: dict[str, Any]) -> dict[str, Any]:
        try:
            images = payload.get("images")
            if not isinstance(images, list):
                raise ValueError("images must be a list")
            if any(not isinstance(item, dict) for item in images):
                raise ValueError("each image descriptor must be an object")
            return tools.table_ocr_prompt(
                images,
                language=str(payload.get("language", "zh-CN")),
                instructions=str(payload.get("instructions", "")),
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.post("/v1/tables/ocr/parse")
    def table_ocr_parse(payload: dict[str, Any]) -> dict[str, Any]:
        try:
            output = payload.get("modelOutput", payload.get("model_output"))
            if not isinstance(output, str):
                raise ValueError("modelOutput must be text")
            return tools.table_ocr_parse(
                output,
                include_raw=bool(payload.get("includeRaw", payload.get("include_raw", True))),
                max_columns=resolved.table.max_columns,
                max_rows=resolved.table.max_rows,
                max_cell_chars=resolved.table.max_cell_chars,
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.get("/v1/clinical/contracts/{workflow}")
    def clinical_contract(workflow: str) -> dict[str, Any]:
        try:
            return tools.clinical_contract(workflow)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/v1/clinical/prompts/{workflow}")
    def clinical_prompt(workflow: str, payload: dict[str, Any]) -> dict[str, Any]:
        try:
            return tools.clinical_prompt(
                workflow,
                payload,
                limits=resolved.workflows,
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.post("/v1/clinical/parse/{workflow}")
    def clinical_parse(workflow: str, payload: dict[str, Any]) -> dict[str, Any]:
        try:
            output = payload.get("modelOutput", payload.get("model_output"))
            if not isinstance(output, str):
                raise ValueError("modelOutput must be text")
            return tools.clinical_parse(
                workflow,
                output,
                limits=resolved.workflows,
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.post("/v1/imaging/prepare")
    def prepare_imaging(payload: dict[str, Any]) -> dict[str, Any]:
        prepared = prepare_attachments({"attachments": payload.get("images")})
        return {
            "status": "prepared",
            "diagnostic_grade": False,
            "images": prepared["artifacts"],
            "warnings": prepared["warnings"],
        }

    @app.post("/v1/imaging/volume/validate")
    def validate_volume(payload: dict[str, Any]) -> dict[str, Any]:
        try:
            metadata = payload.get("metadata")
            if not isinstance(metadata, dict):
                raise ValueError("metadata must be an object")
            return {
                "status": "validated",
                "volume": tools.validate_volume(
                    metadata,
                    max_volume_bytes=resolved.imaging.max_volume_bytes,
                    max_voxels=resolved.imaging.max_voxels,
                    max_preview_slices=resolved.imaging.max_preview_slices,
                ),
            }
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.post("/v1/imaging/volume/prepare")
    def prepare_volume(payload: dict[str, Any]) -> dict[str, Any]:
        try:
            filename = str(payload.get("name", payload.get("filename", "")))
            encoded = payload.get("data")
            if not isinstance(encoded, str):
                raise ValueError("data must be base64 text")
            return tools.prepare_volume(
                filename=filename,
                data_base64=encoded,
                requested_slices=int(payload.get("maxSlices", payload.get("max_slices", 8))),
                limits=resolved.imaging,
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.post("/v1/imaging/volumes")
    def upload_volume(payload: dict[str, Any]) -> dict[str, Any]:
        try:
            encoded = payload.get("data")
            if not isinstance(encoded, str):
                raise ValueError("data must be base64 text")
            ttl_raw = payload.get("ttlSeconds", payload.get("ttl_seconds"))
            return tools.upload_volume(
                volume_store,
                filename=str(payload.get("name", payload.get("filename", ""))),
                data_base64=encoded,
                requested_slices=int(
                    payload.get("maxSlices", payload.get("max_slices", 8))
                ),
                ttl_seconds=int(ttl_raw) if ttl_raw is not None else None,
            )
        except VolumeUnavailableError as exc:
            raise HTTPException(
                status_code=503,
                detail={"code": "volume_unavailable", "message": str(exc)},
            ) from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.get("/v1/imaging/volumes")
    def list_volumes() -> dict[str, Any]:
        return tools.list_volumes(volume_store)

    @app.get("/v1/imaging/volumes/{volume_id}")
    def get_volume(volume_id: str) -> dict[str, Any]:
        try:
            return tools.get_volume(volume_store, volume_id)
        except (ValueError, VolumeNotFoundError) as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/v1/imaging/volumes/{volume_id}/slices/{index}")
    def get_volume_slice(volume_id: str, index: int) -> dict[str, Any]:
        try:
            return tools.get_volume_slice(volume_store, volume_id, index)
        except VolumeNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except VolumeUnavailableError as exc:
            raise HTTPException(
                status_code=503,
                detail={"code": "volume_unavailable", "message": str(exc)},
            ) from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.delete("/v1/imaging/volumes/{volume_id}")
    def delete_volume(volume_id: str) -> dict[str, Any]:
        try:
            return tools.delete_volume(volume_store, volume_id)
        except (ValueError, VolumeNotFoundError) as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/v1/imaging/gallery/validate")
    def validate_gallery(payload: dict[str, Any]) -> dict[str, Any]:
        try:
            kind = str(payload.get("kind") or "")
            metadata = payload.get("metadata")
            if not isinstance(metadata, dict):
                raise ValueError("metadata must be an object")
            return {
                "status": "validated",
                "gallery": tools.validate_gallery(
                    kind,
                    metadata,
                    max_gallery_slices=resolved.imaging.max_gallery_slices,
                ),
            }
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.get("/v1/imaging/gallery/datasets")
    def gallery_datasets() -> dict[str, Any]:
        try:
            return tools.gallery_datasets(gallery_scanner)
        except GalleryUnavailableError as exc:
            raise HTTPException(
                status_code=503,
                detail={"code": "gallery_unavailable", "message": str(exc)},
            ) from exc

    @app.get("/v1/imaging/gallery/datasets/{dataset_id}/cases")
    def gallery_cases(dataset_id: str) -> dict[str, Any]:
        try:
            return tools.gallery_cases(gallery_scanner, dataset_id)
        except GalleryNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except GalleryUnavailableError as exc:
            raise HTTPException(
                status_code=503,
                detail={"code": "gallery_unavailable", "message": str(exc)},
            ) from exc
        except (OSError, ValueError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.get("/v1/imaging/gallery/datasets/{dataset_id}/cases/{case_id}")
    def gallery_case(dataset_id: str, case_id: str) -> dict[str, Any]:
        try:
            return tools.gallery_case(gallery_scanner, dataset_id, case_id)
        except GalleryNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except GalleryUnavailableError as exc:
            raise HTTPException(
                status_code=503,
                detail={"code": "gallery_unavailable", "message": str(exc)},
            ) from exc
        except (OSError, ValueError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.get(
        "/v1/imaging/gallery/datasets/{dataset_id}/cases/{case_id}/slices/{index}"
    )
    def gallery_slice(dataset_id: str, case_id: str, index: int) -> dict[str, Any]:
        try:
            return tools.gallery_slice(
                gallery_scanner,
                dataset_id,
                case_id,
                index,
            )
        except GalleryNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except GalleryUnavailableError as exc:
            raise HTTPException(
                status_code=503,
                detail={"code": "gallery_unavailable", "message": str(exc)},
            ) from exc
        except (OSError, ValueError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.get("/v1/m3d/health")
    def m3d_health() -> dict[str, Any]:
        return tools.m3d_health(m3d_client)

    @app.post("/v1/m3d/infer")
    def m3d_infer(payload: dict[str, Any]) -> dict[str, Any]:
        try:
            input_payload = payload.get("input", payload.get("payload", {}))
            if not isinstance(input_payload, dict):
                raise ValueError("M3D input must be an object")
            return tools.m3d_infer(
                m3d_client,
                str(payload.get("task", "")),
                input_payload,
            )
        except M3DUnavailableError as exc:
            raise HTTPException(
                status_code=503,
                detail={"code": "m3d_unavailable", "message": str(exc)},
            ) from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    return app

