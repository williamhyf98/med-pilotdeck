"""Build self-contained, checksum-verified RAG bundles outside the checkout."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
from collections.abc import Callable
from pathlib import Path
from typing import Any, Mapping

import numpy as np

from .embedding_client import embed_texts, get_embedding_config
from .store import RagManifest, RagStore


EmbeddingFunction = Callable[[list[str]], list[list[float]]]


def build_rag_bundle(
    *,
    corpus_path: Path,
    destination: Path,
    corpus_id: str,
    name: str,
    version: str,
    license_id: str,
    embed: EmbeddingFunction = embed_texts,
) -> Path:
    """Embed a JSONL corpus and atomically create a standalone RAG bundle."""

    corpus_path = corpus_path.resolve()
    if not corpus_path.is_file():
        raise FileNotFoundError(f"corpus is missing: {corpus_path}")
    destination = destination.resolve()
    if destination.exists():
        raise FileExistsError(f"bundle destination already exists: {destination}")
    temporary = destination.with_name(f".{destination.name}.tmp")
    if temporary.exists():
        raise FileExistsError(f"bundle temporary path already exists: {temporary}")
    chunks = _load_chunks(corpus_path)
    vectors = _embed_chunks(chunks, embed)
    temporary.mkdir(parents=True)
    try:
        bundle_corpus = temporary / "corpus" / "chunks.jsonl"
        bundle_embedding = temporary / "embedding" / "vectors.npy"
        bundle_corpus.parent.mkdir()
        bundle_embedding.parent.mkdir()
        bundled_chunks, asset_count = _bundle_image_assets(chunks, temporary / "assets")
        _write_jsonl(bundle_corpus, bundled_chunks)
        np.save(bundle_embedding, vectors)
        cfg = get_embedding_config()
        manifest = {
            "corpus_id": corpus_id,
            "name": name,
            "version": version,
            "license_id": license_id,
            "embedding_model": str(cfg["model"]),
            "dimension": int(vectors.shape[1]),
            "row_count": int(vectors.shape[0]),
            "corpus_path": "corpus/chunks.jsonl",
            "embedding_path": "embedding/vectors.npy",
            "corpus_sha256": _sha256(bundle_corpus),
            "embedding_sha256": _sha256(bundle_embedding),
            "asset_count": asset_count,
            "default_top_k": 3,
            "max_top_k": 8,
            "default_min_score": 0.35,
        }
        (temporary / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        temporary.replace(destination)
    except Exception:
        # Keep failures inspectable rather than deleting potentially useful artifacts.
        raise
    return destination


def build_incremental_rag_bundle(
    *,
    base_manifest_path: Path,
    ingest_manifest_path: Path,
    destination: Path,
    corpus_id: str,
    name: str,
    version: str,
    license_id: str | None = None,
    embed: EmbeddingFunction = embed_texts,
    validate: bool = True,
) -> dict[str, Any]:
    """Create a new RAG bundle by appending a MinerU ingest bundle to a base bundle.

    The base bundle is read-only.  Its existing chunk rows and vectors are
    copied into ``destination`` unchanged; only chunks from the MinerU ingest
    bundle are embedded.  This gives append-like semantics without mutating the
    currently active RAG bundle.
    """

    base_manifest_path = base_manifest_path.expanduser().resolve()
    ingest_manifest_path = ingest_manifest_path.expanduser().resolve()
    destination = destination.expanduser().resolve()
    if destination.exists():
        raise FileExistsError(f"bundle destination already exists: {destination}")
    temporary = destination.with_name(f".{destination.name}.tmp")
    if temporary.exists():
        raise FileExistsError(f"bundle temporary path already exists: {temporary}")

    base_manifest = RagManifest.load(base_manifest_path)
    base_raw_manifest = json.loads(base_manifest_path.read_text(encoding="utf-8"))
    ingest = _load_ingest_bundle(ingest_manifest_path)
    base_chunks = _load_chunks(base_manifest.corpus_path)
    base_vectors = _load_base_vectors(base_manifest)
    if len(base_chunks) != int(base_vectors.shape[0]):
        raise ValueError("base corpus line count does not match base embedding rows")
    if base_manifest.dimension and int(base_vectors.shape[1]) != base_manifest.dimension:
        raise ValueError("base embedding dimension does not match base manifest")
    new_chunks = _load_chunks(ingest["chunks_path"])
    _assert_no_duplicate_chunk_ids(base_chunks, new_chunks)
    new_vectors = _embed_chunks(new_chunks, embed)
    if int(new_vectors.shape[1]) != int(base_vectors.shape[1]):
        raise ValueError(
            f"new embedding dimension {new_vectors.shape[1]} != base dimension {base_vectors.shape[1]}"
        )

    temporary.mkdir(parents=True)
    try:
        base_asset_stats = _copy_base_assets(base_manifest.root, temporary)
        rewritten_new_chunks, imported_assets, imported_asset_stats = _copy_ingest_assets_and_rewrite_refs(
            chunks=new_chunks,
            ingest_root=ingest["root"],
            destination_root=temporary,
        )
        asset_materialization = {
            "base": base_asset_stats,
            "imported": imported_asset_stats,
            "total": _merge_materialization_stats(
                _empty_materialization_stats(),
                {
                    key: base_asset_stats.get(key, 0) + imported_asset_stats.get(key, 0)
                    for key in ("hardlinked", "copied", "existing")
                },
            ),
        }
        combined_chunks = base_chunks + rewritten_new_chunks
        combined_vectors = np.concatenate(
            [np.asarray(base_vectors, dtype=np.float32), np.asarray(new_vectors, dtype=np.float32)],
            axis=0,
        )
        corpus_dir = temporary / "corpus"
        embedding_dir = temporary / "embedding"
        corpus_dir.mkdir(parents=True, exist_ok=True)
        embedding_dir.mkdir(parents=True, exist_ok=True)
        chunks_path = corpus_dir / "chunks.jsonl"
        embedding_path = embedding_dir / "vectors.npy"
        _write_jsonl(chunks_path, combined_chunks)
        np.save(embedding_path, combined_vectors)
        _copy_optional_ingest_records(
            ingest=ingest,
            destination_root=temporary,
            imported_assets=imported_assets,
        )
        cfg = get_embedding_config()
        resolved_license = str(license_id or base_manifest.license_id or base_raw_manifest.get("license_id") or "")
        source_documents = _combined_source_documents(base_raw_manifest, ingest["manifest"])
        manifest = {
            "corpus_id": corpus_id,
            "name": name,
            "version": version,
            "license_id": resolved_license,
            "embedding_model": str(cfg["model"]),
            "dimension": int(combined_vectors.shape[1]),
            "row_count": int(combined_vectors.shape[0]),
            "corpus_path": "corpus/chunks.jsonl",
            "embedding_path": "embedding/vectors.npy",
            "corpus_sha256": _sha256(chunks_path),
            "embedding_sha256": _sha256(embedding_path),
            "asset_count": _count_files(temporary / "assets"),
            "default_top_k": int(base_raw_manifest.get("default_top_k") or base_manifest.default_top_k),
            "max_top_k": int(base_raw_manifest.get("max_top_k") or base_manifest.max_top_k),
            "default_min_score": float(
                base_raw_manifest.get("default_min_score") or base_manifest.default_min_score
            ),
            "source_documents": source_documents,
            "incremental_import": {
                "base_manifest_path": str(base_manifest_path),
                "base_corpus_id": base_manifest.corpus_id,
                "base_version": base_manifest.version,
                "base_row_count": int(base_vectors.shape[0]),
                "ingest_manifest_path": str(ingest_manifest_path),
                "ingest_corpus_id": str(ingest["manifest"].get("corpus_id") or ""),
                "new_row_count": int(new_vectors.shape[0]),
                "total_row_count": int(combined_vectors.shape[0]),
                "asset_materialization": asset_materialization,
            },
        }
        (temporary / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        validation = None
        if validate:
            validation = RagStore(RagManifest.load(temporary / "manifest.json")).status(validate=True)
            if not validation.get("ready"):
                raise ValueError(f"incremental bundle validation failed: {validation.get('reason')}")
        temporary.replace(destination)
    except Exception:
        raise
    return {
        "ready": True,
        "corpus_id": corpus_id,
        "name": name,
        "version": version,
        "manifest_path": str(destination / "manifest.json"),
        "bundle_dir": str(destination),
        "base_manifest_path": str(base_manifest_path),
        "ingest_manifest_path": str(ingest_manifest_path),
        "old_chunk_count": int(base_vectors.shape[0]),
        "new_chunk_count": int(new_vectors.shape[0]),
        "total_chunk_count": int(base_vectors.shape[0] + new_vectors.shape[0]),
        "embedding_dimension": int(combined_vectors.shape[1]),
        "asset_count": _count_files(destination / "assets"),
        "asset_materialization": asset_materialization,
        "validation": validation,
        "activated": False,
    }


def _bundle_image_assets(
    chunks: list[dict[str, Any]], assets_root: Path
) -> tuple[list[dict[str, Any]], int]:
    """Copy referenced MinerU images into a portable bundle assets directory."""

    copied: dict[Path, str] = {}
    result: list[dict[str, Any]] = []
    for chunk in chunks:
        normalized = dict(chunk)
        refs = chunk.get("image_refs")
        if not isinstance(refs, list):
            result.append(normalized)
            continue
        bundled_refs: list[dict[str, Any]] = []
        for raw_ref in refs:
            if not isinstance(raw_ref, dict):
                continue
            ref = dict(raw_ref)
            source_value = str(ref.pop("source_path", "")).strip()
            if not source_value:
                bundled_refs.append(ref)
                continue
            source = Path(source_value).expanduser().resolve()
            if not source.is_file():
                raise FileNotFoundError(f"referenced MinerU image is missing: {source}")
            relative = copied.get(source)
            if relative is None:
                digest = hashlib.sha256(str(source).encode("utf-8")).hexdigest()
                suffix = source.suffix.lower() or ".bin"
                destination = assets_root / digest[:2] / f"{digest}{suffix}"
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, destination)
                relative = destination.relative_to(assets_root.parent).as_posix()
                copied[source] = relative
            ref["path"] = relative
            bundled_refs.append(ref)
        normalized["image_refs"] = bundled_refs
        result.append(normalized)
    return result, len(copied)


def _load_ingest_bundle(manifest_path: Path) -> dict[str, Any]:
    if not manifest_path.is_file():
        raise FileNotFoundError(f"ingest manifest is missing: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict):
        raise ValueError("ingest manifest must be a JSON object")
    root = manifest_path.parent
    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, Mapping):
        raise ValueError("ingest manifest lacks artifacts")
    chunks_path = _resolve_manifest_relative(root, str(artifacts.get("chunks_path") or ""))
    pages_path = _optional_manifest_relative(root, artifacts.get("pages_path"))
    assets_path = _optional_manifest_relative(root, artifacts.get("assets_path"))
    if not chunks_path.is_file():
        raise FileNotFoundError(f"ingest chunks are missing: {chunks_path}")
    return {
        "root": root,
        "manifest": manifest,
        "chunks_path": chunks_path,
        "pages_path": pages_path,
        "assets_path": assets_path,
    }


def _load_base_vectors(manifest: RagManifest) -> np.ndarray:
    if manifest.corpus_sha256 and _sha256(manifest.corpus_path) != manifest.corpus_sha256:
        raise ValueError("base corpus SHA-256 does not match manifest")
    if manifest.embedding_sha256 and _sha256(manifest.embedding_path) != manifest.embedding_sha256:
        raise ValueError("base embedding SHA-256 does not match manifest")
    matrix = np.load(manifest.embedding_path, mmap_mode="r")
    if not isinstance(matrix, np.ndarray) or matrix.ndim != 2:
        raise ValueError("base embedding artifact must be a 2D matrix")
    matrix = np.asarray(matrix, dtype=np.float32)
    if not np.all(np.isfinite(matrix)):
        raise ValueError("base embedding matrix contains non-finite values")
    return matrix


def _assert_no_duplicate_chunk_ids(base_chunks: list[dict[str, Any]], new_chunks: list[dict[str, Any]]) -> None:
    base_ids = {str(chunk.get("chunk_id") or "") for chunk in base_chunks}
    seen: set[str] = set()
    duplicate_seen: set[str] = set()
    new_ids: list[str] = []
    for chunk in new_chunks:
        chunk_id = str(chunk.get("chunk_id") or "")
        new_ids.append(chunk_id)
        if not chunk_id:
            continue
        if chunk_id in seen:
            duplicate_seen.add(chunk_id)
        seen.add(chunk_id)
    duplicate_new = sorted(duplicate_seen)
    if duplicate_new:
        raise ValueError(f"duplicate chunk_id values in ingest bundle: {', '.join(duplicate_new[:5])}")
    duplicates = sorted(chunk_id for chunk_id in new_ids if chunk_id and chunk_id in base_ids)
    if duplicates:
        raise ValueError(f"ingest bundle chunk_id already exists in base corpus: {', '.join(duplicates[:5])}")


def _copy_base_assets(base_root: Path, destination_root: Path) -> dict[str, int]:
    stats = _empty_materialization_stats()
    source = base_root / "assets"
    if not source.is_dir():
        return stats
    destination = destination_root / "assets"
    for path in source.rglob("*"):
        relative = path.relative_to(source)
        target = destination / relative
        if path.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        if not path.is_file():
            continue
        mode = _materialize_file(path, target)
        stats[mode] += 1
    return stats


def _empty_materialization_stats() -> dict[str, int]:
    return {"hardlinked": 0, "copied": 0, "existing": 0}


def _merge_materialization_stats(target: dict[str, int], source: Mapping[str, int]) -> dict[str, int]:
    for key in ("hardlinked", "copied", "existing"):
        target[key] = int(target.get(key, 0)) + int(source.get(key, 0))
    return target


def _materialize_file(source: Path, destination: Path) -> str:
    """Place a file at destination using hardlink when the filesystem allows it."""

    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        return "existing"
    try:
        os.link(source, destination)
        return "hardlinked"
    except OSError:
        shutil.copy2(source, destination)
        return "copied"


def _copy_ingest_assets_and_rewrite_refs(
    *,
    chunks: list[dict[str, Any]],
    ingest_root: Path,
    destination_root: Path,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, int]]:
    copied_by_path: dict[str, dict[str, str]] = {}
    assets_by_id: dict[str, dict[str, Any]] = {}
    stats = _empty_materialization_stats()
    rewritten_chunks: list[dict[str, Any]] = []
    for chunk in chunks:
        item = dict(chunk)
        doc_id = str(item.get("doc_id") or item.get("title") or "imported")
        rewritten_refs: list[dict[str, Any]] = []
        for raw_ref in item.get("image_refs") or []:
            if not isinstance(raw_ref, Mapping):
                continue
            ref = dict(raw_ref)
            old_path = str(ref.get("path") or "").strip().replace("\\", "/")
            if not old_path or Path(old_path).is_absolute() or ".." in Path(old_path).parts:
                ref["available"] = False
                rewritten_refs.append(ref)
                continue
            mapped = copied_by_path.get(old_path)
            if mapped is None:
                source = (ingest_root / old_path).resolve()
                if ingest_root.resolve() not in source.parents and source != ingest_root.resolve():
                    ref["available"] = False
                    rewritten_refs.append(ref)
                    continue
                if not source.is_file():
                    ref["available"] = False
                    rewritten_refs.append(ref)
                    continue
                digest = _sha256(source)
                suffix = source.suffix.lower() or ".bin"
                doc_slug = _slug(doc_id)
                new_path = f"assets/imported/{doc_slug}/{digest[:2]}/{digest}{suffix}"
                destination = destination_root / new_path
                mode = _materialize_file(source, destination)
                stats[mode] += 1
                mapped = {
                    "asset_id": f"asset-{doc_slug[:64]}-{digest[:24]}",
                    "path": new_path,
                    "sha256": digest,
                    "bytes": str(destination.stat().st_size),
                }
                copied_by_path[old_path] = mapped
            ref.update(
                {
                    "asset_id": mapped["asset_id"],
                    "path": mapped["path"],
                    "available": True,
                }
            )
            rewritten_refs.append(ref)
            asset_record = {
                "asset_id": mapped["asset_id"],
                "asset_type": str(ref.get("asset_type") or "figure"),
                "available": True,
                "path": mapped["path"],
                "sha256": mapped["sha256"],
                "bytes": int(mapped["bytes"]),
                "caption": str(ref.get("caption") or ""),
                "page": ref.get("page"),
                "figure_no": str(ref.get("figure_no") or ""),
                "doc_id": doc_id,
                "linked_chunk_ids": [str(item.get("chunk_id") or "")],
            }
            existing = assets_by_id.get(asset_record["asset_id"])
            if existing is None:
                assets_by_id[asset_record["asset_id"]] = asset_record
            else:
                linked = set(str(value) for value in existing.get("linked_chunk_ids", []))
                linked.update(str(value) for value in asset_record["linked_chunk_ids"] if str(value))
                existing["linked_chunk_ids"] = sorted(linked)
        item["image_refs"] = rewritten_refs
        rewritten_chunks.append(item)
    assets = list(assets_by_id.values())
    assets.sort(key=lambda asset: (asset.get("doc_id") or "", asset.get("page") or 0, asset.get("asset_id") or ""))
    return rewritten_chunks, assets, stats


def _copy_optional_ingest_records(
    *,
    ingest: Mapping[str, Any],
    destination_root: Path,
    imported_assets: list[dict[str, Any]],
) -> None:
    corpus_dir = destination_root / "corpus"
    pages_path = ingest.get("pages_path")
    if isinstance(pages_path, Path) and pages_path.is_file():
        shutil.copyfile(pages_path, corpus_dir / "imported_pages.jsonl")
    assets_path = ingest.get("assets_path")
    if imported_assets:
        _write_jsonl(corpus_dir / "imported_assets.jsonl", imported_assets)
    elif isinstance(assets_path, Path) and assets_path.is_file():
        shutil.copyfile(assets_path, corpus_dir / "imported_assets.jsonl")


def _combined_source_documents(base_manifest: Mapping[str, Any], ingest_manifest: Mapping[str, Any]) -> list[dict[str, Any]]:
    documents: list[dict[str, Any]] = []
    for source in (base_manifest, ingest_manifest):
        raw_documents = source.get("source_documents")
        if isinstance(raw_documents, list):
            documents.extend(dict(doc) for doc in raw_documents if isinstance(doc, Mapping))
    return documents


def _resolve_manifest_relative(root: Path, value: str) -> Path:
    if not value:
        raise ValueError("manifest artifact path is empty")
    rel = Path(value)
    if rel.is_absolute():
        raise ValueError("manifest artifact paths must be relative")
    resolved = (root / rel).resolve()
    if root.resolve() not in resolved.parents and resolved != root.resolve():
        raise ValueError("manifest artifact path escapes bundle root")
    return resolved


def _optional_manifest_relative(root: Path, value: Any) -> Path | None:
    if value is None or str(value).strip() == "":
        return None
    return _resolve_manifest_relative(root, str(value))


def _count_files(root: Path) -> int:
    if not root.is_dir():
        return 0
    return sum(1 for path in root.rglob("*") if path.is_file())


def _slug(value: str) -> str:
    cleaned = re.sub(r"\s+", "-", str(value).strip())
    cleaned = re.sub(r"[^\w\u4e00-\u9fff.-]+", "-", cleaned)
    cleaned = cleaned.strip(".-_")
    return cleaned[:120] or "document"


def _write_jsonl(path: Path, chunks: list[dict[str, Any]]) -> None:
    with path.open("x", encoding="utf-8") as stream:
        for chunk in chunks:
            stream.write(json.dumps(chunk, ensure_ascii=False, sort_keys=True))
            stream.write("\n")


def _load_chunks(path: Path) -> list[dict[str, Any]]:
    chunks: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, start=1):
            if not line.strip():
                continue
            item = json.loads(line)
            if not isinstance(item, dict):
                raise ValueError(f"corpus line {line_number} must be an object")
            text = item.get("contents") or item.get("text") or item.get("content")
            if not isinstance(text, str) or not text.strip():
                raise ValueError(f"corpus line {line_number} has no embeddable text")
            chunks.append(item)
    if not chunks:
        raise ValueError("corpus is empty")
    return chunks


def _embed_chunks(chunks: list[dict[str, Any]], embed: EmbeddingFunction) -> np.ndarray:
    vectors: list[list[float]] = []
    for start in range(0, len(chunks), 64):
        batch = chunks[start : start + 64]
        texts = [str(chunk.get("contents") or chunk.get("text") or chunk.get("content")) for chunk in batch]
        result = embed(texts)
        if len(result) != len(batch):
            raise ValueError("embedding response count does not match corpus batch")
        vectors.extend(result)
    matrix = np.asarray(vectors, dtype=np.float32)
    if matrix.ndim != 2 or matrix.shape[1] == 0:
        raise ValueError("embedding matrix must be non-empty and two-dimensional")
    if not np.all(np.isfinite(matrix)):
        raise ValueError("embedding matrix contains non-finite values")
    return matrix


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while block := stream.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()
