"""Load versioned war-trauma JSONL + NPY artifacts from plugins/med-tools/data/rag."""

from __future__ import annotations

import hashlib
import json
import math
import os
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np

PLUGIN_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_RAG_ROOT = PLUGIN_ROOT / "data" / "rag"
DEFAULT_MANIFEST = DEFAULT_RAG_ROOT / "manifest.json"


class RagUnavailableError(RuntimeError):
    pass


@dataclass(frozen=True)
class RagManifest:
    corpus_id: str
    name: str
    version: str
    license_id: str
    embedding_model: str
    dimension: int
    row_count: int
    corpus_path: Path
    embedding_path: Path
    corpus_sha256: str
    embedding_sha256: str
    default_top_k: int
    max_top_k: int
    default_min_score: float
    root: Path

    @classmethod
    def load(cls, manifest_path: Path | None = None) -> "RagManifest":
        path = (manifest_path or _manifest_path_from_env()).expanduser().resolve()
        if not path.is_file():
            raise RagUnavailableError(f"RAG manifest missing: {path}")
        raw = json.loads(path.read_text(encoding="utf-8"))
        root = path.parent
        return cls(
            corpus_id=str(raw.get("corpus_id") or "war-trauma"),
            name=str(raw.get("name") or "war-trauma"),
            version=str(raw.get("version") or ""),
            license_id=str(raw.get("license_id") or ""),
            embedding_model=str(raw.get("embedding_model") or ""),
            dimension=int(raw.get("dimension") or 0),
            row_count=int(raw.get("row_count") or 0),
            corpus_path=_resolve_under(root, str(raw["corpus_path"])),
            embedding_path=_resolve_under(root, str(raw["embedding_path"])),
            corpus_sha256=str(raw.get("corpus_sha256") or ""),
            embedding_sha256=str(raw.get("embedding_sha256") or ""),
            default_top_k=int(raw.get("default_top_k") or 3),
            max_top_k=int(raw.get("max_top_k") or 8),
            default_min_score=float(raw.get("default_min_score") or 0.35),
            root=root,
        )


class RagStore:
    """Lazy-loaded corpus + embedding matrix."""

    def __init__(self, manifest: RagManifest):
        self.manifest = manifest
        self._lock = threading.Lock()
        self._chunks: list[dict[str, Any]] | None = None
        self._matrix: np.ndarray | None = None

    def status(self, *, validate: bool = False) -> dict[str, Any]:
        base = {
            "corpus_id": self.manifest.corpus_id,
            "name": self.manifest.name,
            "version": self.manifest.version,
            "license_id": self.manifest.license_id,
            "embedding_model": self.manifest.embedding_model,
            "dimension": self.manifest.dimension,
            "expected_rows": self.manifest.row_count,
            "ready": False,
            "loaded": False,
            "document_count": 0,
            "reason": None,
        }
        try:
            if validate or self._chunks is None:
                self._ensure_loaded()
            assert self._chunks is not None and self._matrix is not None
            base.update(
                {
                    "ready": True,
                    "loaded": True,
                    "document_count": len(self._chunks),
                    "dimension": int(self._matrix.shape[1]),
                    "reason": None,
                }
            )
        except Exception as exc:  # noqa: BLE001 — status must never raise
            base["ready"] = False
            base["reason"] = f"{type(exc).__name__}: {str(exc)[:300]}"
        return base

    def search_vector(
        self,
        *,
        query_vector: Sequence[float],
        top_k: int,
        min_score: float,
    ) -> list[dict[str, Any]]:
        self._ensure_loaded()
        assert self._chunks is not None and self._matrix is not None
        vector = np.asarray(list(query_vector), dtype=np.float32)
        if vector.ndim != 1 or vector.shape[0] != self._matrix.shape[1]:
            raise ValueError(
                f"query_vector dimension must be {self._matrix.shape[1]}, got {vector.shape}"
            )
        if not np.all(np.isfinite(vector)):
            raise ValueError("query_vector contains non-finite values")
        q_norm = float(np.linalg.norm(vector))
        if q_norm == 0:
            raise ValueError("query_vector norm cannot be zero")
        # Cosine similarity against L2-normalized rows (or raw with row norms).
        matrix = self._matrix
        # Use float64 accumulator for stability on large dims.
        dots = matrix.astype(np.float64, copy=False) @ vector.astype(np.float64)
        row_norms = np.linalg.norm(matrix.astype(np.float64, copy=False), axis=1)
        scores = np.zeros(matrix.shape[0], dtype=np.float64)
        nonzero = row_norms > 0
        scores[nonzero] = dots[nonzero] / (row_norms[nonzero] * q_norm)

        top_k = max(1, min(int(top_k), self.manifest.max_top_k, matrix.shape[0]))
        # argpartition then sort
        if top_k >= matrix.shape[0]:
            indices = np.argsort(-scores)
        else:
            candidate = np.argpartition(-scores, top_k - 1)[:top_k]
            indices = candidate[np.argsort(-scores[candidate])]

        items: list[dict[str, Any]] = []
        for index in indices:
            score = float(scores[int(index)])
            if score < min_score:
                continue
            items.append(_chunk_to_item(self._chunks[int(index)], score, int(index)))
            if len(items) >= top_k:
                break
        return items

    def search_lexical(self, *, query: str, top_k: int) -> list[dict[str, Any]]:
        self._ensure_loaded()
        assert self._chunks is not None
        tokens = _lexical_tokens(query)
        if not tokens:
            raise ValueError("rag query has no searchable terms")
        top_k = max(1, min(int(top_k), self.manifest.max_top_k))
        normalized_query = " ".join(query.lower().split())
        ranked: list[tuple[float, int]] = []
        for index, chunk in enumerate(self._chunks):
            searchable = " ".join(
                str(chunk.get(key, ""))
                for key in ("title", "chapter_path", "contents", "text", "content")
            ).lower()
            matched = sum(1 for token in tokens if token in searchable)
            score = matched / len(tokens)
            if normalized_query and normalized_query in " ".join(searchable.split()):
                score = max(score, 0.95)
            if score <= 0:
                continue
            ranked.append((score, index))
        ranked.sort(key=lambda item: (-item[0], item[1]))
        return [
            _chunk_to_item(self._chunks[index], score, index)
            for score, index in ranked[:top_k]
        ]

    def _ensure_loaded(self) -> None:
        if self._chunks is not None and self._matrix is not None:
            return
        with self._lock:
            if self._chunks is not None and self._matrix is not None:
                return
            corpus_path = self.manifest.corpus_path
            embedding_path = self.manifest.embedding_path
            if not corpus_path.is_file() or not embedding_path.is_file():
                raise RagUnavailableError("RAG corpus or embedding file is missing")
            if self.manifest.corpus_sha256:
                actual = _sha256_file(corpus_path)
                if actual != self.manifest.corpus_sha256:
                    raise ValueError("corpus SHA-256 does not match manifest")
            if self.manifest.embedding_sha256:
                actual = _sha256_file(embedding_path)
                if actual != self.manifest.embedding_sha256:
                    raise ValueError("embedding SHA-256 does not match manifest")

            matrix = np.load(embedding_path, mmap_mode="r")
            if not isinstance(matrix, np.ndarray) or matrix.ndim != 2:
                raise ValueError("embedding artifact must be a 2D matrix")
            # Materialize to RAM for fast repeated queries (≈130 MiB).
            matrix = np.asarray(matrix, dtype=np.float32)
            chunks = _load_jsonl(corpus_path, max_rows=max(self.manifest.row_count, 1_000_000))
            if len(chunks) != matrix.shape[0]:
                raise ValueError(
                    f"corpus line count {len(chunks)} does not match embedding rows {matrix.shape[0]}"
                )
            if self.manifest.dimension and matrix.shape[1] != self.manifest.dimension:
                raise ValueError(
                    f"embedding dimension {matrix.shape[1]} != manifest {self.manifest.dimension}"
                )
            self._matrix = matrix
            self._chunks = chunks


