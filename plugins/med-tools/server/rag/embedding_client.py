"""OpenAI-compatible embedding client for med-tools RAG."""

from __future__ import annotations

import os
from typing import Sequence

import httpx


class EmbeddingError(RuntimeError):
    pass


def get_embedding_config() -> dict[str, str | float | int | None]:
    api_base = (
        os.environ.get("MED_EMBEDDING_API_BASE", "").strip()
        or "http://127.0.0.1:65507/v1"
    ).rstrip("/")
    endpoint = os.environ.get("MED_EMBEDDING_ENDPOINT", "").strip()
    if not endpoint:
        endpoint = f"{api_base}/embeddings"
    model = os.environ.get("MED_EMBEDDING_MODEL", "").strip() or "qwen3-vl-embedding"
    api_key = os.environ.get("MED_EMBEDDING_API_KEY", "").strip() or "EMPTY"
    timeout = float(os.environ.get("MED_EMBEDDING_TIMEOUT_SECONDS", "30") or 30)
    expected_dim_raw = os.environ.get("MED_EMBEDDING_DIMENSION", "").strip()
    expected_dim = int(expected_dim_raw) if expected_dim_raw else None
    return {
        "api_base": api_base,
        "endpoint": endpoint,
        "model": model,
        "api_key": api_key,
        "timeout_seconds": timeout,
        "expected_dim": expected_dim,
    }


def embed_texts(texts: Sequence[str]) -> list[list[float]]:
    if not texts or len(texts) > 64:
        raise EmbeddingError("embedding request must contain between 1 and 64 texts")
    cfg = get_embedding_config()
    payload = {"model": cfg["model"], "input": list(texts)}
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": f"Bearer {cfg['api_key']}",
    }
    try:
        with httpx.Client(timeout=float(cfg["timeout_seconds"] or 30)) as client:
            response = client.post(str(cfg["endpoint"]), json=payload, headers=headers)
            response.raise_for_status()
            body = response.json()
    except Exception as exc:  # noqa: BLE001
        raise EmbeddingError(f"{type(exc).__name__}: {exc}") from exc

    vectors = _extract_vectors(body)
    if len(vectors) != len(texts):
        raise EmbeddingError("embedding response count does not match request count")
    expected = cfg.get("expected_dim")
    if expected:
        for vector in vectors:
            if len(vector) != int(expected):
                raise EmbeddingError(
                    f"embedding dimension {len(vector)} != expected {expected}"
                )
    return vectors


def _extract_vectors(body: object) -> list[list[float]]:
    if not isinstance(body, dict):
        raise EmbeddingError("embedding response is not a JSON object")
    if isinstance(body.get("embeddings"), list):
        raw = body["embeddings"]
    elif isinstance(body.get("data"), list):
        raw = [
            item.get("embedding")
            for item in body["data"]
            if isinstance(item, dict)
        ]
    else:
        raise EmbeddingError("embedding response lacks embeddings or data")
    vectors: list[list[float]] = []
    for item in raw:
        if not isinstance(item, list) or not item:
            raise EmbeddingError("embedding vector must be a non-empty array")
        vector = [float(value) for value in item]
        vectors.append(vector)
    return vectors
