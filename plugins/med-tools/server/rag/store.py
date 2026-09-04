"""Load versioned war-trauma JSONL + NPY artifacts from plugins/med-tools/data/rag."""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np

from .presentation import build_image_asset

PLUGIN_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_RAG_ROOT = PLUGIN_ROOT / "data" / "rag"
DEFAULT_MANIFEST = DEFAULT_RAG_ROOT / "manifest.json"
RAG_MANIFEST_POINTER_RELATIVE = Path("med-tools") / "rag-manifest-path"
INTERNAL_MAX_TOP_K = 64


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

        top_k = max(1, min(int(top_k), INTERNAL_MAX_TOP_K, matrix.shape[0]))
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
            items.append(_chunk_to_item(
                self._chunks[int(index)],
                score,
                int(index),
                manifest_root=self.manifest.root,
            ))
            if len(items) >= top_k:
                break
        return items

    def search_lexical(self, *, query: str, top_k: int) -> list[dict[str, Any]]:
        self._ensure_loaded()
        assert self._chunks is not None
        tokens = _lexical_tokens(query)
        if not tokens:
            raise ValueError("rag query has no searchable terms")
        top_k = max(1, min(int(top_k), INTERNAL_MAX_TOP_K))
        normalized_query = " ".join(query.lower().split())
        ranked: list[tuple[float, int]] = []
        for index, chunk in enumerate(self._chunks):
            searchable = " ".join(
                [str(chunk.get(key, "")) for key in ("title", "chapter_path", "contents", "text", "content")]
                + [_image_ref_search_text(chunk)]
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
            _chunk_to_item(
                self._chunks[index],
                score,
                index,
                manifest_root=self.manifest.root,
            )
            for score, index in ranked[:top_k]
        ]

    def search_image_captions(self, *, query: str, top_k: int) -> list[dict[str, Any]]:
        """Find chunks whose attached image captions directly match the query."""

        self._ensure_loaded()
        assert self._chunks is not None
        top_k = max(1, min(int(top_k), INTERNAL_MAX_TOP_K))
        ranked: list[tuple[float, int]] = []
        for index, chunk in enumerate(self._chunks):
            score = _image_caption_match_score(query, chunk)
            if score <= 0:
                continue
            ranked.append((score, index))
        ranked.sort(key=lambda item: (-item[0], item[1]))
        return [
            _chunk_to_item(
                self._chunks[index],
                score,
                index,
                manifest_root=self.manifest.root,
            )
            for score, index in ranked[:top_k]
        ]

    def neighbor_chunks(
        self,
        *,
        index: int,
        window: int = 1,
        same_source: bool = True,
        same_doc: bool = False,
    ) -> list[dict[str, Any]]:
        """Return nearby chunks as lightweight context evidence.

        Neighbor chunks are useful for step/process questions where a single
        MinerU chunk may only contain one sentence from a numbered procedure.
        """

        self._ensure_loaded()
        assert self._chunks is not None
        if index < 0 or index >= len(self._chunks):
            return []
        if window < 1:
            return []
        base = self._chunks[index]
        base_source = _chunk_source_key(base)
        base_doc = str(base.get("doc_id") or "")
        start = max(0, index - window)
        stop = min(len(self._chunks), index + window + 1)
        context: list[dict[str, Any]] = []
        for neighbor_index in range(start, stop):
            if neighbor_index == index:
                continue
            neighbor = self._chunks[neighbor_index]
            if same_source and _chunk_source_key(neighbor) != base_source:
                continue
            if same_doc and str(neighbor.get("doc_id") or "") != base_doc:
                continue
            item = _chunk_to_item(
                neighbor,
                0.0,
                neighbor_index,
                manifest_root=self.manifest.root,
            )
            item["evidence_role"] = "context"
            context.append(item)
        return context

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


def get_active_manifest_path() -> Path:
    return _manifest_path_from_env().expanduser().resolve()


def activate_manifest(manifest_path: Path) -> Path:
    path = manifest_path.expanduser().resolve()
    if not path.is_file():
        raise RagUnavailableError(f"RAG manifest missing: {path}")
    # Validate before switching the pointer, so a bad bundle cannot become
    # active accidentally.
    status = RagStore(RagManifest.load(path)).status(validate=True)
    if not status.get("ready"):
        raise RagUnavailableError(f"RAG manifest is not ready: {status.get('reason')}")
    pointer = _rag_manifest_pointer_path()
    pointer.parent.mkdir(parents=True, exist_ok=True)
    pointer.write_text(f"{path}\n", encoding="utf-8")
    reset_default_store_for_tests()
    return pointer


def _manifest_path_from_env() -> Path:
    override = os.environ.get("MED_RAG_MANIFEST", "").strip()
    if override:
        return Path(override)
    pointer = _rag_manifest_pointer_path()
    if pointer.is_file():
        configured = _read_manifest_pointer(pointer)
        return Path(configured)
    return DEFAULT_MANIFEST


def _rag_manifest_pointer_path() -> Path:
    """Return the user-local manifest selector without baking paths into Git.

    MCP launchers may whitelist their child-process environment, so a shell
    ``MED_RAG_MANIFEST`` export is not always inherited.  A one-line pointer
    below PilotDeck's private home is therefore the durable development
    configuration.  In a source checkout, retain a deterministic fallback for
    direct Python/MCP launches that do not supply ``PILOT_HOME``.
    """

    pilot_home = os.environ.get("PILOT_HOME", "").strip()
    if pilot_home:
        return Path(pilot_home).expanduser() / RAG_MANIFEST_POINTER_RELATIVE
    project_root = PLUGIN_ROOT.parents[1]
    return project_root / ".pilotdeck-home" / RAG_MANIFEST_POINTER_RELATIVE


