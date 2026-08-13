"""Versioned RAG contracts and a dependency-free cosine retrieval reference."""

from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import math
from typing import Any, Iterable, Mapping, Sequence


@dataclass(frozen=True)
class RagQuery:
    query: str
    corpus_id: str
    top_k: int = 3
    min_score: float = 0.75
    filters: Mapping[str, str] = field(default_factory=dict)

    def validate(self, *, max_top_k: int = 8) -> "RagQuery":
        if not self.query.strip():
            raise ValueError("rag query cannot be empty")
        if len(self.query) > 10_000:
            raise ValueError("rag query exceeds 10000 characters")
        if not self.corpus_id.strip():
            raise ValueError("corpus_id cannot be empty")
        if not 1 <= self.top_k <= max_top_k:
            raise ValueError(f"top_k must be between 1 and {max_top_k}")
        if not 0.0 <= self.min_score <= 1.0:
            raise ValueError("min_score must be between 0 and 1")
        if len(self.filters) > 32:
            raise ValueError("rag filters cannot exceed 32 fields")
        for key, value in self.filters.items():
            if not isinstance(key, str) or not isinstance(value, str):
                raise ValueError("rag filter keys and values must be strings")
            if not key or len(key) > 100 or len(value) > 500:
                raise ValueError("rag filter key or value exceeds the contract budget")
        return self


@dataclass(frozen=True)
class CorpusDescriptor:
    corpus_id: str
    version: str
    corpus_sha256: str
    embedding_model: str
    embedding_dimension: int
    created_at: str
    license_id: str

    def validate(self) -> "CorpusDescriptor":
        if not self.corpus_id or not self.version:
            raise ValueError("corpus_id and version are required")
        if len(self.corpus_sha256) != 64 or any(c not in "0123456789abcdefABCDEF" for c in self.corpus_sha256):
            raise ValueError("corpus_sha256 must be a SHA-256 hex digest")
        if not self.embedding_model or self.embedding_dimension <= 0:
            raise ValueError("embedding model and positive dimension are required")
        if not self.license_id:
            raise ValueError("license_id is required before a corpus can be enabled")
        return self


@dataclass(frozen=True)
class RagSource:
    source_id: str
    chunk_id: str
    score: float
    chunk: str
    title: str = ""
    section: str = ""
    source: str = ""
    preview: str = ""
    metadata: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.source_id or not self.chunk_id:
            raise ValueError("source_id and chunk_id are required")
        if not math.isfinite(self.score) or not -1.0 <= self.score <= 1.0:
            raise ValueError("score must be finite and within [-1, 1]")
        if len(self.preview) > 4000:
            raise ValueError("preview exceeds 4000 characters")

    def to_dict(self) -> dict[str, Any]:
        return {
            "source_id": self.source_id,
            "chunk_id": self.chunk_id,
            "score": round(self.score, 8),
            "chunk": self.chunk,
            "title": self.title,
            "section": self.section,
            "source": self.source,
            "preview": self.preview or self.chunk[:500],
            "metadata": dict(self.metadata),
        }


@dataclass(frozen=True)
class RagResult:
    query_id: str
    corpus_id: str
    corpus_version: str
    embedding_model: str
    items: tuple[RagSource, ...]
    warnings: tuple[str, ...] = ()
    schema_version: int = 1

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "query_id": self.query_id,
            "corpus_id": self.corpus_id,
            "corpus_version": self.corpus_version,
            "embedding_model": self.embedding_model,
            "items": [item.to_dict() for item in self.items],
            "warnings": list(self.warnings),
        }


@dataclass(frozen=True)
class VectorRecord:
    source_id: str
    chunk_id: str
    vector: Sequence[float]
    chunk: str
    title: str = ""
    section: str = ""
    source: str = ""
    metadata: Mapping[str, Any] = field(default_factory=dict)


def cosine_similarity(left: Sequence[float], right: Sequence[float]) -> float:
    if len(left) != len(right) or not left:
        raise ValueError("vectors must have the same non-zero dimension")
    dot = 0.0
    left_norm = 0.0
    right_norm = 0.0
    for a_raw, b_raw in zip(left, right, strict=True):
        a = float(a_raw)
        b = float(b_raw)
        if not math.isfinite(a) or not math.isfinite(b):
            raise ValueError("vectors must contain only finite numbers")
        dot += a * b
        left_norm += a * a
        right_norm += b * b
    if left_norm == 0.0 or right_norm == 0.0:
        return 0.0
    score = dot / math.sqrt(left_norm * right_norm)
    return max(-1.0, min(1.0, score))


def retrieve(
    query: RagQuery,
    query_vector: Sequence[float],
    records: Iterable[VectorRecord],
    *,
    corpus_version: str,
    embedding_model: str,
) -> RagResult:
    """Retrieve from already-loaded records; this function never contacts a model."""

    query.validate()
    ranked: list[RagSource] = []
    for record in records:
        if query.filters and any(str(record.metadata.get(key, "")) != value for key, value in query.filters.items()):
            continue
        score = cosine_similarity(query_vector, record.vector)
        if score < query.min_score:
            continue
        ranked.append(
            RagSource(
                source_id=record.source_id,
                chunk_id=record.chunk_id,
                score=score,
                chunk=record.chunk,
                title=record.title,
                section=record.section,
                source=record.source,
                preview=record.chunk[:500],
                metadata=record.metadata,
            )
        )
    ranked.sort(key=lambda item: (-item.score, item.source_id, item.chunk_id))
    query_id = hashlib.sha256(
        f"{query.corpus_id}\0{corpus_version}\0{query.query}".encode("utf-8")
    ).hexdigest()[:24]
    return RagResult(
        query_id=query_id,
        corpus_id=query.corpus_id,
        corpus_version=corpus_version,
        embedding_model=embedding_model,
        items=tuple(ranked[: query.top_k]),
        warnings=(() if ranked else ("no source met the score threshold",)),
    )

