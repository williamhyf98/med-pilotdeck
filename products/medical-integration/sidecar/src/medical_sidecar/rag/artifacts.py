"""Validated JSONL + NPY RAG artifacts with lazy row reads."""

from __future__ import annotations

import hashlib
import heapq
import json
import math
from pathlib import Path
import re
import threading
from typing import Any, Mapping, Sequence

from ..config import RagLimits
from ..ingestion.contracts import resolve_under_root
from ..npy import NpyArray
from .contracts import RagQuery, RagResult, RagSource


class RagUnavailableError(RuntimeError):
    pass


class RagArtifactLoader:
    def __init__(self, settings: RagLimits, *, data_root: str | None = None):
        self.settings = settings
        self.data_root = data_root
        self._lock = threading.Lock()
        self._chunks: list[dict[str, Any]] | None = None
        self._matrix: NpyArray | None = None

    def status(self, *, validate: bool = False) -> dict[str, Any]:
        if not self.settings.configured:
            return {
                "id": self.settings.corpus_id,
                "name": "战创伤教材",
                "description": "未配置版本化 JSONL corpus 与 NPY embedding artifact。",
                "ready": False,
                "documentCount": 0,
                "reason": "corpus_not_configured",
            }
        if validate:
            try:
                self._ensure_loaded()
            except (OSError, ValueError, RagUnavailableError) as exc:
                return {
                    "id": self.settings.corpus_id,
                    "name": self.settings.corpus_id,
                    "description": "RAG artifact 校验失败。",
                    "ready": False,
                    "documentCount": 0,
                    "reason": "artifact_validation_failed",
                    "error": _safe_error(
                        exc,
                        self.settings.corpus_path,
                        self.settings.embedding_path,
                    ),
                }
        matrix = self._matrix
        chunks = self._chunks
        return {
            "id": self.settings.corpus_id,
            "name": self.settings.corpus_id,
            "description": "已配置版本化 JSONL corpus 与 NPY embedding artifact。",
            "ready": bool(matrix is not None and chunks is not None),
            "documentCount": len(chunks or []),
            "version": self.settings.version,
            "embeddingModel": self.settings.embedding_model,
            "dimension": matrix.shape[1] if matrix is not None else None,
            "licenseId": self.settings.license_id,
            "corpusSha256": self.settings.corpus_sha256,
            "embeddingSha256": self.settings.embedding_sha256,
            "reason": None if matrix is not None and chunks is not None else "not_loaded",
        }

    def search(
        self,
        *,
        query_vector: Sequence[float],
        query: RagQuery,
    ) -> RagResult:
        query.validate(max_top_k=self.settings.max_top_k)
        if query.corpus_id != self.settings.corpus_id:
            raise ValueError(f"unknown corpus_id: {query.corpus_id}")
        try:
            self._ensure_loaded()
        except (OSError, ValueError) as exc:
            raise RagUnavailableError(
                _safe_error(
                    exc,
                    self.settings.corpus_path,
                    self.settings.embedding_path,
                )
            ) from exc
        assert self._chunks is not None
        assert self._matrix is not None
        dimension = self._matrix.shape[1]
        vector = tuple(float(value) for value in query_vector)
        if len(vector) != dimension:
            raise ValueError(f"query_vector dimension must be {dimension}")
        if any(not math.isfinite(value) for value in vector):
            raise ValueError("query_vector contains non-finite values")
        query_norm = math.sqrt(sum(value * value for value in vector))
        if query_norm == 0:
            raise ValueError("query_vector norm cannot be zero")

        candidates: list[tuple[float, int]] = []
        for index, (chunk, row) in enumerate(
            zip(self._chunks, self._matrix.iter_rows(), strict=True)
        ):
            if query.filters and not _matches_filters(chunk, query.filters):
                continue
            row_norm = math.sqrt(sum(value * value for value in row))
            score = 0.0 if row_norm == 0 else sum(
                left * right for left, right in zip(vector, row, strict=True)
            ) / (query_norm * row_norm)
            if score < query.min_score:
                continue
            item = (score, index)
            if len(candidates) < query.top_k:
                heapq.heappush(candidates, item)
            elif item > candidates[0]:
                heapq.heapreplace(candidates, item)

        ranked = sorted(candidates, key=lambda item: (-item[0], item[1]))
        sources = tuple(
            _source_from_chunk(self._chunks[index], score, index)
            for score, index in ranked
        )
        query_id = hashlib.sha256(
            f"{query.corpus_id}\0{self.settings.version}\0{query.query}".encode("utf-8")
        ).hexdigest()[:24]
        return RagResult(
            query_id=query_id,
            corpus_id=self.settings.corpus_id,
            corpus_version=self.settings.version,
            embedding_model=self.settings.embedding_model,
            items=sources,
            warnings=(() if sources else ("no source met the score threshold",)),
        )

    def search_lexical(self, *, query: RagQuery) -> RagResult:
        """Deterministic offline fallback when the matching embedding service is unavailable."""

        query.validate(max_top_k=self.settings.max_top_k)
        if query.corpus_id != self.settings.corpus_id:
            raise ValueError(f"unknown corpus_id: {query.corpus_id}")
        self._ensure_loaded()
        assert self._chunks is not None
        tokens = _lexical_tokens(query.query)
        if not tokens:
            raise ValueError("rag query has no searchable terms")
        ranked: list[tuple[float, int]] = []
        normalized_query = " ".join(query.query.lower().split())
        for index, chunk in enumerate(self._chunks):
            if query.filters and not _matches_filters(chunk, query.filters):
                continue
            searchable = " ".join(
                str(chunk.get(key, ""))
                for key in ("title", "chapter_path", "contents", "text")
            ).lower()
            matched = sum(1 for token in tokens if token in searchable)
            score = matched / len(tokens)
            if normalized_query and normalized_query in " ".join(searchable.split()):
                score = max(score, 0.95)
            if score <= 0:
                continue
            item = (score, index)
            if len(ranked) < query.top_k:
                heapq.heappush(ranked, item)
            elif item > ranked[0]:
                heapq.heapreplace(ranked, item)
        ordered = sorted(ranked, key=lambda item: (-item[0], item[1]))
        sources = tuple(
            _source_from_chunk(self._chunks[index], score, index)
            for score, index in ordered
        )
        query_id = hashlib.sha256(
            f"{query.corpus_id}\0{self.settings.version}\0lexical\0{query.query}".encode("utf-8")
        ).hexdigest()[:24]
        return RagResult(
            query_id=query_id,
            corpus_id=query.corpus_id,
            corpus_version=self.settings.version,
            embedding_model=f"lexical-fallback:{self.settings.embedding_model}",
            items=sources,
            warnings=(
                "embedding service unavailable; used deterministic lexical fallback",
            ) if sources else (
                "embedding service unavailable; lexical fallback found no matching source",
            ),
        )

    def _ensure_loaded(self) -> None:
        if self._chunks is not None and self._matrix is not None:
            return
        if not self.settings.configured:
            raise RagUnavailableError("RAG artifacts are not configured")
        with self._lock:
            if self._chunks is not None and self._matrix is not None:
                return
            corpus_path = self._artifact_path(self.settings.corpus_path or "")
            embedding_path = self._artifact_path(self.settings.embedding_path or "")
            if corpus_path.stat().st_size > self.settings.max_corpus_bytes:
                raise ValueError("corpus artifact exceeds the configured byte limit")
            if embedding_path.stat().st_size > self.settings.max_embedding_bytes:
                raise ValueError("embedding artifact exceeds the configured byte limit")
            if _sha256_file(corpus_path) != self.settings.corpus_sha256:
                raise ValueError("corpus SHA-256 does not match configuration")
            if _sha256_file(embedding_path) != self.settings.embedding_sha256:
                raise ValueError("embedding SHA-256 does not match configuration")

            matrix = NpyArray.from_path(
                embedding_path,
                max_items=self.settings.max_rows * self.settings.max_dimension,
                max_dimensions=2,
            )
            if len(matrix.shape) != 2:
                raise ValueError("embedding artifact must be a 2D matrix")
            rows, dimension = matrix.shape
            if rows > self.settings.max_rows:
                raise ValueError("embedding row count exceeds the configured limit")
            if dimension > self.settings.max_dimension:
                raise ValueError("embedding dimension exceeds the configured limit")
            chunks = _load_jsonl(corpus_path, max_rows=self.settings.max_rows)
            if len(chunks) != rows:
                raise ValueError(
                    f"corpus line count {len(chunks)} does not match embedding rows {rows}"
                )
            self._matrix = matrix
            self._chunks = chunks

    def _artifact_path(self, configured_path: str) -> Path:
        if self.data_root:
            return resolve_under_root(
                self.data_root,
                configured_path,
                must_exist=True,
            )
        # Backward-compatible programmatic configuration for trusted test and
        # embedding pipelines. YAML deployments should always set data.root.
        return Path(configured_path).expanduser().resolve(strict=True)


