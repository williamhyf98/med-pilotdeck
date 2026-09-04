"""Stable content-type and reliability labels for MinerU parse blocks."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any


CONTENT_TYPES = frozenset({"text", "image_caption", "table", "equation", "figure", "unknown"})
QUALITY_LEVELS = frozenset({"high", "medium", "low"})
_CAPTION = re.compile(r"^(?:图|表|Fig(?:ure)?\.?|Table\.?)[\s\d-]", re.IGNORECASE)


@dataclass(frozen=True)
class ContentQuality:
    content_type: str
    parse_quality: str
    structure_reliable: bool

    def __post_init__(self) -> None:
        if self.content_type not in CONTENT_TYPES:
            raise ValueError(f"unsupported content type: {self.content_type}")
        if self.parse_quality not in QUALITY_LEVELS:
            raise ValueError(f"unsupported quality level: {self.parse_quality}")

    def as_dict(self) -> dict[str, Any]:
        return {
            "content_type": self.content_type,
            "parse_quality": self.parse_quality,
            "structure_reliable": self.structure_reliable,
        }


def classify_mineru_block(block: dict[str, Any]) -> ContentQuality:
    """Classify a raw MinerU content-list block conservatively.

    ``table`` and ``equation`` are deliberately marked structurally unreliable
    until their corresponding model-specific regression suites pass.
    """

    raw_type = str(block.get("type") or "").lower()
    text = str(block.get("text") or "").strip()
    if raw_type == "table":
        return ContentQuality("table", "medium", False)
    if raw_type == "equation":
        return ContentQuality("equation", "low", False)
    if raw_type in {"image", "figure"}:
        return ContentQuality("figure", "medium", False)
    if raw_type == "text":
        if _CAPTION.match(text):
            return ContentQuality("image_caption", "high", True)
        return ContentQuality("text", "high", True)
    return ContentQuality("unknown", "low", False)


def annotate_mineru_blocks(blocks: list[Any]) -> list[dict[str, Any]]:
    """Return copies of valid MinerU blocks with the canonical metadata."""

    annotated: list[dict[str, Any]] = []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        item = dict(block)
        item.update(classify_mineru_block(item).as_dict())
        annotated.append(item)
    return annotated