_STORE: RagStore | None = None
_STORE_LOCK = threading.Lock()


def get_default_store() -> RagStore:
    global _STORE
    if _STORE is not None:
        return _STORE
    with _STORE_LOCK:
        if _STORE is None:
            _STORE = RagStore(RagManifest.load())
        return _STORE


def reset_default_store_for_tests() -> None:
    global _STORE
    with _STORE_LOCK:
        _STORE = None


def _manifest_path_from_env() -> Path:
    override = os.environ.get("MED_RAG_MANIFEST", "").strip()
    if override:
        return Path(override)
    return DEFAULT_MANIFEST


def _resolve_under(root: Path, relative: str) -> Path:
    rel = Path(relative)
    if rel.is_absolute():
        raise ValueError("manifest artifact paths must be relative to the RAG root")
    resolved = (root / rel).resolve()
    if root.resolve() not in resolved.parents and resolved != root.resolve():
        raise ValueError("manifest artifact path escapes RAG root")
    return resolved


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
            item = json.loads(line)
            if not isinstance(item, dict):
                raise ValueError(f"corpus line {line_number} must be an object")
            text = item.get("text") or item.get("contents") or item.get("content")
            if not isinstance(text, str) or not text.strip():
                raise ValueError(f"corpus line {line_number} has no text")
            normalized = dict(item)
            normalized.setdefault("chunk_id", f"chunk-{line_number:08d}")
            chunks.append(normalized)
    if not chunks:
        raise ValueError("corpus artifact contains no records")
    return chunks


def _chunk_to_item(chunk: Mapping[str, Any], score: float, index: int) -> dict[str, Any]:
    # Prefer plain text body for evidence; fall back to contents with headers.
    text = str(chunk.get("text") or chunk.get("contents") or chunk.get("content") or "")
    text = text[:20_000]
    source_raw = str(chunk.get("source_file") or chunk.get("source") or "")
    source = Path(source_raw.replace("\\", "/")).name[:500] if source_raw else ""
    title = str(chunk.get("title") or chunk.get("volume") or "")[:500]
    return {
        "rank": None,  # filled by caller if needed
        "score": round(float(score), 6) if math.isfinite(score) else 0.0,
        "chunk_id": str(chunk.get("chunk_id") or f"chunk-{index:08d}"),
        "doc_id": str(chunk.get("doc_id") or "")[:500],
        "title": title,
        "volume": str(chunk.get("volume") or "")[:200],
        "section": str(chunk.get("chapter_path") or "")[:1000],
        "source": source,
        "text": text,
        "preview": " ".join(text.split())[:500],
        "index": index,
        "image_refs": chunk.get("image_refs") or [],
    }


def _lexical_tokens(query: str) -> tuple[str, ...]:
    import re

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
        while True:
            chunk = stream.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()