def _load_jsonl(path: Path, *, max_rows: int) -> list[dict[str, Any]]:
    chunks: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as stream:
        for line_number, raw in enumerate(stream, start=1):
            if len(raw) > 1_048_576:
                raise ValueError(f"corpus line {line_number} exceeds 1 MiB")
            line = raw.strip()
            if not line:
                continue
            if len(chunks) >= max_rows:
                raise ValueError("corpus line count exceeds the configured limit")
            try:
                item = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"corpus line {line_number} is invalid JSON") from exc
            if not isinstance(item, dict):
                raise ValueError(f"corpus line {line_number} must be an object")
            text = item.get("contents", item.get("text"))
            if not isinstance(text, str) or not text.strip():
                raise ValueError(f"corpus line {line_number} has no text")
            normalized = dict(item)
            normalized.setdefault("chunk_id", f"chunk-{line_number:08d}")
            chunks.append(normalized)
    if not chunks:
        raise ValueError("corpus artifact contains no records")
    return chunks


def _source_from_chunk(chunk: Mapping[str, Any], score: float, index: int) -> RagSource:
    text = str(chunk.get("contents", chunk.get("text", "")))[:50_000]
    source_raw = str(chunk.get("source_file", chunk.get("source", "")))
    source = Path(source_raw.replace("\\", "/")).name[:500]
    title = str(chunk.get("title", chunk.get("volume", "")))[:500]
    source_id = str(chunk.get("source_id") or source or title or "corpus")[:500]
    section = str(chunk.get("section", chunk.get("chapter_path", "")))[:1_000]
    nested = chunk.get("metadata")
    metadata = _public_metadata(nested if isinstance(nested, Mapping) else {})
    return RagSource(
        source_id=source_id,
        chunk_id=str(chunk.get("chunk_id") or f"chunk-{index:08d}"),
        score=score,
        chunk=text,
        title=title,
        section=section,
        source=source,
        preview=" ".join(text.split())[:500],
        metadata=metadata,
    )


