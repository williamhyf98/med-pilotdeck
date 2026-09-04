"""Convert MinerU content lists into the JSONL records consumed by ``RagStore``."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


@dataclass(frozen=True)
class ChunkingConfig:
    max_chars: int = 1_200
    overlap_chars: int = 160

    def __post_init__(self) -> None:
        if self.max_chars < 200:
            raise ValueError("max_chars must be at least 200")
        if not 0 <= self.overlap_chars < self.max_chars:
            raise ValueError("overlap_chars must be non-negative and smaller than max_chars")


def build_mineru_chunks(
    *,
    source_pdf: Path,
    content_list_path: Path,
    config: ChunkingConfig = ChunkingConfig(),
    page_index_offset: int = 0,
) -> list[dict[str, Any]]:
    """Create deterministic, text-only chunks with title and page provenance."""

    if page_index_offset < 0:
        raise ValueError("page_index_offset must be non-negative")
    raw = json.loads(content_list_path.read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        raise ValueError("MinerU content_list must be a JSON array")
    document_id = _document_id(source_pdf)
    sections = _sections_from_blocks(raw, page_index_offset=page_index_offset)
    images_by_page = _images_by_page(
        raw,
        content_list_path=content_list_path,
        page_index_offset=page_index_offset,
    )
    chunks: list[dict[str, Any]] = []
    for section_index, section in enumerate(sections):
        for piece_index, piece in enumerate(_split_section(section, config)):
            text = piece["text"]
            if not text:
                continue
            image_refs = _image_refs_for_range(
                images_by_page,
                page_start=piece["page_start"],
                page_end=piece["page_end"],
                text=text,
            )
            chunks.append(
                {
                    "chunk_id": f"{document_id}-{section_index:04d}-{piece_index:03d}",
                    "doc_id": document_id,
                    "title": source_pdf.stem,
                    "chapter_path": section["chapter_path"],
                    "text": text,
                    "contents": _contextual_contents(
                        source_pdf.stem, section["chapter_path"], text, image_refs=image_refs
                    ),
                    "content_type": "body",
                    "source_file": str(source_pdf.resolve()),
                    "page_start": piece["page_start"],
                    "page_end": piece["page_end"],
                    "image_refs": image_refs,
                }
            )
    if not chunks:
        raise ValueError("MinerU content_list contains no usable text blocks")
    return chunks


def write_chunks_jsonl(*, chunks: list[dict[str, Any]], destination: Path) -> Path:
    """Persist a new corpus artifact atomically without overwriting prior output."""

    if not chunks:
        raise ValueError("refusing to write an empty corpus")
    destination = destination.resolve()
    if destination.exists():
        raise FileExistsError(f"corpus destination already exists: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.tmp")
    if temporary.exists():
        raise FileExistsError(f"corpus temporary path already exists: {temporary}")
    with temporary.open("x", encoding="utf-8") as stream:
        for chunk in chunks:
            stream.write(json.dumps(chunk, ensure_ascii=False, sort_keys=True))
            stream.write("\n")
    temporary.replace(destination)
    return destination


def _sections_from_blocks(blocks: list[Any], *, page_index_offset: int) -> list[dict[str, Any]]:
    heading_stack: list[str] = []
    sections: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for block in blocks:
        if not isinstance(block, dict) or block.get("type") != "text":
            continue
        text = _normalize_text(str(block.get("text") or ""))
        if not text:
            continue
        page = int(block.get("page_idx", 0)) + 1 + page_index_offset
        level = block.get("text_level")
        if isinstance(level, int) and 1 <= level <= 6:
            heading_stack = heading_stack[: level - 1]
            heading_stack.append(text)
            current = None
            continue
        if current is None:
            current = {"chapter_path": " > ".join(heading_stack), "parts": []}
            sections.append(current)
        current["parts"].append({"text": text, "page": page})
    return sections


def _split_section(section: dict[str, Any], config: ChunkingConfig) -> Iterable[dict[str, Any]]:
    units: list[tuple[str, int]] = []
    for part in section["parts"]:
        units.extend((sentence, part["page"]) for sentence in _sentences(part["text"], config.max_chars))
    buffer: list[tuple[str, int]] = []
    size = 0
    for unit, page in units:
        extra = len(unit) + (1 if buffer else 0)
        if buffer and size + extra > config.max_chars:
            yield _piece(buffer)
            buffer, size = _overlap(buffer, config.overlap_chars)
        buffer.append((unit, page))
        size += len(unit) + (1 if len(buffer) > 1 else 0)
    if buffer:
        yield _piece(buffer)


def _sentences(text: str, max_chars: int) -> list[str]:
    sentences = [item.strip() for item in re.split(r"(?<=[。！？；])", text) if item.strip()]
    if not sentences:
        return []
    result: list[str] = []
    for sentence in sentences:
        while len(sentence) > max_chars:
            result.append(sentence[:max_chars])
            sentence = sentence[max_chars:]
        if sentence:
            result.append(sentence)
    return result


def _overlap(items: list[tuple[str, int]], overlap_chars: int) -> tuple[list[tuple[str, int]], int]:
    if overlap_chars == 0:
        return [], 0
    kept: list[tuple[str, int]] = []
    size = 0
    for item in reversed(items):
        kept.insert(0, item)
        size += len(item[0]) + (1 if len(kept) > 1 else 0)
        if size >= overlap_chars:
            break
    return kept, size


def _piece(items: list[tuple[str, int]]) -> dict[str, Any]:
    return {
        "text": "\n".join(item[0] for item in items),
        "page_start": min(item[1] for item in items),
        "page_end": max(item[1] for item in items),
    }


def _normalize_text(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _document_id(source_pdf: Path) -> str:
    digest = hashlib.sha256(str(source_pdf.resolve()).encode("utf-8")).hexdigest()[:12]
    return f"mineru-{source_pdf.stem}-{digest}"


def _contextual_contents(
    title: str, chapter_path: str, text: str, *, image_refs: list[dict[str, Any]] | None = None
) -> str:
    context = f"书名：{title}"
    if chapter_path:
        context += f"\n章节：{chapter_path}"
    captions = _captions_for_embedding(image_refs or [])
    if captions:
        context += "\n相关图示：" + "；".join(captions)
    return f"{context}\n\n{text}"


def _captions_for_embedding(image_refs: list[dict[str, Any]]) -> list[str]:
    captions: list[str] = []
    seen: set[str] = set()
    for ref in image_refs:
        caption = _normalize_text(str(ref.get("caption") or ""))
        if not caption or caption in seen:
            continue
        seen.add(caption)
        captions.append(caption)
    return captions


def _images_by_page(
    blocks: list[Any],
    *,
    content_list_path: Path,
    page_index_offset: int,
) -> dict[int, list[dict[str, Any]]]:
    """Collect image assets without interpreting their visual contents."""

    result: dict[int, list[dict[str, Any]]] = {}
    for block in blocks:
        if not isinstance(block, dict) or block.get("type") not in {"image", "figure"}:
            continue
        raw_path = str(block.get("img_path") or block.get("image_path") or "").strip()
        if not raw_path:
            continue
        path = Path(raw_path)
        if path.is_absolute():
            try:
                path = path.resolve().relative_to(content_list_path.parent.resolve())
            except ValueError:
                # Absolute paths outside the MinerU artifact are not portable.
                continue
        page = int(block.get("page_idx", 0)) + 1 + page_index_offset
        captions = block.get("image_caption") or block.get("caption") or []
        if isinstance(captions, str):
            captions = [captions]
        caption = " ".join(str(item).strip() for item in captions if str(item).strip())
        result.setdefault(page, []).append(
            {
                "path": path.as_posix(),
                # Ingestion-only provenance. rag_bundle copies this source into
                # its own assets directory before exposing the corpus.
                "source_path": str((content_list_path.parent / path).resolve()),
                "caption": caption,
                "page": page,
                "relation": "same_page",
            }
        )
    return result


def _image_refs_for_range(
    images_by_page: dict[int, list[dict[str, Any]]],
    *,
    page_start: int,
    page_end: int,
    text: str,
) -> list[dict[str, Any]]:
    refs: list[dict[str, Any]] = []
    seen: set[tuple[str, int]] = set()
    for page in range(page_start, page_end + 1):
        for ref in images_by_page.get(page, []):
            key = (str(ref["path"]), int(ref["page"]))
            if key not in seen:
                seen.add(key)
                item = dict(ref)
                caption = str(item.get("caption") or "")
                if caption and _caption_matches_text(caption, text):
                    item["relation"] = "caption"
                refs.append(item)
    return refs


def _caption_matches_text(caption: str, text: str) -> bool:
    """Match a caption to text without attempting visual understanding."""

    normalized_caption = _normalize_text(caption).strip(" ：:、")
    normalized_text = _normalize_text(text)
    if not normalized_caption or normalized_caption in normalized_text:
        return bool(normalized_caption)
    # MinerU may split a caption into a label and description across blocks.
    label = re.match(r"(?:图|表|Fig(?:ure)?|Table)\s*[\w一二三四五六七八九十.-]+", normalized_caption, re.I)
    return bool(label and label.group(0) in normalized_text)
