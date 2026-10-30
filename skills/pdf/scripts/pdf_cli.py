#!/usr/bin/env python3
"""Deterministic PDF operations for the PilotDeck PDF skill."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Iterable

import pdfplumber
from PIL import Image, ImageDraw
from pypdf import PdfReader, PdfWriter


SKILL_ROOT = Path(os.environ.get("PDF_SKILL_ROOT", Path(__file__).resolve().parents[1]))
PDFINFO = os.environ.get("PDF_SKILL_PDFINFO", "pdfinfo")
PDFTOPPM = os.environ.get("PDF_SKILL_PDFTOPPM", "pdftoppm")
BUNDLED_FONT_NAME = "PilotDeckCJK"
_BUNDLED_FONT_REGISTERED = False


class PdfToolError(RuntimeError):
    pass


def resolved_file(value: str, label: str = "input") -> Path:
    path = Path(value).expanduser().resolve()
    if not path.is_file():
        raise PdfToolError(f"{label} file does not exist: {path}")
    return path


def output_file(value: str) -> Path:
    path = Path(value).expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def output_dir(value: str) -> Path:
    path = Path(value).expanduser().resolve()
    path.mkdir(parents=True, exist_ok=True)
    return path


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def emit(payload: Any) -> None:
    print(json.dumps(payload, ensure_ascii=False))


def same_path(first: Path, second: Path) -> bool:
    try:
        return first.samefile(second)
    except FileNotFoundError:
        return first == second


def require_distinct(input_path: Path, output_path: Path) -> None:
    if same_path(input_path, output_path):
        raise PdfToolError("input and output must be different paths")


def bundled_font_name() -> str:
    """Register and return the skill-bundled CJK font. Never search the system."""
    global _BUNDLED_FONT_REGISTERED
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont

    if _BUNDLED_FONT_REGISTERED:
        return BUNDLED_FONT_NAME
    fonts_dir = SKILL_ROOT / "assets" / "fonts"
    candidates = [
        fonts_dir / "NotoSansSC-VF.ttf",
        fonts_dir / "NotoSansSC-Regular.ttf",
        fonts_dir / "NotoSansSC-Regular.otf",
    ]
    last_error: Exception | None = None
    found = False
    for path in candidates:
        if not path.is_file():
            continue
        found = True
        try:
            pdfmetrics.registerFont(TTFont(BUNDLED_FONT_NAME, str(path)))
            _BUNDLED_FONT_REGISTERED = True
            return BUNDLED_FONT_NAME
        except Exception as exc:
            last_error = exc
    if found and last_error is not None:
        raise PdfToolError(f"交付包不完整：捆绑字体无法加载：{last_error}")
    raise PdfToolError("交付包不完整：缺少捆绑中文字体（assets/fonts）。")


def xml_escape(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def paragraph_blocks(text: str) -> list[str]:
    if not text or not text.strip():
        return []
    chunks = re.split(r"\n\s*\n", text.strip())
    return [chunk.strip() for chunk in chunks if chunk.strip()]


def format_make_text(text: str) -> str:
    escaped = xml_escape(text)
    escaped = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", escaped)
    lines: list[str] = []
    for line in escaped.split("\n"):
        stripped = line.lstrip()
        if stripped.startswith("- ") or stripped.startswith("* "):
            lines.append("• " + stripped[2:])
        else:
            lines.append(line)
    return "<br/>".join(lines)


def flowable_paragraph(text: str, style: Any) -> Any:
    from reportlab.platypus import Paragraph

    return Paragraph(format_make_text(text), style)


MAX_IMAGE_PIXELS = 80_000_000
DEFAULT_IMAGE_WIDTH_MM = 120.0
MAX_IMAGE_WIDTH_MM = 170.0


def resolve_local_image(path_value: Any, *, base_dir: Path, label: str) -> Path:
    raw_value = str(path_value or "").strip()
    if not raw_value:
        raise PdfToolError(f"{label}: image path is required")
    if raw_value.startswith(("http://", "https://")):
        raise PdfToolError(
            f"{label}: remote images are not allowed; use a local workspace path "
            "(prefer absolute $WS/inbox/... from the user attachment list)"
        )
    raw_path = Path(raw_value).expanduser()
    image_path = raw_path if raw_path.is_absolute() else (base_dir / raw_path)
    image_path = image_path.resolve()
    if not image_path.is_file():
        raise PdfToolError(f"{label}: image not found: {image_path}")
    return image_path


def normalize_make_image(
    raw: Any,
    *,
    label: str,
    base_dir: Path,
) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise PdfToolError(f"{label} must be an object")
    block_type = raw.get("type")
    if block_type not in (None, "image"):
        raise PdfToolError(f"{label}: unsupported type {block_type!r}; only image is allowed")
    path = resolve_local_image(raw.get("path"), base_dir=base_dir, label=label)
    width_mm = raw.get("width_mm")
    if width_mm is None and raw.get("width_inches") is not None:
        try:
            width_mm = float(raw["width_inches"]) * 25.4
        except (TypeError, ValueError) as exc:
            raise PdfToolError(f"{label}: width_inches must be a number") from exc
    if width_mm is None:
        width_mm = DEFAULT_IMAGE_WIDTH_MM
    try:
        width_mm = float(width_mm)
    except (TypeError, ValueError) as exc:
        raise PdfToolError(f"{label}: width_mm must be a number") from exc
    if width_mm <= 0:
        raise PdfToolError(f"{label}: width_mm must be positive")
    width_mm = min(width_mm, MAX_IMAGE_WIDTH_MM)
    caption = raw.get("caption") or raw.get("alt_text") or ""
    if caption is None:
        caption = ""
    if not isinstance(caption, str):
        raise PdfToolError(f"{label}: caption must be a string")
    return {
        "type": "image",
        "path": str(path),
        "width_mm": width_mm,
        "caption": caption.strip(),
    }


def normalize_image_list(
    raw: Any,
    *,
    label: str,
    base_dir: Path,
) -> list[dict[str, Any]]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise PdfToolError(f"{label} must be an array")
    images: list[dict[str, Any]] = []
    for index, item in enumerate(raw, start=1):
        images.append(
            normalize_make_image(item, label=f"{label}[{index}]", base_dir=base_dir)
        )
    return images


def prepare_image_flowables(
    images: list[dict[str, Any]],
    *,
    caption_style: Any,
) -> list[Any]:
    from io import BytesIO

    from reportlab.lib.units import mm
    from reportlab.platypus import Image as RLImage, Spacer

    flowables: list[Any] = []
    for image in images:
        path = Path(image["path"])
        try:
            with Image.open(path) as source:
                source.load()
                width_px, height_px = source.size
                if width_px < 1 or height_px < 1:
                    raise PdfToolError(f"image has invalid dimensions: {path}")
                if width_px * height_px > MAX_IMAGE_PIXELS:
                    raise PdfToolError(f"image is too large to embed safely: {path}")
                rgba = source.convert("RGBA")
                white = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
                flattened = Image.alpha_composite(white, rgba).convert("RGB")
                stream = BytesIO()
                flattened.save(stream, format="PNG", optimize=True)
                stream.seek(0)
        except PdfToolError:
            raise
        except OSError as exc:
            raise PdfToolError(f"unable to decode image: {path} ({exc})") from exc

        width_mm = float(image["width_mm"])
        height_mm = width_mm * (height_px / width_px)
        flowable = RLImage(stream, width=width_mm * mm, height=height_mm * mm)
        flowable.hAlign = "CENTER"
        flowables.append(Spacer(1, 2 * mm))
        flowables.append(flowable)
        caption = image.get("caption") or ""
        if caption:
            flowables.append(Spacer(1, 1.5 * mm))
            flowables.append(flowable_paragraph(caption, caption_style))
        flowables.append(Spacer(1, 2 * mm))
    return flowables


HEADING_LINE = re.compile(r"^(#{1,6})\s+(.*)$")


def parse_markdown_source(text: str) -> dict[str, Any]:
    """Split ATX markdown into title, preamble body, and heading sections."""
    preamble: list[str] = []
    sections: list[dict[str, Any]] = []
    title: str | None = None
    current: dict[str, Any] | None = None
    saw_preamble = False

    def flush() -> None:
        nonlocal current
        if current is None:
            return
        current["body"] = str(current["body"]).strip()
        if current["heading"] or current["body"]:
            sections.append(current)
        current = None

    for raw in text.replace("\r\n", "\n").split("\n"):
        match = HEADING_LINE.match(raw)
        if match is None:
            if current is None:
                preamble.append(raw)
                if raw.strip():
                    saw_preamble = True
            else:
                current["body"] += raw + "\n"
            continue
        heading = match.group(2).strip()
        level = len(match.group(1))
        if title is None and current is None and not saw_preamble and level == 1:
            title = heading
            continue
        flush()
        current = {"heading": heading, "body": "", "level": level}
    flush()
    return {"title": title, "body": "\n".join(preamble).strip(), "sections": sections}


def pdfinfo_data(path: Path) -> dict[str, Any]:
    result = subprocess.run(
        [PDFINFO, str(path)],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise PdfToolError(f"pdfinfo failed: {result.stderr.strip() or result.stdout.strip()}")
    parsed: dict[str, str] = {}
    for line in result.stdout.splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        parsed[key.strip()] = value.strip()
    return {"raw": parsed, "command": PDFINFO}


def safe_pdf_value(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (list, tuple)):
        return [safe_pdf_value(item) for item in value]
    if isinstance(value, dict):
        return {str(key): safe_pdf_value(item) for key, item in value.items()}
    try:
        return str(value)
    except Exception:
        return repr(value)


def page_geometry(page: Any) -> dict[str, Any]:
    box = page.mediabox
    width = float(box.width)
    height = float(box.height)
    return {
        "widthPoints": round(width, 3),
        "heightPoints": round(height, 3),
        "widthMm": round(width * 25.4 / 72, 2),
        "heightMm": round(height * 25.4 / 72, 2),
        "rotation": int(page.get("/Rotate", 0) or 0),
    }


def form_summary(reader: PdfReader) -> dict[str, Any]:
    try:
        fields = reader.get_fields() or {}
    except Exception as exc:
        return {"count": 0, "error": str(exc), "fields": []}
    rows = []
    for name, field in fields.items():
        rows.append(
            {
                "name": name,
                "type": safe_pdf_value(field.get("/FT")),
                "value": safe_pdf_value(field.get("/V")),
                "defaultValue": safe_pdf_value(field.get("/DV")),
                "options": safe_pdf_value(field.get("/Opt")),
                "flags": safe_pdf_value(field.get("/Ff")),
                "alternateName": safe_pdf_value(field.get("/TU")),
            }
        )
    return {"count": len(rows), "fields": rows}


def inspect_document(
    input_path: Path,
    *,
    include_text: bool = False,
    include_tables: bool = False,
) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    info = pdfinfo_data(input_path)
    reader = PdfReader(str(input_path))
    metadata = {str(key): safe_pdf_value(value) for key, value in (reader.metadata or {}).items()}
    pages: list[dict[str, Any]] = []
    text_pages: list[dict[str, Any]] = []
    table_pages: list[dict[str, Any]] = []

    with pdfplumber.open(str(input_path)) as document:
        for index, page in enumerate(document.pages, start=1):
            text = page.extract_text(layout=True) or ""
            words = page.extract_words() or []
            tables = page.extract_tables() if include_tables else []
            geometry = page_geometry(reader.pages[index - 1])
            pages.append(
                {
                    "page": index,
                    **geometry,
                    "characters": len(page.chars),
                    "words": len(words),
                    "images": len(page.images),
                    "detectedTables": len(tables) if include_tables else None,
                    "textPreview": re.sub(r"\s+", " ", text).strip()[:280],
                }
            )
            if include_text:
                text_pages.append({"page": index, "text": text})
            if include_tables:
                table_pages.append({"page": index, "tables": safe_pdf_value(tables)})

    summary = {
        "status": "ok",
        "input": str(input_path),
        "sizeBytes": input_path.stat().st_size,
        "pdfinfo": info,
        "encrypted": bool(reader.is_encrypted),
        "pageCount": len(reader.pages),
        "metadata": metadata,
        "forms": form_summary(reader),
        "pages": pages,
    }
    return summary, text_pages, table_pages


def command_inspect(args: argparse.Namespace) -> int:
    input_path = resolved_file(args.input)
    payload, texts, tables = inspect_document(
        input_path,
        include_text=bool(args.text_out),
        include_tables=bool(args.tables_out),
    )
    out = output_file(args.out)
    write_json(out, payload)
    if args.text_out:
        write_json(output_file(args.text_out), {"input": str(input_path), "pages": texts})
    if args.tables_out:
        write_json(output_file(args.tables_out), {"input": str(input_path), "pages": tables})
    emit({"status": "ok", "report": str(out), "pages": payload["pageCount"]})
    return 0


def audit_document(input_path: Path) -> dict[str, Any]:
    hard_failures: list[str] = []
    warnings: list[str] = []
    pages: list[dict[str, Any]] = []
    metadata: dict[str, Any] = {}
    encrypted = False
    forms: dict[str, Any] = {"count": 0, "fields": []}

    try:
        info = pdfinfo_data(input_path)
    except Exception as exc:
        info = {"error": str(exc)}
        hard_failures.append(str(exc))

    try:
        reader = PdfReader(str(input_path))
        encrypted = bool(reader.is_encrypted)
        if encrypted:
            hard_failures.append("PDF is encrypted and cannot be fully audited")
        if len(reader.pages) == 0:
            hard_failures.append("PDF has no pages")
        metadata = {str(key): safe_pdf_value(value) for key, value in (reader.metadata or {}).items()}
        forms = form_summary(reader)
        with pdfplumber.open(str(input_path)) as document:
            for index, page in enumerate(document.pages, start=1):
                geometry = page_geometry(reader.pages[index - 1])
                width = geometry["widthPoints"]
                height = geometry["heightPoints"]
                if width <= 0 or height <= 0:
                    hard_failures.append(f"page {index} has invalid dimensions")
                char_count = len(page.chars)
                image_count = len(page.images)
                if char_count == 0 and image_count == 0:
                    warnings.append(f"page {index} appears empty")
                pages.append(
                    {
                        "page": index,
                        **geometry,
                        "characters": char_count,
                        "images": image_count,
                    }
                )
    except Exception as exc:
        hard_failures.append(f"PDF parsing failed: {exc}")

    sizes = {(page["widthPoints"], page["heightPoints"]) for page in pages}
    if len(sizes) > 1:
        warnings.append("document contains multiple page sizes")
    rotations = {page["rotation"] for page in pages}
    if any(rotation % 90 != 0 for rotation in rotations):
        warnings.append("document contains a non-right-angle page rotation")

    return {
        "status": "failed" if hard_failures else "ok",
        "input": str(input_path),
        "sizeBytes": input_path.stat().st_size,
        "pdfinfo": info,
        "encrypted": encrypted,
        "metadata": metadata,
        "forms": forms,
        "pageCount": len(pages),
        "pages": pages,
        "hardFailures": hard_failures,
        "warnings": warnings,
    }


def command_audit(args: argparse.Namespace) -> int:
    input_path = resolved_file(args.input)
    payload = audit_document(input_path)
    out = output_file(args.out)
    write_json(out, payload)
    emit(
        {
            "status": payload["status"],
            "report": str(out),
            "hardFailures": len(payload["hardFailures"]),
            "warnings": len(payload["warnings"]),
        }
    )
    return 3 if payload["hardFailures"] else 0


def natural_page_key(path: Path) -> tuple[int, str]:
    match = re.search(r"-(\d+)\.png$", path.name)
    return (int(match.group(1)) if match else 10**9, path.name)


def create_montage(images: list[Path], destination: Path) -> None:
    if not images:
        raise PdfToolError("cannot create a montage without rendered pages")
    thumbnails: list[tuple[Path, Image.Image]] = []
    max_width = 360
    for path in images:
        with Image.open(path) as source:
            preview = source.convert("RGB")
            preview.thumbnail((max_width, 520))
            thumbnails.append((path, preview.copy()))

    label_height = 28
    gap = 18
    columns = 3 if len(thumbnails) > 1 else 1
    rows = (len(thumbnails) + columns - 1) // columns
    cell_width = max(image.width for _, image in thumbnails) + gap
    cell_height = max(image.height for _, image in thumbnails) + label_height + gap
    canvas = Image.new("RGB", (columns * cell_width + gap, rows * cell_height + gap), "#E8EDF3")
    draw = ImageDraw.Draw(canvas)
    for index, (path, image) in enumerate(thumbnails):
        column = index % columns
        row = index // columns
        x = gap + column * cell_width + (cell_width - gap - image.width) // 2
        y = gap + row * cell_height
        canvas.paste(image, (x, y))
        draw.text((gap + column * cell_width, y + image.height + 6), path.stem, fill="#172033")
    destination.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(destination)


def render_document(input_path: Path, out_dir_path: Path, dpi: int, montage: Path | None) -> list[Path]:
    if dpi < 72 or dpi > 600:
        raise PdfToolError("dpi must be between 72 and 600")
    out_dir_path.mkdir(parents=True, exist_ok=True)
    for stale in out_dir_path.glob("page-*.png"):
        stale.unlink()
    prefix = out_dir_path / "page"
    result = subprocess.run(
        [PDFTOPPM, "-png", "-r", str(dpi), str(input_path), str(prefix)],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise PdfToolError(f"pdftoppm failed: {result.stderr.strip() or result.stdout.strip()}")
    images = sorted(out_dir_path.glob("page-*.png"), key=natural_page_key)
    expected = len(PdfReader(str(input_path)).pages)
    if len(images) != expected:
        raise PdfToolError(f"rendered {len(images)} pages, expected {expected}")
    if montage is not None:
        create_montage(images, montage)
    return images


def command_render(args: argparse.Namespace) -> int:
    input_path = resolved_file(args.input)
    out_dir_path = output_dir(args.out_dir)
    montage = output_file(args.montage) if args.montage else None
    images = render_document(input_path, out_dir_path, args.dpi, montage)
    emit(
        {
            "status": "ok",
            "input": str(input_path),
            "outDir": str(out_dir_path),
            "pages": [str(path) for path in images],
            "montage": str(montage) if montage else None,
        }
    )
    return 0


def command_scaffold(args: argparse.Namespace) -> int:
    source = SKILL_ROOT / "assets" / "starter_pdf.py"
    destination = output_file(args.out)
    if destination.exists() and not args.force:
        raise PdfToolError(f"output already exists; pass --force to replace: {destination}")
    shutil.copyfile(source, destination)
    destination.chmod(destination.stat().st_mode | 0o100)
    emit({"status": "ok", "builder": str(destination)})
    return 0


def command_build(args: argparse.Namespace) -> int:
    builder = resolved_file(args.builder, "builder")
    out = output_file(args.out)
    result = subprocess.run(
        [sys.executable, str(builder), "--out", str(out)],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise PdfToolError(f"builder failed: {result.stderr.strip() or result.stdout.strip()}")
    if not out.is_file():
        raise PdfToolError(f"builder did not create the requested output: {out}")
    audit = audit_document(out)
    if audit["hardFailures"]:
        raise PdfToolError("built PDF failed structural audit: " + "; ".join(audit["hardFailures"]))
    emit(
        {
            "status": "ok",
            "output": str(out),
            "pages": audit["pageCount"],
            "warnings": audit["warnings"],
        }
    )
    return 0


def load_make_spec(args: argparse.Namespace) -> dict[str, Any]:
    spec: dict[str, Any] = {}
    markdown_path = getattr(args, "markdown", None)
    body_file = getattr(args, "body_file", None)
    if markdown_path and body_file:
        raise PdfToolError("provide only one of --markdown or --body-file")
    base_dir = Path.cwd()
    if args.spec:
        spec_path = resolved_file(args.spec, "spec")
        base_dir = spec_path.parent
        payload = json.loads(spec_path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            raise PdfToolError("spec must be a JSON object")
        spec = payload
    markdown: dict[str, Any] | None = None
    if markdown_path:
        markdown = parse_markdown_source(resolved_file(markdown_path, "markdown").read_text(encoding="utf-8"))
        if not spec.get("title") and markdown["title"]:
            spec["title"] = markdown["title"]
        if spec.get("body") in (None, "") and markdown["body"]:
            spec["body"] = markdown["body"]
        if not spec.get("sections") and markdown["sections"]:
            spec["sections"] = markdown["sections"]
    title = args.title if args.title is not None else spec.get("title")
    if not isinstance(title, str) or not title.strip():
        raise PdfToolError("make requires --title, spec.title, or a top-level # heading in --markdown")
    if args.body is not None:
        body = args.body
    elif body_file:
        body = resolved_file(body_file, "body").read_text(encoding="utf-8")
    else:
        body = spec.get("body", "")
    if body is None:
        body = ""
    if not isinstance(body, str):
        raise PdfToolError("body must be a string")
    author = args.author if args.author is not None else spec.get("author", "PilotDeck")
    if not isinstance(author, str) or not author.strip():
        author = "PilotDeck"
    sections = spec.get("sections") or []
    if not isinstance(sections, list):
        raise PdfToolError("spec.sections must be an array")
    top_images = normalize_image_list(
        spec.get("images"),
        label="spec.images",
        base_dir=base_dir,
    )
    normalized: list[dict[str, Any]] = []
    for index, section in enumerate(sections, start=1):
        if not isinstance(section, dict):
            raise PdfToolError(f"spec.sections[{index}] must be an object")
        heading = section.get("heading") or section.get("title") or ""
        section_body = section.get("body") or ""
        level = section.get("level", 2)
        if not isinstance(heading, str) or not isinstance(section_body, str):
            raise PdfToolError(f"spec.sections[{index}] heading/body must be strings")
        if not isinstance(level, int):
            level = 2
        section_images = normalize_image_list(
            section.get("images"),
            label=f"spec.sections[{index}].images",
            base_dir=base_dir,
        )
        if not heading.strip() and not section_body.strip() and not section_images:
            continue
        normalized.append(
            {
                "heading": heading.strip(),
                "body": section_body,
                "level": level,
                "images": section_images,
            }
        )
    if markdown and not normalized and markdown["body"] and not body.strip():
        body = markdown["body"]
    return {
        "title": title.strip(),
        "body": body,
        "author": author.strip(),
        "sections": normalized,
        "images": top_images,
    }


def write_made_pdf(output: Path, spec: dict[str, Any]) -> None:
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_CENTER, TA_LEFT
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import SimpleDocTemplate, Spacer

    font_name = bundled_font_name()
    output.parent.mkdir(parents=True, exist_ok=True)
    ink = colors.HexColor("#172033")
    muted = colors.HexColor("#5F6B7A")
    rule = colors.HexColor("#D8E0EA")
    title_text = spec["title"]

    def header_footer(canvas, doc) -> None:
        canvas.saveState()
        canvas.setStrokeColor(rule)
        canvas.setLineWidth(0.5)
        canvas.line(doc.leftMargin, 18 * mm, A4[0] - doc.rightMargin, 18 * mm)
        canvas.setFillColor(muted)
        canvas.setFont(font_name, 8)
        canvas.drawString(doc.leftMargin, 11 * mm, title_text[:48])
        canvas.drawRightString(A4[0] - doc.rightMargin, 11 * mm, f"{doc.page}")
        canvas.restoreState()

    doc = SimpleDocTemplate(
        str(output),
        pagesize=A4,
        rightMargin=20 * mm,
        leftMargin=20 * mm,
        topMargin=20 * mm,
        bottomMargin=25 * mm,
        title=title_text,
        author=spec["author"],
    )
    base = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "MakeTitle",
        parent=base["Title"],
        fontName=font_name,
        fontSize=22,
        leading=28,
        textColor=ink,
        alignment=TA_LEFT,
        spaceAfter=8 * mm,
    )
    heading_style = ParagraphStyle(
        "MakeHeading",
        parent=base["Heading2"],
        fontName=font_name,
        fontSize=13,
        leading=18,
        textColor=ink,
        spaceBefore=4 * mm,
        spaceAfter=2.5 * mm,
    )
    subheading_style = ParagraphStyle(
        "MakeSubheading",
        parent=heading_style,
        fontSize=11,
        leading=15,
        spaceBefore=3 * mm,
        spaceAfter=2 * mm,
    )
    body_style = ParagraphStyle(
        "MakeBody",
        parent=base["BodyText"],
        fontName=font_name,
        fontSize=11,
        leading=16,
        textColor=ink,
        spaceAfter=3 * mm,
    )
    caption_style = ParagraphStyle(
        "MakeCaption",
        parent=body_style,
        fontSize=9,
        leading=12,
        textColor=muted,
        alignment=TA_CENTER,
        spaceAfter=1 * mm,
    )

    story: list[Any] = [flowable_paragraph(title_text, title_style)]
    for block in paragraph_blocks(spec["body"]):
        story.append(flowable_paragraph(block, body_style))
    story.extend(
        prepare_image_flowables(spec.get("images") or [], caption_style=caption_style)
    )
    for section in spec["sections"]:
        heading = section["heading"]
        style = subheading_style if int(section.get("level", 2) or 2) >= 4 else heading_style
        if heading:
            story.append(flowable_paragraph(heading, style))
        for block in paragraph_blocks(section["body"]):
            story.append(flowable_paragraph(block, body_style))
        story.extend(
            prepare_image_flowables(section.get("images") or [], caption_style=caption_style)
        )
        if heading and not paragraph_blocks(section["body"]) and not (section.get("images") or []):
            story.append(Spacer(1, 1 * mm))
    if not story:
        raise PdfToolError("make produced no content")
    doc.build(story, onFirstPage=header_footer, onLaterPages=header_footer)


def command_make(args: argparse.Namespace) -> int:
    spec = load_make_spec(args)
    out = Path(args.out).expanduser().resolve()
    if out.exists() and not args.force:
        raise PdfToolError(f"output already exists; pass --force to replace: {out}")
    out.parent.mkdir(parents=True, exist_ok=True)
    write_made_pdf(out, spec)
    if not out.is_file():
        raise PdfToolError(f"make did not create the requested output: {out}")
    audit = audit_document(out)
    if audit["hardFailures"]:
        raise PdfToolError("built PDF failed structural audit: " + "; ".join(audit["hardFailures"]))
    preview_dir = out.parent / ".pdf-qa" / out.stem
    images = render_document(out, preview_dir, 144, None)
    audit_path = preview_dir / "audit.json"
    write_json(audit_path, audit)
    emit(
        {
            "status": "ok",
            "output": str(out),
            "pages": audit["pageCount"],
            "preview": [str(path) for path in images],
            "audit": str(audit_path),
            "warnings": audit["warnings"],
        }
    )
    return 0


def command_merge(args: argparse.Namespace) -> int:
    inputs = [resolved_file(value) for value in args.inputs]
    out = output_file(args.out)
    if any(same_path(path, out) for path in inputs):
        raise PdfToolError("output must be different from every input")
    writer = PdfWriter()
    total_pages = 0
    for input_path in inputs:
        reader = PdfReader(str(input_path))
        if reader.is_encrypted:
            raise PdfToolError(f"cannot merge encrypted PDF: {input_path}")
        for page in reader.pages:
            writer.add_page(page)
            total_pages += 1
    with out.open("wb") as handle:
        writer.write(handle)
    emit({"status": "ok", "output": str(out), "inputs": len(inputs), "pages": total_pages})
    return 0


def parse_pages(spec: str | None, count: int) -> list[int]:
    if spec is None or spec.strip().lower() == "all":
        return list(range(count))
    selected: list[int] = []
    for token in spec.split(","):
        token = token.strip()
        if not token:
            continue
        if "-" in token:
            first_text, last_text = token.split("-", 1)
            first, last = int(first_text), int(last_text)
            if first > last:
                raise PdfToolError(f"invalid descending page range: {token}")
            values: Iterable[int] = range(first, last + 1)
        else:
            values = [int(token)]
        for value in values:
            if value < 1 or value > count:
                raise PdfToolError(f"page {value} is outside 1-{count}")
            zero_based = value - 1
            if zero_based not in selected:
                selected.append(zero_based)
    if not selected:
        raise PdfToolError("page selection is empty")
    return selected


def command_split(args: argparse.Namespace) -> int:
    input_path = resolved_file(args.input)
    reader = PdfReader(str(input_path))
    if reader.is_encrypted:
        raise PdfToolError("cannot split an encrypted PDF")
    selected = parse_pages(args.pages, len(reader.pages))
    out_dir_path = output_dir(args.out_dir)
    outputs = []
    for page_index in selected:
        writer = PdfWriter()
        writer.add_page(reader.pages[page_index])
        out = out_dir_path / f"page-{page_index + 1}.pdf"
        with out.open("wb") as handle:
            writer.write(handle)
        outputs.append(str(out))
    emit({"status": "ok", "input": str(input_path), "outputs": outputs})
    return 0


def command_rotate(args: argparse.Namespace) -> int:
    input_path = resolved_file(args.input)
    out = output_file(args.out)
    require_distinct(input_path, out)
    if args.degrees % 90 != 0:
        raise PdfToolError("degrees must be a multiple of 90")
    reader = PdfReader(str(input_path))
    if reader.is_encrypted:
        raise PdfToolError("cannot rotate an encrypted PDF")
    selected = set(parse_pages(args.pages, len(reader.pages)))
    writer = PdfWriter()
    for index, page in enumerate(reader.pages):
        if index in selected:
            page.rotate(args.degrees)
        writer.add_page(page)
    if reader.metadata:
        writer.add_metadata({str(key): str(value) for key, value in reader.metadata.items() if value is not None})
    with out.open("wb") as handle:
        writer.write(handle)
    emit(
        {
            "status": "ok",
            "output": str(out),
            "degrees": args.degrees,
            "pages": [index + 1 for index in sorted(selected)],
        }
    )
    return 0


def command_forms_inspect(args: argparse.Namespace) -> int:
    input_path = resolved_file(args.input)
    reader = PdfReader(str(input_path))
    payload = {
        "status": "ok",
        "input": str(input_path),
        "pageCount": len(reader.pages),
        "forms": form_summary(reader),
    }
    out = output_file(args.out)
    write_json(out, payload)
    emit({"status": "ok", "report": str(out), "fields": payload["forms"]["count"]})
    return 0


def read_form_values(args: argparse.Namespace) -> dict[str, Any]:
    if bool(args.data) == bool(args.values):
        raise PdfToolError("provide exactly one of --data or --values")
    if args.data:
        data_path = resolved_file(args.data, "form data")
        payload = json.loads(data_path.read_text(encoding="utf-8"))
    else:
        payload = json.loads(args.values)
    if not isinstance(payload, dict):
        raise PdfToolError("form values must be a JSON object")
    return payload


def command_forms_fill(args: argparse.Namespace) -> int:
    input_path = resolved_file(args.input)
    out = output_file(args.out)
    require_distinct(input_path, out)
    values = read_form_values(args)
    reader = PdfReader(str(input_path))
    if reader.is_encrypted:
        raise PdfToolError("cannot fill an encrypted PDF")
    fields = reader.get_fields() or {}
    if not fields:
        raise PdfToolError("PDF does not contain AcroForm fields")
    unknown = sorted(set(values) - set(fields))
    if unknown:
        raise PdfToolError("unknown form field names: " + ", ".join(unknown))
    writer = PdfWriter()
    writer.clone_document_from_reader(reader)
    for page in writer.pages:
        writer.update_page_form_field_values(page, values, auto_regenerate=False)
    with out.open("wb") as handle:
        writer.write(handle)
    emit({"status": "ok", "output": str(out), "updatedFields": sorted(values)})
    return 0


def run_self_test_command(arguments: list[str]) -> None:
    result = subprocess.run([sys.executable, str(Path(__file__).resolve()), *arguments], check=False)
    if result.returncode != 0:
        raise PdfToolError(f"self-test command failed ({result.returncode}): {' '.join(arguments)}")


def create_self_test_form(path: Path) -> None:
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas

    document = canvas.Canvas(str(path), pagesize=A4)
    document.setTitle("PilotDeck form self-test")
    document.setFont("Helvetica-Bold", 16)
    document.drawString(72, A4[1] - 86, "PDF form self-test")
    document.setFont("Helvetica", 10)
    document.drawString(72, A4[1] - 124, "Full name")
    document.acroForm.textfield(
        name="full_name",
        tooltip="Full name",
        x=72,
        y=A4[1] - 164,
        width=260,
        height=24,
        borderWidth=1,
        forceBorder=True,
    )
    document.save()


def command_self_test(args: argparse.Namespace) -> int:
    root = output_dir(args.out)
    pdf = root / "sample.pdf"
    audit = root / "audit.json"
    inspection = root / "inspection.json"
    text = root / "text.json"
    tables = root / "tables.json"
    render_dir = root / "render"
    montage = root / "montage.png"
    split_dir = root / "split"
    rotated = root / "rotated.pdf"
    merged = root / "merged.pdf"
    rotated_audit = root / "rotated-audit.json"
    merged_audit = root / "merged-audit.json"
    form = root / "form.pdf"
    form_fields = root / "form-fields.json"
    filled_form = root / "filled-form.pdf"
    filled_form_audit = root / "filled-form-audit.json"
    form_render_dir = root / "form-render"

    run_self_test_command(
        [
            "make",
            "--title",
            "病例报告",
            "--body",
            "【病例报告】",
            "--out",
            str(pdf),
            "--force",
        ]
    )

    illustration = root / "illustration.png"
    with Image.new("RGB", (320, 200), "#2F6FED") as canvas:
        draw = ImageDraw.Draw(canvas)
        draw.rectangle((24, 24, 296, 176), outline="#FFFFFF", width=4)
        draw.text((96, 88), "PDF QA", fill="#FFFFFF")
        canvas.save(illustration)
    image_spec = root / "with-image.json"
    image_pdf = root / "with-image.pdf"
    image_inspection = root / "with-image-inspection.json"
    write_json(
        image_spec,
        {
            "title": "带图病例报告",
            "body": "正文后嵌入本地图片。",
            "images": [
                {
                    "type": "image",
                    "path": str(illustration),
                    "width_mm": 90,
                    "caption": "图 1 示意图",
                }
            ],
            "sections": [
                {
                    "heading": "创面",
                    "body": "小节内再嵌一张图。",
                    "images": [
                        {
                            "path": str(illustration),
                            "width_mm": 70,
                            "caption": "图 2 创面",
                        }
                    ],
                }
            ],
        },
    )
    run_self_test_command(
        [
            "make",
            "--spec",
            str(image_spec),
            "--out",
            str(image_pdf),
            "--force",
        ]
    )
    run_self_test_command(
        [
            "inspect",
            "--input",
            str(image_pdf),
            "--out",
            str(image_inspection),
        ]
    )
    image_pages = json.loads(image_inspection.read_text(encoding="utf-8")).get("pages") or []
    embedded_images = sum(int(page.get("images") or 0) for page in image_pages)
    if embedded_images < 2:
        raise PdfToolError(
            f"self-test expected at least 2 embedded images, found {embedded_images}"
        )

    run_self_test_command(
        [
            "inspect",
            "--input",
            str(pdf),
            "--out",
            str(inspection),
            "--text-out",
            str(text),
            "--tables-out",
            str(tables),
        ]
    )
    run_self_test_command(["audit", "--input", str(pdf), "--out", str(audit)])
    run_self_test_command(
        ["render", "--input", str(pdf), "--out-dir", str(render_dir), "--montage", str(montage)]
    )
    run_self_test_command(["split", "--input", str(pdf), "--out-dir", str(split_dir), "--pages", "1"])
    run_self_test_command(
        ["rotate", "--input", str(pdf), "--out", str(rotated), "--degrees", "90", "--pages", "1"]
    )
    run_self_test_command(
        ["merge", "--inputs", str(pdf), str(split_dir / "page-1.pdf"), "--out", str(merged)]
    )
    run_self_test_command(["audit", "--input", str(rotated), "--out", str(rotated_audit)])
    run_self_test_command(["audit", "--input", str(merged), "--out", str(merged_audit)])

    create_self_test_form(form)
    run_self_test_command(["forms-inspect", "--input", str(form), "--out", str(form_fields)])
    run_self_test_command(
        [
            "forms-fill",
            "--input",
            str(form),
            "--values",
            '{"full_name":"PilotDeck QA"}',
            "--out",
            str(filled_form),
        ]
    )
    run_self_test_command(["audit", "--input", str(filled_form), "--out", str(filled_form_audit)])
    run_self_test_command(
        ["render", "--input", str(filled_form), "--out-dir", str(form_render_dir)]
    )
    emit(
        {
            "status": "ok",
            "output": str(root),
            "sample": str(pdf),
            "withImage": str(image_pdf),
            "embeddedImages": embedded_images,
            "renderedPages": [str(path) for path in sorted(render_dir.glob("page-*.png"))],
            "filledForm": str(filled_form),
            "filledFormPages": [str(path) for path in sorted(form_render_dir.glob("page-*.png"))],
        }
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    inspect_parser = subparsers.add_parser("inspect", help="Inspect PDF structure and content")
    inspect_parser.add_argument("--input", required=True)
    inspect_parser.add_argument("--out", required=True)
    inspect_parser.add_argument("--text-out")
    inspect_parser.add_argument("--tables-out")
    inspect_parser.set_defaults(handler=command_inspect)

    audit_parser = subparsers.add_parser("audit", help="Run structural PDF checks")
    audit_parser.add_argument("--input", required=True)
    audit_parser.add_argument("--out", required=True)
    audit_parser.set_defaults(handler=command_audit)

    render_parser = subparsers.add_parser("render", help="Render all pages to PNG")
    render_parser.add_argument("--input", required=True)
    render_parser.add_argument("--out-dir", required=True)
    render_parser.add_argument("--dpi", type=int, default=144)
    render_parser.add_argument("--montage")
    render_parser.set_defaults(handler=command_render)

    make_parser = subparsers.add_parser("make", help="Create a PDF from title/body/spec using bundled fonts")
    make_parser.add_argument("--title")
    make_parser.add_argument("--body")
    make_parser.add_argument("--body-file")
    make_parser.add_argument("--markdown")
    make_parser.add_argument("--author")
    make_parser.add_argument("--spec")
    make_parser.add_argument("--out", required=True)
    make_parser.add_argument("--force", action="store_true")
    make_parser.set_defaults(handler=command_make)

    scaffold_parser = subparsers.add_parser("scaffold", help="Copy the starter PDF builder")
    scaffold_parser.add_argument("--out", required=True)
    scaffold_parser.add_argument("--force", action="store_true")
    scaffold_parser.set_defaults(handler=command_scaffold)

    build_pdf_parser = subparsers.add_parser("build", help="Run a PDF builder and audit its output")
    build_pdf_parser.add_argument("--builder", required=True)
    build_pdf_parser.add_argument("--out", required=True)
    build_pdf_parser.set_defaults(handler=command_build)

    merge_parser = subparsers.add_parser("merge", help="Merge PDFs in the provided order")
    merge_parser.add_argument("--inputs", nargs="+", required=True)
    merge_parser.add_argument("--out", required=True)
    merge_parser.set_defaults(handler=command_merge)

    split_parser = subparsers.add_parser("split", help="Write selected pages as individual PDFs")
    split_parser.add_argument("--input", required=True)
    split_parser.add_argument("--out-dir", required=True)
    split_parser.add_argument("--pages", default="all")
    split_parser.set_defaults(handler=command_split)

    rotate_parser = subparsers.add_parser("rotate", help="Rotate selected pages")
    rotate_parser.add_argument("--input", required=True)
    rotate_parser.add_argument("--out", required=True)
    rotate_parser.add_argument("--degrees", type=int, required=True)
    rotate_parser.add_argument("--pages", default="all")
    rotate_parser.set_defaults(handler=command_rotate)

    forms_inspect_parser = subparsers.add_parser("forms-inspect", help="List AcroForm fields")
    forms_inspect_parser.add_argument("--input", required=True)
    forms_inspect_parser.add_argument("--out", required=True)
    forms_inspect_parser.set_defaults(handler=command_forms_inspect)

    forms_fill_parser = subparsers.add_parser("forms-fill", help="Fill AcroForm fields from JSON")
    forms_fill_parser.add_argument("--input", required=True)
    forms_fill_parser.add_argument("--out", required=True)
    forms_fill_parser.add_argument("--data")
    forms_fill_parser.add_argument("--values")
    forms_fill_parser.set_defaults(handler=command_forms_fill)

    self_test_parser = subparsers.add_parser("self-test", help="Exercise the bundled PDF workflow")
    self_test_parser.add_argument("--out", required=True)
    self_test_parser.set_defaults(handler=command_self_test)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        return int(args.handler(args))
    except (PdfToolError, json.JSONDecodeError, ValueError, OSError) as exc:
        emit({"status": "error", "error": str(exc)})
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
