"""Presentation helpers for text evidence with linked image assets."""

from __future__ import annotations

import re
import hashlib
from pathlib import Path
from typing import Any, Iterable, Mapping
from urllib.parse import quote


def build_interleave_context(
    chunks: Iterable[Mapping[str, Any]],
    *,
    max_image_rank: int = 1,
    image_query: str | None = None,
) -> list[dict[str, Any]]:
    """Build ordered text/image evidence segments for the caller or frontend.

    Text remains the only semantic evidence. Images are attachments referenced
    by retrieved text chunks and are deduplicated by path.
    """
    segments: list[dict[str, Any]] = []
    seen_images: set[str] = set()
    for position, chunk in enumerate(chunks, start=1):
        text = str(chunk.get("text") or "").strip()
        if not text:
            continue
        segments.append({"type": "text", "content": text, "chunk_id": str(chunk.get("chunk_id") or "")})
        rank = chunk.get("rank")
        try:
            effective_rank = int(rank)
        except (TypeError, ValueError):
            effective_rank = position
        if effective_rank > max_image_rank:
            continue
        refs = chunk.get("image_refs")
        if not isinstance(refs, list):
            continue
        refs_to_show = _filter_refs_for_image_query(refs, image_query)
        for ref in refs:
            if ref not in refs_to_show:
                continue
            if not isinstance(ref, Mapping):
                continue
            path = str(ref.get("path") or "").strip()
            if not path or path in seen_images:
                continue
            seen_images.add(path)
            asset = build_image_asset(ref)
            segments.append(
                {
                    "type": "image",
                    "asset_id": asset["asset_id"],
                    "path": asset["path"],
                    "url": asset["url"],
                    "available": asset["available"],
                    "caption": asset["caption"],
                    "page": asset["page"],
                    "relation": asset["relation"],
                    "asset_type": asset["asset_type"],
                    "figure_no": asset["figure_no"],
                    "after_chunk_id": str(chunk.get("chunk_id") or ""),
                }
            )
    return segments


def build_image_asset(ref: Mapping[str, Any], *, bundle_root: Path | None = None) -> dict[str, Any] | None:
    """Return the structured, browser-ready view for a chunk image ref."""

    path = str(ref.get("path") or "").strip()
    if not path:
        return None
    url = _image_asset_url(path)
    caption = str(ref.get("caption") or "")
    available = bool(url)
    if bundle_root is not None:
        available = _bundle_asset_available(bundle_root, path)
    elif ref.get("available") is False:
        available = False
    return {
        "asset_id": _image_asset_id(path),
        "asset_type": _asset_type(caption, path),
        "path": path,
        "url": url if available else None,
        "available": available,
        "caption": caption,
        "page": ref.get("page"),
        "figure_no": _figure_label(_normalize_caption_text(caption)) or None,
        "relation": str(ref.get("relation") or "same_page"),
    }


def summarize_image_match(chunks: Iterable[Mapping[str, Any]], query: str) -> dict[str, Any]:
    requested = bool(query and _looks_like_image_query(query))
    refs: list[Mapping[str, Any]] = []
    for chunk in chunks:
        chunk_refs = chunk.get("image_refs")
        if not isinstance(chunk_refs, list):
            continue
        refs.extend(ref for ref in chunk_refs if isinstance(ref, Mapping))
    exact_refs = [ref for ref in refs if _caption_matches_query(str(ref.get("caption") or ""), query)]
    available_refs = [ref for ref in refs if bool(ref.get("available", True)) and ref.get("url")]
    return {
        "requested": requested,
        "exact_figure_match": bool(exact_refs),
        "matched_image_count": len(refs),
        "available_image_count": len(available_refs),
        "reason": _image_match_reason(requested, exact_refs, refs),
    }


def attach_display_assets(chunks: Iterable[dict[str, Any]], query: str | None) -> None:
    """Add per-query image choices without removing the full asset list."""

    for chunk in chunks:
        refs = chunk.get("assets") or chunk.get("image_refs")
        if not isinstance(refs, list):
            chunk["display_assets"] = []
            continue
        selected = _filter_refs_for_image_query(refs, query)
        chunk["display_assets"] = [
            ref
            for ref in selected
            if isinstance(ref, Mapping) and ref.get("available") and ref.get("url")
        ]


def _looks_like_image_query(query: str) -> bool:
    lowered = query.lower()
    return any(marker in lowered for marker in ("图", "图片", "图示", "图注", "figure", "fig."))


def _image_asset_url(path: str) -> str | None:
    """Return a browser URL only for assets stored in the active bundle."""

    if not path.startswith("assets/"):
        return None
    return "/api/plugins/med-tools/rag-assets/" + quote(path, safe="/")


def _image_asset_id(path: str) -> str:
    return "asset-" + hashlib.sha256(path.encode("utf-8")).hexdigest()[:24]


def _bundle_asset_available(bundle_root: Path, asset_path: str) -> bool:
    if not asset_path.startswith("assets/"):
        return False
    try:
        root = bundle_root.resolve()
        assets_root = (root / "assets").resolve()
        candidate = (root / asset_path).resolve()
        return candidate.is_file() and (candidate == assets_root or assets_root in candidate.parents)
    except OSError:
        return False


def _asset_type(caption: str, path: str) -> str:
    normalized = _normalize_caption_text(caption)
    if normalized.startswith(("表", "table")):
        return "table"
    if normalized.startswith(("公式", "equation")):
        return "equation"
    if normalized.startswith(("图", "fig", "figure")):
        return "figure"
    suffix = Path(path).suffix.lower()
    if suffix in {".jpg", ".jpeg", ".png", ".webp", ".gif"}:
        return "figure"
    return "image"


def _image_match_reason(requested: bool, exact_refs: list[Mapping[str, Any]], refs: list[Mapping[str, Any]]) -> str:
    if not requested:
        return "query_did_not_request_images"
    if exact_refs:
        return "caption_or_figure_label_matched_query"
    if refs:
        return "related_images_found_but_no_exact_caption_match"
    return "no_related_images_found"


def _filter_refs_for_image_query(refs: list[Any], image_query: str | None) -> list[Any]:
    if not image_query:
        return refs
    matched = [
        ref
        for ref in refs
        if isinstance(ref, Mapping) and _caption_matches_query(str(ref.get("caption") or ""), image_query)
    ]
    return matched or refs


def _caption_matches_query(caption: str, query: str) -> bool:
    normalized_caption = _normalize_caption_text(caption)
    normalized_query = _normalize_caption_text(query)
    if not normalized_caption or not normalized_query:
        return False
    if normalized_caption in normalized_query or normalized_query in normalized_caption:
        return True
    caption_without_label = _strip_figure_label(normalized_caption)
    if caption_without_label and caption_without_label in normalized_query:
        return True
    label = _figure_label(normalized_caption)
    return bool(label and label in normalized_query)


def _normalize_caption_text(value: str) -> str:
    return re.sub(r"\s+", "", value.lower())


def _figure_label(value: str) -> str:
    match = re.match(r"^(?:图|表|fig(?:ure)?|table)[0-9一二三四五六七八九十ivxvxlcdm_.-]*", value, flags=re.I)
    return match.group(0) if match else ""


def _strip_figure_label(value: str) -> str:
    label = _figure_label(value)
    return value[len(label) :] if label else value
