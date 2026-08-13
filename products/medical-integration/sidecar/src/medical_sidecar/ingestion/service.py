"""Stateless attachment batch preparation for REST and MCP."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
from typing import Any, Sequence

from ..config import IngestionLimits
from .contracts import AttachmentDescriptor, detect_format, safe_filename, safe_relative_path
from .parsers import ParserLimits, parse_attachment


@dataclass(frozen=True)
class AttachmentInput:
    filename: str
    data: bytes
    media_type: str = ""
    relative_path: str = ""


def prepare_attachment_batch(
    inputs: Sequence[AttachmentInput],
    *,
    limits: IngestionLimits,
) -> dict[str, Any]:
    if not inputs:
        raise ValueError("attachments must be a non-empty list")
    if len(inputs) > limits.max_files:
        raise ValueError("attachment count exceeds the configured budget")

    normalized: list[AttachmentInput] = []
    total_bytes = 0
    seen_paths: set[str] = set()
    for index, item in enumerate(inputs):
        filename = safe_filename(item.filename)
        relative_path = safe_relative_path(
            item.relative_path or filename,
            max_depth=limits.max_directory_depth,
        ).as_posix()
        if relative_path in seen_paths:
            raise ValueError(f"duplicate attachment relative_path: {relative_path}")
        seen_paths.add(relative_path)
        if len(item.data) > limits.max_file_bytes:
            raise ValueError(f"attachments[{index}] exceeds the per-file budget")
        total_bytes += len(item.data)
        if total_bytes > limits.max_total_bytes:
            raise ValueError("attachment total exceeds the configured budget")
        normalized.append(
            AttachmentInput(
                filename=filename,
                relative_path=relative_path,
                media_type=item.media_type,
                data=item.data,
            )
        )

    companions = {item.filename: item.data for item in normalized}
    parser_limits = ParserLimits(
        max_pages=limits.max_pages,
        max_frames=limits.max_frames,
        max_pixels=limits.max_pixels,
    )
    artifacts: list[dict[str, Any]] = []
    batch_warnings: list[str] = []
    aggregate_digest = hashlib.sha256()
    remaining_preview_bytes = 16 * 1024 * 1024
    for item in normalized:
        descriptor = AttachmentDescriptor.from_bytes(
            filename=item.filename,
            relative_path=item.relative_path,
            data=item.data,
            media_type=item.media_type,
        )
        aggregate_digest.update(descriptor.sha256.encode("ascii"))
        outcome = parse_attachment(
            item.data,
            filename=item.filename,
            media_type=item.media_type,
            companions=companions,
            limits=parser_limits,
        )
        retained_previews: list[dict[str, Any]] = []
        for preview in outcome.previews:
            size = int(preview.get("byte_size", 0))
            if size < 0 or size > remaining_preview_bytes:
                outcome.warnings.append("batch_preview_budget_exceeded")
                continue
            retained_previews.append(preview)
            remaining_preview_bytes -= size
        outcome.previews = retained_previews
        fmt = detect_format(item.filename, item.media_type)
        artifact = {
            "artifact_id": f"art_{descriptor.sha256[:16]}",
            "filename": descriptor.filename,
            "relative_path": descriptor.relative_path,
            "byte_size": descriptor.byte_size,
            "sha256": descriptor.sha256,
            "media_type": descriptor.media_type,
            "format": fmt.to_dict(),
            "supported": fmt.subtype != "unknown",
            "parsing_performed": True,
            **outcome.to_dict(),
        }
        artifacts.append(artifact)
        batch_warnings.extend(
            f"{descriptor.relative_path}: {warning}" for warning in outcome.warnings
        )

    summaries = [
        f"[{item['relative_path']}] {item['summary']}"
        for item in artifacts
        if item["included"] and item["summary"]
    ]
    summary = "\n\n".join(summaries)
    if len(summary) > 12_000:
        summary = summary[:11_970].rstrip() + "\n…[批次摘要已截断]"
        batch_warnings.append("attachment batch summary was truncated")
    return {
        "status": "prepared",
        "batch_id": f"batch_{aggregate_digest.hexdigest()[:24]}",
        "parsing_performed": True,
        "byte_size": total_bytes,
        "artifacts": artifacts,
        "summary_text": summary,
        "warnings": list(dict.fromkeys(batch_warnings)),
        "storage": "none",
    }

