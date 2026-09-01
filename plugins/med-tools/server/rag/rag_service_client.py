"""HTTP client for the standalone med-rag retrieval service (rag4medpilotdeck).

Mirrors ``embedding_client`` in shape: env-first ``get_*_config()``, a plain
``httpx.Client`` call, and one error type that the caller catches to degrade.

The service exposes ``POST /retrieve`` (evidence only, no generation) and
``GET /health``. Generation stays with the PilotDeck main model, so ``/ask``
is deliberately not used.
"""

from __future__ import annotations

import os
from typing import Any, Mapping

import httpx

DEFAULT_API_BASE = "http://127.0.0.1:18080"
DEFAULT_TOPIC = "战创伤"
DEFAULT_TIMEOUT_SECONDS = 60.0
DEFAULT_MAX_CHARS_PER_CHUNK = 1800

# Any of these (case-insensitive) means "search the whole library, no filter".
WHOLE_LIBRARY_SENTINELS = {"", "全库", "all", "*", "__all__"}

_TRUTHY = {"1", "true", "yes", "on"}


class RagServiceError(RuntimeError):
    pass


def get_rag_service_config() -> dict[str, Any]:
    api_base = (
        os.environ.get("MED_RAG_SERVICE_API_BASE", "").strip() or DEFAULT_API_BASE
    ).rstrip("/")
    endpoint = os.environ.get("MED_RAG_SERVICE_ENDPOINT", "").strip()
    if not endpoint:
        endpoint = f"{api_base}/retrieve"
    health_endpoint = os.environ.get("MED_RAG_SERVICE_HEALTH_ENDPOINT", "").strip()
    if not health_endpoint:
        health_endpoint = f"{api_base}/health"
    enabled = (
        os.environ.get("MED_RAG_SERVICE_ENABLED", "1").strip().lower() in _TRUTHY
    )
    timeout = float(
        os.environ.get("MED_RAG_SERVICE_TIMEOUT_SECONDS", "").strip()
        or DEFAULT_TIMEOUT_SECONDS
    )
    max_chars = int(
        os.environ.get("MED_RAG_SERVICE_MAX_CHARS_PER_CHUNK", "").strip()
        or DEFAULT_MAX_CHARS_PER_CHUNK
    )
    api_key = os.environ.get("MED_RAG_SERVICE_API_KEY", "").strip()
    return {
        "enabled": enabled,
        "api_base": api_base,
        "endpoint": endpoint,
        "health_endpoint": health_endpoint,
        "timeout_seconds": timeout,
        "max_chars_per_chunk": max_chars,
        "api_key": api_key,
    }


def resolve_topic(topic_arg: str | None) -> str:
    """Normalize the three topic states into the value to put on the wire.

    ``None`` (caller said nothing) falls back to ``MED_RAG_TOPIC``; an unset
    env var means the war-trauma default. Sentinels collapse to ``""``, which
    the service reads as "no topic filter".
    """

    if topic_arg is None:
        raw = os.environ.get("MED_RAG_TOPIC")
        # Distinguish "unset" (use default) from "set to empty" (whole library).
        topic_arg = DEFAULT_TOPIC if raw is None else raw
    topic = topic_arg.strip()
    if topic.lower() in WHOLE_LIBRARY_SENTINELS:
        return ""
    return topic


def retrieve_remote(
    *,
    query: str,
    top_k: int,
    topic: str,
    timeout: float | None = None,
    max_chars_per_chunk: int | None = None,
) -> dict[str, Any]:
    """POST /retrieve and return the parsed body. Raises RagServiceError."""

    cfg = get_rag_service_config()
    q = (query or "").strip()
    if not q:
        # Catch it here rather than letting the service answer 422.
        raise RagServiceError("query is empty")

    # `topic` is always sent explicitly: "" is the documented whole-library
    # value, whereas omitting the field leaves us at the service's mercy.
    payload = {
        "query": q,
        "top_k": int(top_k),
        "topic": topic,
        "max_chars_per_chunk": int(
            max_chars_per_chunk
            if max_chars_per_chunk is not None
            else cfg["max_chars_per_chunk"]
        ),
    }
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if cfg["api_key"]:
        headers["Authorization"] = f"Bearer {cfg['api_key']}"

    try:
        with httpx.Client(
            timeout=float(timeout if timeout is not None else cfg["timeout_seconds"])
        ) as client:
            response = client.post(
                str(cfg["endpoint"]), json=payload, headers=headers
            )
            response.raise_for_status()
            body = response.json()
    except httpx.HTTPStatusError as exc:
        raise RagServiceError(
            f"HTTP {exc.response.status_code}: {_safe_detail(exc.response)}"
        ) from exc
    except Exception as exc:  # noqa: BLE001 — timeouts, DNS, bad JSON, ...
        raise RagServiceError(f"{type(exc).__name__}: {exc}") from exc

    if not isinstance(body, dict) or not isinstance(body.get("results"), list):
        raise RagServiceError("remote response lacks results[]")
    return body


