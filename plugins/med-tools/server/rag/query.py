"""Query helpers: vector search with lexical fallback."""

from __future__ import annotations

import hashlib
import time
from typing import Any

from .embedding_client import EmbeddingError, embed_texts, get_embedding_config
from .store import RagStore, get_default_store


def rag_status(*, validate: bool = False, store: RagStore | None = None) -> dict[str, Any]:
    store = store or get_default_store()
    status = store.status(validate=validate)
    emb = get_embedding_config()
    status["embedding_service"] = {
        "api_base": emb["api_base"],
        "endpoint": emb["endpoint"],
        "model": emb["model"],
        "expected_dim": emb["expected_dim"],
    }
    status["plugin_data_root"] = str(store.manifest.root)
    return status


def query_rag(
    *,
    query: str,
    top_k: int | None = None,
    min_score: float | None = None,
    prefer_lexical: bool = False,
    store: RagStore | None = None,
) -> dict[str, Any]:
    """Return evidence chunks. Generation stays with the PilotDeck main model."""

    started = time.perf_counter()
    store = store or get_default_store()
    manifest = store.manifest
    q = (query or "").strip()
    if not q:
        return {
            "status": "error",
            "mode": "none",
            "error": "query is empty",
            "chunks": [],
            "warnings": [],
            "generation_owner": "pilotdeck",
        }
    if len(q) > 50_000:
        return {
            "status": "error",
            "mode": "none",
            "error": "query exceeds 50000 characters",
            "chunks": [],
            "warnings": [],
            "generation_owner": "pilotdeck",
        }

    k = int(top_k if top_k is not None else manifest.default_top_k)
    k = max(1, min(k, manifest.max_top_k))
    score_floor = float(
        min_score if min_score is not None else manifest.default_min_score
    )

    status = store.status(validate=True)
    if not status.get("ready"):
        return {
            "status": "unavailable",
            "mode": "none",
            "error": status.get("reason") or "rag_artifacts_unavailable",
            "chunks": [],
            "warnings": [],
            "corpus": status,
            "generation_owner": "pilotdeck",
        }

    warnings: list[str] = []
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

    for rank, item in enumerate(items, start=1):
        item["rank"] = rank

    query_id = hashlib.sha256(
        f"{manifest.corpus_id}\0{manifest.version}\0{mode}\0{q}".encode("utf-8")
    ).hexdigest()[:24]

    elapsed_ms = int((time.perf_counter() - started) * 1000)
    return {
        "status": "ready",
        "mode": mode,
        "query": q,
        "query_id": query_id,
        "corpus_id": manifest.corpus_id,
        "corpus_version": manifest.version,
        "embedding_model": (
            f"lexical-fallback:{manifest.embedding_model}"
            if mode.startswith("lexical")
            else get_embedding_config()["model"]
        ),
        "top_k": k,
        "min_score": score_floor if mode == "vector" else None,
        "chunk_count": len(items),
        "chunks": items,
        "warnings": warnings,
        "elapsed_ms": elapsed_ms,
        "generation_owner": "pilotdeck",
        "presentation": (
            "工具只返回检索证据。请由主模型基于 chunks 撰写综合救治辅助方案，"
            "区分「所见/用户陈述」与「检索文献」，并注明来源；不得编造未检索到的条文。"
            "输出仅供辅助，须医务人员复核。"
        ),
    }