def _read_manifest_pointer(pointer: Path) -> str:
    lines = [line.strip() for line in pointer.read_text(encoding="utf-8").splitlines()]
    values = [line for line in lines if line and not line.startswith("#")]
    if len(values) != 1:
        raise ValueError(
            f"RAG manifest pointer must contain exactly one path: {pointer}"
        )
    path = Path(values[0]).expanduser()
    if not path.is_absolute():
        raise ValueError(f"RAG manifest pointer path must be absolute: {pointer}")
    if not path.is_file():
        raise RagUnavailableError(
            f"RAG manifest configured by pointer is missing: {path}"
        )
    return str(path)


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


def _chunk_to_item(
    chunk: Mapping[str, Any],
    score: float,
    index: int,
    *,
    manifest_root: Path | None = None,
) -> dict[str, Any]:
    # Prefer plain text body for evidence; fall back to contents with headers.
    text = str(chunk.get("text") or chunk.get("contents") or chunk.get("content") or "")
    text = text[:20_000]
    source_raw = str(chunk.get("source_file") or chunk.get("source") or "")
    source = Path(source_raw.replace("\\", "/")).name[:500] if source_raw else ""
    title = str(chunk.get("title") or chunk.get("volume") or "")[:500]
    item = {
        "rank": None,  # filled by caller if needed
        "score": round(float(score), 6) if math.isfinite(score) else 0.0,
        "chunk_id": str(chunk.get("chunk_id") or f"chunk-{index:08d}"),
        "doc_id": str(chunk.get("doc_id") or "")[:500],
        "source_corpus_id": str(chunk.get("source_corpus_id") or "")[:200],
        "source_bundle_corpus_path": str(chunk.get("source_bundle_corpus_path") or "")[:1_000],
        "title": title,
        "volume": str(chunk.get("volume") or "")[:200],
        "section": str(chunk.get("chapter_path") or "")[:1000],
        "source": source,
        "text": text,
        "preview": " ".join(text.split())[:500],
        "page_start": _optional_positive_int(chunk.get("page_start")),
        "page_end": _optional_positive_int(chunk.get("page_end")),
        "index": index,
    }
    image_refs = chunk.get("image_refs")
    if isinstance(image_refs, list):
        assets = []
        for ref in image_refs:
            if not isinstance(ref, Mapping):
                continue
            safe_ref = _safe_image_ref(ref)
            if safe_ref is None:
                continue
            asset = build_image_asset(safe_ref, bundle_root=manifest_root)
            if asset is None:
                continue
            assets.append({**safe_ref, **asset})
        item["image_refs"] = assets
        item["assets"] = assets
    else:
        item["image_refs"] = []
        item["assets"] = []
    return item


def _chunk_source_key(chunk: Mapping[str, Any]) -> str:
    return (
        str(chunk.get("source_corpus_id") or "")
        or str(chunk.get("source_bundle_corpus_path") or "")
        or str(chunk.get("doc_id") or "")
        or str(chunk.get("title") or "")
    )


def _image_ref_search_text(chunk: Mapping[str, Any]) -> str:
    refs = chunk.get("image_refs")
    if not isinstance(refs, list):
        return ""
    values: list[str] = []
    for ref in refs:
        if not isinstance(ref, Mapping):
            continue
        caption = str(ref.get("caption") or "").strip()
        if caption:
            values.append(caption)
    return " ".join(values)


def _image_caption_match_score(query: str, chunk: Mapping[str, Any]) -> float:
    refs = chunk.get("image_refs")
    if not isinstance(refs, list):
        return 0.0
    normalized_query = _normalize_caption_match_text(query)
    best = 0.0
    for ref in refs:
        if not isinstance(ref, Mapping):
            continue
        caption = str(ref.get("caption") or "")
        normalized_caption = _normalize_caption_match_text(caption)
        if not normalized_caption:
            continue
        caption_without_label = _strip_figure_label(normalized_caption)
        if normalized_caption and normalized_caption in normalized_query:
            best = max(best, 1.0)
        elif normalized_query and normalized_query in normalized_caption:
            best = max(best, 1.0)
        elif caption_without_label and caption_without_label in normalized_query:
            best = max(best, 0.98)
        elif _figure_label(normalized_caption) and _figure_label(normalized_caption) in normalized_query:
            best = max(best, 0.9)
    return best


def _normalize_caption_match_text(value: str) -> str:
    return re.sub(r"\s+", "", value.lower())


def _figure_label(value: str) -> str:
    match = re.match(r"^(?:图|表|fig(?:ure)?|table)[0-9一二三四五六七八九十ivxvxlcdm_.-]*", value, flags=re.I)
    return match.group(0) if match else ""


def _strip_figure_label(value: str) -> str:
    label = _figure_label(value)
    return value[len(label) :] if label else value


def _safe_image_ref(ref: Mapping[str, Any]) -> dict[str, Any] | None:
    path = str(ref.get("path") or "").strip().replace("\\", "/")
    if not path or path.startswith("/") or ".." in Path(path).parts:
        return None
    return {
        "path": path[:2_000],
        "caption": str(ref.get("caption") or "")[:1_000],
        "page": _optional_positive_int(ref.get("page")),
        "relation": str(ref.get("relation") or "same_page")[:50],
    }


def _optional_positive_int(value: Any) -> int | None:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


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
