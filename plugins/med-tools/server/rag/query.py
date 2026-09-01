"""Query helpers: remote rag service first, local vector/lexical as fallback."""

from __future__ import annotations

import hashlib
import time
from typing import Any, Mapping

from .embedding_client import EmbeddingError, embed_texts, get_embedding_config
from .rag_service_client import (
    DEFAULT_TOPIC,
    RagServiceError,
    get_rag_service_config,
    remote_health,
    remote_result_to_item,
    resolve_topic,
    retrieve_remote,
)
from .store import RagStore, get_default_store

# Used when the local manifest is absent (remote-only deployments).
DEFAULT_TOP_K = 3
DEFAULT_MAX_TOP_K = 8
DEFAULT_MIN_SCORE = 0.35

PRESENTATION = (
    "工具只返回检索证据。请由主模型基于 chunks 撰写综合救治辅助方案，"
    "区分「所见/用户陈述」与「检索文献」，并注明来源；不得编造未检索到的条文。"
    "输出仅供辅助，须医务人员复核。"
)


def rag_status(
    *,
    validate: bool = False,
    probe_remote: bool = False,
    store: RagStore | None = None,
) -> dict[str, Any]:
    try:
        store = store or get_default_store()
        status = store.status(validate=validate)
        status["plugin_data_root"] = str(store.manifest.root)
    except Exception as exc:  # noqa: BLE001 — remote-only: local artifacts may be gone
        status = {
            "ready": False,
            "loaded": False,
            "document_count": 0,
            "reason": f"{type(exc).__name__}: {str(exc)[:300]}",
        }
    emb = get_embedding_config()
    status["embedding_service"] = {
        "api_base": emb["api_base"],
        "endpoint": emb["endpoint"],
        "model": emb["model"],
        "expected_dim": emb["expected_dim"],
    }

    service = get_rag_service_config()
    rag_service: dict[str, Any] = {
        "enabled": service["enabled"],
        "endpoint": service["endpoint"],
        "health_endpoint": service["health_endpoint"],
        "timeout_seconds": service["timeout_seconds"],
        "topic_default": resolve_topic(None) or "(whole library)",
        "reachable": None,
    }
    if probe_remote and service["enabled"]:
        probe = remote_health(timeout=5.0)
        rag_service["reachable"] = probe["ok"]
        rag_service["health"] = probe.get("info")
        rag_service["error"] = probe.get("error", "")
    status["rag_service"] = rag_service
    status["active_backend"] = (
        "remote"
        if service["enabled"] and rag_service["reachable"] is not False
        else "local"
    )
    return status