def remote_result_to_item(result: Mapping[str, Any], index: int) -> dict[str, Any]:
    """Adapt one remote result to the local chunk item shape.

    Every key produced by ``store._chunk_to_item`` is kept so the skill and the
    main model see one schema regardless of backend; the remote-only evidence
    fields are added on top.
    """

    text = str(result.get("text") or "")[:20_000]
    preamble_volume, preamble_section = _split_preamble(text)
    # The remote corpus ships an empty `section_title` and puts the chapter
    # path in the body preamble instead; recover it so citations keep context.
    section = str(result.get("section_title") or "").strip() or preamble_section
    item: dict[str, Any] = {
        "rank": None,  # filled by the caller, same as the local path
        "score": _safe_score(result.get("score")),
        "chunk_id": str(result.get("chunk_id") or f"remote-{index:08d}"),
        "doc_id": str(result.get("doc_id") or "")[:500],
        "title": str(result.get("title") or "")[:500],
        "volume": preamble_volume[:200],
        "section": section[:1000],
        "source": "",  # remote corpus has no source_file field
        "text": text,
        "preview": " ".join(text.split())[:500],
        "index": index,
        # Remote-only evidence metadata — useful for medical citations.
        "topic": str(result.get("topic") or ""),
        "data_layer": str(result.get("data_layer") or ""),
        "evidence_grade": str(result.get("evidence_grade") or ""),
        "evidence_quality": str(result.get("evidence_quality") or ""),
        "evidence_ids": result.get("evidence_ids") or [],
        "retrieval_blocked_by_assets": bool(
            result.get("retrieval_blocked_by_assets")
        ),
        "image_refs": result.get("image_refs") or [],
    }
    # Only present when the service runs a reranker — never assume.
    if "rerank_score" in result:
        item["rerank_score"] = _safe_score(result.get("rerank_score"))
    if "rerank_rank" in result:
        item["rerank_rank"] = result.get("rerank_rank")
    return item


_VOLUME_PREFIX = "卷："
_SECTION_PREFIX = "章节："


def _split_preamble(text: str) -> tuple[str, str]:
    """Read the leading ``卷：`` / ``章节：`` header lines of a remote chunk.

    Only the header block is scanned: the body repeats chapter paths as
    ``【章节：...】`` markers, which must not be mistaken for the preamble.
    The text itself is left untouched — this only recovers metadata.
    """

    volume = ""
    section = ""
    for raw in text.split("\n")[:4]:
        line = raw.strip()
        if not line:
            continue  # blank separator between preamble and body
        if line.startswith(_VOLUME_PREFIX):
            volume = line[len(_VOLUME_PREFIX) :].strip()
        elif line.startswith(_SECTION_PREFIX):
            section = line[len(_SECTION_PREFIX) :].strip()
        else:
            break  # body has started
    return volume, section


def remote_health(*, timeout: float = 5.0) -> dict[str, Any]:
    """Probe GET /health. Never raises — returns ok/error/info."""

    cfg = get_rag_service_config()
    if not cfg["enabled"]:
        return {"ok": False, "error": "disabled", "info": None}
    headers = {"Accept": "application/json"}
    if cfg["api_key"]:
        headers["Authorization"] = f"Bearer {cfg['api_key']}"
    try:
        with httpx.Client(timeout=timeout) as client:
            response = client.get(str(cfg["health_endpoint"]), headers=headers)
            response.raise_for_status()
            return {"ok": True, "error": "", "info": response.json()}
    except Exception as exc:  # noqa: BLE001 — probe must never raise
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}", "info": None}


def _safe_score(value: object) -> float:
    import math

    try:
        score = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0.0
    return round(score, 6) if math.isfinite(score) else 0.0


def _safe_detail(response: httpx.Response) -> str:
    try:
        body = response.json()
    except Exception:  # noqa: BLE001
        return response.text[:200]
    if isinstance(body, dict) and body.get("detail") is not None:
        return str(body["detail"])[:200]
    return str(body)[:200]
