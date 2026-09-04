"""Per-page content-type census for completed MinerU parse outputs."""

from __future__ import annotations

import hashlib
import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from .content_quality import annotate_mineru_blocks


def census_mineru_content_list(
    *, source_pdf: Path, content_list_path: Path, page_index_offset: int = 0
) -> list[dict[str, Any]]:
    """Produce one deterministic census row per parsed PDF page.

    The output is intentionally small and contains metrics only, not document
    text.  It can therefore be retained alongside a large corpus and compared
    across MinerU/model versions.
    """

    if page_index_offset < 0:
        raise ValueError("page_index_offset must be non-negative")
    raw = json.loads(content_list_path.read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        raise ValueError("MinerU content_list must be a JSON array")
    pages: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for block in annotate_mineru_blocks(raw):
        page = int(block.get("page_idx", 0)) + 1 + page_index_offset
        pages[page].append(block)
    document_id = hashlib.sha256(str(source_pdf.resolve()).encode("utf-8")).hexdigest()[:16]
    rows: list[dict[str, Any]] = []
    for page in sorted(pages):
        blocks = pages[page]
        types = Counter(str(block["content_type"]) for block in blocks)
        substantive = [block for block in blocks if block["content_type"] != "unknown"]
        chars = Counter(
            str(block["content_type"])
            for block in blocks
            for _ in range(len(str(block.get("text") or "")))
        )
        rows.append(
            {
                "document_id": document_id,
                "source_file": str(source_pdf.resolve()),
                "page": page,
                "block_count": len(blocks),
                "content_types": dict(sorted(types.items())),
                "characters_by_type": dict(sorted(chars.items())),
                "has_table": bool(types["table"]),
                "has_equation": bool(types["equation"]),
                "has_figure": bool(types["figure"]),
                "image_dominant": types["figure"] > types["text"] + types["image_caption"],
                # MinerU's discarded/header-footer blocks are retained as
                # ``unknown`` observations but must not downgrade a page that
                # otherwise has reliable text-only structure.
                "structure_reliable": bool(substantive) and all(
                    bool(block["structure_reliable"]) for block in substantive
                ),
            }
        )
    return rows


def write_census_jsonl(*, rows: list[dict[str, Any]], destination: Path) -> Path:
    """Write a new census atomically and never overwrite a prior run."""

    if not rows:
        raise ValueError("refusing to write an empty census")
    destination = destination.resolve()
    if destination.exists():
        raise FileExistsError(f"census destination already exists: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.tmp")
    if temporary.exists():
        raise FileExistsError(f"census temporary path already exists: {temporary}")
    with temporary.open("x", encoding="utf-8") as stream:
        for row in rows:
            stream.write(json.dumps(row, ensure_ascii=False, sort_keys=True))
            stream.write("\n")
    temporary.replace(destination)
    return destination