def _public_metadata(metadata: Mapping[str, Any]) -> dict[str, Any]:
    public: dict[str, Any] = {}
    for key, value in list(metadata.items())[:50]:
        normalized = str(key)[:100]
        if any(token in normalized.lower() for token in ("path", "secret", "token", "key")):
            continue
        if isinstance(value, float) and not math.isfinite(value):
            continue
        if value is None or isinstance(value, (bool, int, float)):
            public[normalized] = value
        elif isinstance(value, str):
            public[normalized] = value[:500]
    return public


def _matches_filters(chunk: Mapping[str, Any], filters: Mapping[str, str]) -> bool:
    metadata = chunk.get("metadata")
    nested = metadata if isinstance(metadata, Mapping) else {}
    return all(
        str(chunk.get(key, nested.get(key, ""))) == value
        for key, value in filters.items()
    )


def _lexical_tokens(query: str) -> tuple[str, ...]:
    tokens: list[str] = []
    for raw in re.findall(r"[a-zA-Z0-9_.-]+|[\u4e00-\u9fff]+", query.lower()):
        if re.fullmatch(r"[\u4e00-\u9fff]+", raw) and len(raw) > 2:
            tokens.extend(raw[index : index + 2] for index in range(len(raw) - 1))
        else:
            tokens.append(raw)
    return tuple(dict.fromkeys(token for token in tokens if token))


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _safe_error(error: Exception, *paths: str | None) -> str:
    if isinstance(error, OSError):
        return f"{type(error).__name__}: artifact file is missing or unreadable"
    message = str(error)
    # Never return configured local paths in status responses.
    for path in paths:
        if path:
            message = message.replace(str(path), "[artifact]")
    return f"{type(error).__name__}: {message[:300]}"

