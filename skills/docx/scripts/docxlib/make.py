from __future__ import annotations

import json
import os
import re
import shutil
import uuid
from pathlib import Path
from typing import Any

from .audit import audit_docx
from .common import DocxSkillError, assert_valid_docx, load_json, temporary_sibling
from .core import create_docx
from .render import find_soffice, render_docx


HEADING_RE = re.compile(r"^(#{1,3})\s+(.+?)\s*$")
BULLET_RE = re.compile(r"^\s*[-*+]\s+(.+?)\s*$")
NUMBERED_RE = re.compile(r"^\s*\d+[.)]\s+(.+?)\s*$")


def _paragraphs(text: str) -> list[str]:
    return [
        paragraph.strip()
        for paragraph in re.split(r"\n\s*\n", text.strip())
        if paragraph.strip()
    ]


def _plain_text_blocks(text: str) -> list[dict[str, Any]]:
    return [{"type": "paragraph", "text": paragraph} for paragraph in _paragraphs(text)]


def _markdown_blocks(text: str, title: str | None) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    paragraph_lines: list[str] = []

    def flush_paragraph() -> None:
        if not paragraph_lines:
            return
        value = "\n".join(paragraph_lines).strip()
        paragraph_lines.clear()
        if value:
            blocks.append({"type": "paragraph", "text": value})

    for raw_line in text.splitlines():
        line = raw_line.rstrip()
        if not line.strip():
            flush_paragraph()
            continue
        heading = HEADING_RE.match(line)
        if heading:
            flush_paragraph()
            heading_text = heading.group(2).strip()
            if len(heading.group(1)) == 1 and title and heading_text == title:
                continue
            blocks.append(
                {
                    "type": "heading",
                    "level": min(3, len(heading.group(1))),
                    "text": heading_text,
                }
            )
            continue
        bullet = BULLET_RE.match(line)
        if bullet:
            flush_paragraph()
            blocks.append({"type": "bullet", "text": bullet.group(1).strip()})
            continue
        numbered = NUMBERED_RE.match(line)
        if numbered:
            flush_paragraph()
            blocks.append({"type": "numbered", "text": numbered.group(1).strip()})
            continue
        paragraph_lines.append(line.strip())
    flush_paragraph()
    return blocks


def _default_spec(title: str | None, body: str | None, markdown: str | None) -> dict[str, Any]:
    content: list[dict[str, Any]] = []
    if title:
        content.append({"type": "title", "text": title})
    if markdown is not None:
        content.extend(_markdown_blocks(markdown, title))
    elif body:
        content.extend(_plain_text_blocks(body))
    return {
        "style_policy": {
            "mode": "builtin",
            "template": "neutral-document-v1",
        },
        "document_structure": {"archetype": "simple"},
        "locale": "zh-CN",
        "page": "a4",
        "orientation": "portrait",
        "metadata": {"title": title or ""},
        "content": content,
    }


def _load_make_spec(
    *,
    title: str | None,
    body: str | None,
    body_file: str | Path | None,
    markdown_file: str | Path | None,
    spec_file: str | Path | None,
) -> dict[str, Any]:
    sources = sum(
        value is not None
        for value in (body, body_file, markdown_file, spec_file)
    )
    if sources > 1:
        raise DocxSkillError(
            "Use only one of --body, --body-file, --markdown, or --spec",
            code="conflicting-content-sources",
        )
    if body_file is not None:
        body = Path(body_file).expanduser().resolve().read_text(encoding="utf-8")
    markdown = (
        Path(markdown_file).expanduser().resolve().read_text(encoding="utf-8")
        if markdown_file is not None
        else None
    )
    if spec_file is not None:
        resolved_spec_file = Path(spec_file).expanduser().resolve()
        loaded = load_json(resolved_spec_file)
        if not isinstance(loaded, dict):
            raise DocxSkillError("DOCX make specification must be a JSON object")
        spec = dict(loaded)
        content = spec.get("content")
        if isinstance(content, list):
            for block in content:
                if (
                    isinstance(block, dict)
                    and block.get("type") == "image"
                    and isinstance(block.get("path"), str)
                ):
                    image_path = Path(block["path"]).expanduser()
                    if not image_path.is_absolute():
                        block["path"] = str(
                            (resolved_spec_file.parent / image_path).resolve()
                        )
        if title:
            metadata = dict(spec.get("metadata") or {})
            metadata["title"] = title
            spec["metadata"] = metadata
        return spec
    spec = _default_spec(title, body, markdown)
    if not spec["content"]:
        raise DocxSkillError(
            "DOCX make requires a title or document content",
            code="empty-document",
        )
    return spec


def _internal_work_root(output: Path) -> Path:
    configured = os.environ.get("PILOTDECK_WORK_DIR", "").strip()
    if configured:
        root = (
            Path(configured).expanduser().resolve()
            / "docx"
            / "make"
            / uuid.uuid4().hex
        )
        root.mkdir(parents=True, exist_ok=True)
        return root
    root = output.parent / ".docx-qa" / output.stem
    root.mkdir(parents=True, exist_ok=True)
    return root.resolve()


def make_docx(
    output_path: str | Path,
    *,
    title: str | None = None,
    body: str | None = None,
    body_file: str | Path | None = None,
    markdown_file: str | Path | None = None,
    spec_file: str | Path | None = None,
    force: bool = False,
) -> dict[str, Any]:
    output = Path(output_path).expanduser().resolve()
    if output.suffix.lower() != ".docx":
        raise DocxSkillError(f"DOCX output must end with .docx: {output}")
    if output.exists() and not force:
        raise DocxSkillError(
            f"output already exists; pass --force to replace: {output}",
            code="output-exists",
        )
    if output.exists() and not output.is_file():
        raise DocxSkillError(f"output path is not a file: {output}")

    spec = _load_make_spec(
        title=title,
        body=body,
        body_file=body_file,
        markdown_file=markdown_file,
        spec_file=spec_file,
    )
    work_root = _internal_work_root(output)
    spec_path = work_root / "spec.json"
    candidate = work_root / "candidate.docx"
    audit_path = work_root / "audit.json"
    render_dir = work_root / "render"
    spec_path.write_text(
        json.dumps(spec, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    creation = create_docx(spec_path, candidate, overwrite=True)
    audit = audit_docx(candidate, audit_path, profile="draft")
    preview: list[str] = []
    render_warning: str | None = None
    if find_soffice():
        try:
            rendered = render_docx(candidate, render_dir, dpi=144)
            preview = [str(path) for path in rendered.get("images", [])]
        except DocxSkillError as exc:
            if exc.code != "render-runtime-unavailable":
                raise
            render_warning = str(exc)
    else:
        render_warning = (
            "LibreOffice is unavailable; structural validation passed but "
            "page preview rendering was skipped"
        )

    output.parent.mkdir(parents=True, exist_ok=True)
    with temporary_sibling(output, suffix=".tmp.docx") as staged:
        shutil.copy2(candidate, staged)
        os.replace(staged, output)
    validation = assert_valid_docx(output)
    return {
        "status": "ok",
        "output": str(output),
        "preview": preview,
        "audit": {
            "status": audit.get("status"),
            "issues": audit.get("issues", []),
        },
        "validation": validation,
        "blocks": creation.get("blocks"),
        **({"warning": render_warning} if render_warning else {}),
    }