def query_rag(
    *,
    query: str,
    top_k: int | None = None,
    min_score: float | None = None,
    prefer_lexical: bool = False,
    topic: str | None = None,
    store: RagStore | None = None,
) -> dict[str, Any]:
    """Return evidence chunks. Generation stays with the PilotDeck main model."""

    started = time.perf_counter()
    q = (query or "").strip()
    if not q:
        return _error_payload("query is empty")
    if len(q) > 50_000:
        return _error_payload("query exceeds 50000 characters")

    # Reads manifest.json only (cheap); does NOT load the 253 MB artifacts.
    store, manifest = _manifest_or_none(store)

    k = int(top_k if top_k is not None else _manifest_value(manifest, "default_top_k", DEFAULT_TOP_K))
    k = max(1, min(k, _manifest_value(manifest, "max_top_k", DEFAULT_MAX_TOP_K)))
    score_floor = float(
        min_score
        if min_score is not None
        else _manifest_value(manifest, "default_min_score", DEFAULT_MIN_SCORE)
    )

    warnings: list[str] = []
    service = get_rag_service_config()
    topic_sent = resolve_topic(topic)

    # ---- 1. remote rag service (default path) ----------------------------
    if service["enabled"] and not prefer_lexical:
        try:
            body = retrieve_remote(
                query=q,
                top_k=k,
                topic=topic_sent,
                timeout=service["timeout_seconds"],
                max_chars_per_chunk=service["max_chars_per_chunk"],
            )
            results = [r for r in (body.get("results") or []) if isinstance(r, Mapping)]
            items = [remote_result_to_item(r, i) for i, r in enumerate(results)]
            # A reranker makes the returned count independent of top_k; clamp to
            # what the caller asked for without inventing rows.
            items = items[:k]
            if not items:
                warnings.append(
                    "remote retrieval returned 0 chunks for "
                    f"topic={topic_sent or '(whole library)'}; "
                    "widen the topic (topic=\"\") or rewrite the query"
                )
            return _finalize(
                mode="remote",
                retrieval_backend="remote",
                items=items,
                query=q,
                top_k=k,
                # Remote scores are RRF fusion values (~0.01-0.03), not cosine.
                # Applying the local min_score here would discard every hit.
                min_score=None,
                topic=topic_sent,
                corpus_id=_manifest_value(manifest, "corpus_id", "war-trauma-remote"),
                corpus_version=_manifest_value(manifest, "version", None),
                embedding_model="remote-service",
                warnings=warnings,
                started=started,
                remote_endpoint=service["endpoint"],
            )
        except RagServiceError as exc:
            warnings.append(
                f"remote rag service unavailable ({str(exc)[:200]}); "
                "used local retrieval"
            )
            if topic_sent and topic_sent != DEFAULT_TOPIC:
                warnings.append(
                    f"local corpus is war-trauma only; topic={topic_sent} was not applied"
                )

    # ---- 2. local fallback (first touch of the 253 MB artifacts) ----------
    try:
        store = store or get_default_store()
        status = store.status(validate=True)
    except Exception as exc:  # noqa: BLE001
        status = {"ready": False, "reason": f"{type(exc).__name__}: {str(exc)[:300]}"}
    if not status.get("ready"):
        return {
            "status": "unavailable",
            "mode": "none",
            "error": status.get("reason") or "rag_artifacts_unavailable",
            "chunks": [],
            "warnings": warnings,
            "corpus": status,
            "generation_owner": "pilotdeck",
        }
    manifest = store.manifest

    mode = "vector"
    items: list[dict[str, Any]] = []
    if prefer_lexical:
        mode = "lexical"
        items = store.search_lexical(query=q, top_k=k)
    else:
        try:
            vectors = embed_texts([q])
            items = store.search_vector(
                query_vector=vectors[0],
                top_k=k,
                min_score=score_floor,
            )
            mode = "vector"
            if not items:
                warnings.append(
                    f"no chunk met min_score={score_floor}; consider lowering min_score"
                )
        except (EmbeddingError, OSError, ValueError) as exc:
            mode = "lexical-fallback"
            items = store.search_lexical(query=q, top_k=k)
            warnings.append(
                f"embedding unavailable ({type(exc).__name__}: {str(exc)[:200]}); "
                "used lexical-fallback"
            )

    return _finalize(
        mode=mode,
        retrieval_backend="local",
        items=items,
        query=q,
        top_k=k,
        min_score=score_floor if mode == "vector" else None,
        topic=None,
        corpus_id=manifest.corpus_id,
        corpus_version=manifest.version,
        embedding_model=(
            f"lexical-fallback:{manifest.embedding_model}"
            if mode.startswith("lexical")
            else get_embedding_config()["model"]
        ),
        warnings=warnings,
        started=started,
    )


def _manifest_or_none(store: RagStore | None) -> tuple[RagStore | None, Any]:
    """Resolve the store without loading artifacts; tolerate a missing manifest."""

    try:
        store = store or get_default_store()
        return store, store.manifest
    except Exception:  # noqa: BLE001 — remote-only deployments have no local corpus
        return None, None


def _manifest_value(manifest: Any, attribute: str, default: Any) -> Any:
    if manifest is None:
        return default
    value = getattr(manifest, attribute, None)
    return default if value is None else value


def _error_payload(error: str) -> dict[str, Any]:
    return {
        "status": "error",
        "mode": "none",
        "error": error,
        "chunks": [],
        "warnings": [],
        "generation_owner": "pilotdeck",
    }


def _finalize(
    *,
    mode: str,
    retrieval_backend: str,
    items: list[dict[str, Any]],
    query: str,
    top_k: int,
    min_score: float | None,
    topic: str | None,
    corpus_id: str,
    corpus_version: str | None,
    embedding_model: str,
    warnings: list[str],
    started: float,
    remote_endpoint: str | None = None,
) -> dict[str, Any]:
    for rank, item in enumerate(items, start=1):
        item["rank"] = rank

    query_id = hashlib.sha256(
        f"{corpus_id}\0{corpus_version}\0{mode}\0{topic}\0{query}".encode("utf-8")
    ).hexdigest()[:24]

    payload: dict[str, Any] = {
        "status": "ready",
        "mode": mode,
        "retrieval_backend": retrieval_backend,
        "query": query,
        "query_id": query_id,
        "corpus_id": corpus_id,
        "corpus_version": corpus_version,
        "embedding_model": embedding_model,
        "topic": topic,
        "top_k": top_k,
        "min_score": min_score,
        "chunk_count": len(items),
        "chunks": items,
        "warnings": warnings,
        "elapsed_ms": int((time.perf_counter() - started) * 1000),
        "generation_owner": "pilotdeck",
        "presentation": PRESENTATION,
    }
    if remote_endpoint:
        payload["remote_endpoint"] = remote_endpoint
    return payload
