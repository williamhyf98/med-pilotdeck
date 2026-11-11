#!/usr/bin/env python3
"""Deterministic PDF operations for the PilotDeck PDF skill."""

from __future__ import annotations

import argparse
import hashlib
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
BUNDLED_SERIF_FONT_NAME = "PilotDeckCJKSerif"
_BUNDLED_SERIF_REGISTERED = False


class PdfToolError(RuntimeError):
    pass


def _command_available(value: str) -> bool:
    """Poppler helpers are optional: without them we lose rendering, not creation."""
    if not value:
        return False
    candidate = Path(value).expanduser()
    if candidate.is_file() and os.access(candidate, os.X_OK):
        return True
    return shutil.which(value) is not None


def pdfinfo_available() -> bool:
    return _command_available(PDFINFO)


def rendering_available() -> bool:
    return _command_available(PDFTOPPM)


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


def bundled_serif_font_name() -> str:
    """Register and return the bundled CJK serif face (used by serif themes)."""
    global _BUNDLED_SERIF_REGISTERED
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont

    if _BUNDLED_SERIF_REGISTERED:
        return BUNDLED_SERIF_FONT_NAME
    path = SKILL_ROOT / "assets" / "fonts" / "NotoSerifSC-Regular.ttf"
    if not path.is_file():
        raise PdfToolError(
            "交付包不完整：缺少随包衬线中文字体 assets/fonts/NotoSerifSC-Regular.ttf"
        )
    try:
        pdfmetrics.registerFont(TTFont(BUNDLED_SERIF_FONT_NAME, str(path)))
    except Exception as exc:  # noqa: BLE001 - surface the loader error verbatim
        raise PdfToolError(f"交付包不完整：衬线字体无法加载：{exc}") from exc
    _BUNDLED_SERIF_REGISTERED = True
    return BUNDLED_SERIF_FONT_NAME


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
    background: str = "FFFFFF",
) -> list[Any]:
    from io import BytesIO

    from reportlab.lib.units import mm
    from reportlab.platypus import Image as RLImage, Spacer

    # Transparent PNGs are flattened onto the page colour, otherwise a
    # transparent logo would show a white rectangle on a tinted theme paper.
    backdrop = tuple(int(background[index:index + 2], 16) for index in (0, 2, 4))
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
                canvas = Image.new("RGBA", rgba.size, (*backdrop, 255))
                flattened = Image.alpha_composite(canvas, rgba).convert("RGB")
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

#: Paragraph style name -> depth in the table of contents.
#: ``##`` is listed at depth 0, ``###`` at depth 1, ``####`` and deeper stay
#: out of the TOC (they use the same visual style as ``###``).
TOC_LEVELS = {"MakeH2": 0, "MakeH3": 1}

#: ``--design-theme`` values that keep the pre-D1 neutral (black-on-white)
#: report. Everything else, including "no theme given", resolves a theme.
NEUTRAL_THEME_NAMES = {"none", "neutral", "off", "无", "中性"}


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


def _shared_tokens_module() -> Any:
    """Load skills/_shared/tokens.py without adding it to sys.path."""
    import importlib.util

    roots = []
    configured = os.environ.get("PILOTDECK_BUNDLED_SKILLS_DIR", "").strip()
    if configured:
        roots.append(Path(configured).expanduser())
    roots.append(SKILL_ROOT.parent)
    for root in roots:
        file = root / "_shared" / "tokens.py"
        if not file.is_file():
            continue
        spec = importlib.util.spec_from_file_location("pilotdeck_shared_tokens", file)
        if spec is None or spec.loader is None:
            continue
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    return None


def resolve_pdf_theme(name: str) -> dict[str, Any]:
    """Resolve a design theme into the palette ReportLab needs."""
    module = _shared_tokens_module()
    if module is None:
        raise PdfToolError(
            "共享主题数据不可用：缺少随包 skills/_shared/design-tokens.json"
        )
    try:
        selected = module.resolve_theme(
            name,
            bundled_skills_root=os.environ.get("PILOTDECK_BUNDLED_SKILLS_DIR") or str(SKILL_ROOT.parent),
            skill_root=str(SKILL_ROOT),
        )
    except ValueError as exc:
        raise PdfToolError(f"未知主题：{exc}") from exc
    theme = selected["theme"]
    try:
        loaded = module.load_tokens(
            bundled_skills_root=os.environ.get("PILOTDECK_BUNDLED_SKILLS_DIR") or str(SKILL_ROOT.parent),
            skill_root=str(SKILL_ROOT),
        )
        semantic = loaded["tokens"].get("semantic") or {}
    except Exception:  # noqa: BLE001 - theme still works without semantic tokens
        semantic = {}
    return {
        "id": selected["id"],
        "label": theme["label"],
        "colors": theme["colors"],
        "semantic": semantic,
        "typography": theme.get("typography") or {},
        "warning": selected.get("warning"),
        "source": selected.get("source"),
    }


def list_pdf_theme_names() -> str:
    module = _shared_tokens_module()
    if module is None:
        return ""
    listed = module.list_themes(
        bundled_skills_root=os.environ.get("PILOTDECK_BUNDLED_SKILLS_DIR") or str(SKILL_ROOT.parent),
        skill_root=str(SKILL_ROOT),
    )
    return "、".join(f"{item['label']}（{item['id']}）" for item in listed["themes"])


# ---------------------------------------------------------------------------
# 语义角色色：与 docx / pptx / xlsx 共用同一套角色名。
# ---------------------------------------------------------------------------

PDF_ROLE_KEYS = {
    "success": "success",
    "warning": "warning",
    "danger": "danger",
    "info": "info",
    "primary": "primary",
    "accent": "accent",
    "support": "support",
    "ink": "ink",
    "muted": "muted",
    "rule": "rule",
    "soft": "soft",
    "surface": "surface",
    "paper": "paper",
    "white": "paper",
}
PDF_SURFACE_ROLES = {"soft", "surface", "paper"}
PDF_ROLE_NAMES = "、".join(k for k in PDF_ROLE_KEYS if k != "white")
SEMANTIC_ROLES = {"success", "warning", "danger", "info"}

_SEMANTIC_CACHE: dict[str, Any] | None = None


def shared_semantic_tokens() -> dict[str, Any]:
    """The four semantic colours, usable even with `--design-theme none`."""
    global _SEMANTIC_CACHE
    if _SEMANTIC_CACHE is not None:
        return _SEMANTIC_CACHE
    module = _shared_tokens_module()
    semantic: dict[str, Any] = {}
    if module is not None:
        try:
            loaded = module.load_tokens(
                bundled_skills_root=os.environ.get("PILOTDECK_BUNDLED_SKILLS_DIR") or str(SKILL_ROOT.parent),
                skill_root=str(SKILL_ROOT),
            )
            semantic = loaded["tokens"].get("semantic") or {}
        except Exception:  # noqa: BLE001 - fall through to the neutral defaults
            semantic = {}
    _SEMANTIC_CACHE = semantic
    return semantic


def _mix_hex(hex_value: str, toward: str = "FFFFFF", weight: float = 0.12) -> str:
    """Mix `hex_value` with `toward`; weight is how much of the original survives."""
    try:
        front = [int(hex_value[index:index + 2], 16) for index in (0, 2, 4)]
        back = [int(toward[index:index + 2], 16) for index in (0, 2, 4)]
    except (TypeError, ValueError):
        return hex_value
    return "".join(
        f"{round(value * weight + target * (1 - weight)):02X}"
        for value, target in zip(front, back)
    )


def resolve_pdf_role(palette: dict[str, Any] | None, role: Any, location: str) -> dict[str, str]:
    """角色名 → 6 位 hex 色值。

    fg 字色 / bg 浅底 / bar 左侧色条 / fill 实底 / onFill 实底上的字。

    设计档 A：除角色名外也接受自定义强调色（`#RRGGBB`），但必须与纸面拉开
    4.5:1 对比度（这个色同时会当文字色用），否则直接报错。
    语义四色（success/warning/danger/info）仍然只能写角色名。
    """
    text = str(role or "").strip()
    module = _shared_tokens_module()
    custom = module.normalize_hex(text) if module is not None else None
    if custom:
        ground = palette_colors(palette)["paper"]
        if module is not None:
            try:
                custom = module.ensure_contrast(
                    custom,
                    ground,
                    module.MIN_TEXT_CONTRAST,
                    field=location,
                )
            except ValueError as exc:
                raise PdfToolError(str(exc)) from exc
            background = module.mix_hex(custom, toward=ground, weight=0.12)
            on_fill = module.on_color(custom, dark=palette_colors(palette)["ink"])
        else:  # 没有共享模块时按老规矩只认角色名
            raise PdfToolError(f"{location} must be one of {PDF_ROLE_NAMES}")
        return {
            "fg": custom,
            "bg": background,
            "bar": custom,
            "fill": custom,
            "onFill": on_fill,
        }
    key = PDF_ROLE_KEYS.get(text.lower())
    if not key:
        raise PdfToolError(
            f"{location} must be one of {PDF_ROLE_NAMES}, or a 6-digit hex accent "
            "such as #1F5FA9"
        )
    colors_map = palette_colors(palette)
    ink = colors_map["ink"]
    if key in PDF_SURFACE_ROLES:
        fill = colors_map["paper"] if key == "paper" else colors_map[key]
        return {"fg": ink, "bg": fill, "bar": fill, "fill": fill, "onFill": ink}
    semantic = (palette or {}).get("semantic") or shared_semantic_tokens()
    entry = semantic.get(key) if key in SEMANTIC_ROLES else None
    if isinstance(entry, dict) and isinstance(entry.get("fg"), str):
        fg = entry["fg"].lstrip("#").upper()
        bg = str(entry.get("bg") or _mix_hex(fg)).lstrip("#").upper()
        on_fill = str(entry.get("onFg") or "FFFFFF").lstrip("#").upper()
        return {"fg": fg, "bg": bg, "bar": fg, "fill": fg, "onFill": on_fill}
    themed_colors = (palette or {}).get("colors") or {}
    color = themed_colors.get(key)
    if not isinstance(color, str) or not re.fullmatch(r"[0-9A-Fa-f]{6}", color):
        raise PdfToolError(
            f"{location} '{role}' is unavailable for the active theme; "
            "semantic roles (success/warning/danger/info) work without one, "
            "theme roles need --design-theme"
        )
    color = color.upper()
    on_fill = str(themed_colors.get("onPrimary") or "FFFFFF").upper()
    return {"fg": color, "bg": _mix_hex(color), "bar": color, "fill": color, "onFill": on_fill}


TABLE_SEPARATOR = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$")
TABLE_NUMERIC = re.compile(r"^[-+−]?\d[\d,，.。\s%‰]*$")
TABLE_VARIANTS = {"grid", "three-line"}


def split_table_cells(line: str) -> list[str]:
    text = line.strip()
    if text.startswith("|"):
        text = text[1:]
    if text.endswith("|"):
        text = text[:-1]
    return [cell.strip() for cell in text.split("|")]


def parse_table_block(block: str) -> list[list[str]] | None:
    """Return table rows when the block is a pipe table, else None."""
    lines = [line for line in block.split("\n") if line.strip()]
    if len(lines) < 2 or "|" not in lines[0] or "|" not in lines[1]:
        return None
    if not TABLE_SEPARATOR.match(lines[1]):
        return None
    header = split_table_cells(lines[0])
    delimiter = split_table_cells(lines[1])
    if len(header) != len(delimiter) or len(header) < 2:
        return None
    rows = [header]
    for line in lines[2:]:
        if "|" not in line:
            return None
        cells = split_table_cells(line)
        if len(cells) != len(header):
            return None
        rows.append(cells)
    return rows if len(rows) >= 2 else None


def display_width(text: str) -> int:
    return sum(2 if ord(char) > 0x2E80 else 1 for char in text)


def pdfinfo_data(path: Path) -> dict[str, Any]:
    if not pdfinfo_available():
        return {
            "available": False,
            "reason": "pdfinfo (Poppler) is not installed; page-size labels are unavailable",
        }
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
    return {"available": True, "raw": parsed, "command": PDFINFO}


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


def font_summary(reader: PdfReader) -> list[dict[str, Any]]:
    """List the fonts a document references, and whether each one is embedded."""
    seen: dict[str, dict[str, Any]] = {}
    for page in reader.pages:
        try:
            resources = (page.get("/Resources") or {}).get_object()
            fonts = resources.get("/Font")
            if fonts is None:
                continue
            entries = list(fonts.get_object().items())
        except (AttributeError, KeyError):
            continue
        for key, reference in entries:
            try:
                font = reference.get_object()
            except AttributeError:
                continue
            base = str(font.get("/BaseFont") or key)
            embedded = False
            descriptor = font.get("/FontDescriptor")
            if descriptor is None:
                try:
                    descendants = font.get("/DescendantFonts") or []
                    if descendants:
                        descriptor = descendants[0].get_object().get("/FontDescriptor")
                except (AttributeError, IndexError, KeyError):
                    descriptor = None
            if descriptor is not None:
                try:
                    described = descriptor.get_object()
                    embedded = any(
                        key in described for key in ("/FontFile", "/FontFile2", "/FontFile3")
                    )
                except AttributeError:
                    embedded = False
            seen[base] = {
                "name": base,
                "subtype": str(font.get("/Subtype")),
                "embedded": embedded,
            }
    return [seen[name] for name in sorted(seen)]


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
        "fonts": font_summary(reader),
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
    capabilities = {"pdfinfo": pdfinfo_available(), "rendering": rendering_available()}

    try:
        info = pdfinfo_data(input_path)
        if info.get("available") is False:
            warnings.append(
                "pdfinfo (Poppler) is not installed; page-size labels and producer "
                "metadata are omitted"
            )
    except Exception as exc:
        # pypdf and pdfplumber remain the structural authority; pdfinfo is advisory.
        info = {"available": False, "error": str(exc)}
        warnings.append(f"pdfinfo failed: {exc}")

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
        "capabilities": capabilities,
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
    if not rendering_available():
        raise PdfToolError(
            "render-unavailable: pdftoppm (Poppler) is not installed; "
            "PDF creation and structural audit still work"
        )
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


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def default_qa_dir(input_path: Path) -> Path:
    """Keep delivery records in the per-turn work directory when one is set."""
    work_dir = os.environ.get("PILOTDECK_WORK_DIR", "").strip()
    if work_dir:
        return Path(work_dir).expanduser().resolve() / "pdf" / "qa"
    return input_path.parent / ".pdf-qa" / input_path.stem


def normalize_acceptance(args: argparse.Namespace) -> dict[str, Any] | None:
    """Accept a protocol acceptance record and/or direct CLI requirements."""
    requirements: dict[str, Any] = {"text": [], "pages": {}, "source": None}
    if args.acceptance:
        path = resolved_file(args.acceptance, "acceptance")
        payload = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            raise PdfToolError("acceptance must be a JSON object")
        if payload.get("skill") not in (None, "pdf"):
            raise PdfToolError(
                f"acceptance belongs to skill {payload.get('skill')!r}, not 'pdf'"
            )
        raw = payload.get("requirements") or {}
        if not isinstance(raw, dict):
            raise PdfToolError("acceptance.requirements must be an object")
        requirements["text"] = [
            item for item in raw.get("text") or [] if isinstance(item, str) and item.strip()
        ]
        pages = raw.get("pages") or {}
        if not isinstance(pages, dict):
            raise PdfToolError("acceptance.requirements.pages must be an object")
        requirements["pages"] = dict(pages)
        requirements["source"] = str(path)
    if args.require_text:
        requirements["text"].extend(
            item for item in args.require_text if isinstance(item, str) and item.strip()
        )
    if args.min_pages is not None:
        requirements["pages"]["min"] = args.min_pages
    if args.max_pages is not None:
        requirements["pages"]["max"] = args.max_pages
    if not requirements["text"] and not requirements["pages"]:
        return None
    if requirements["source"] is None:
        requirements["source"] = "cli"
    return requirements


def extract_page_texts(path: Path) -> list[str]:
    with pdfplumber.open(str(path)) as document:
        return [(page.extract_text() or "") for page in document.pages]


def compact_text(value: str) -> str:
    return "".join(value.split()).casefold()


def evaluate_pdf_requirements(
    text_pages: list[str],
    page_count: int,
    requirements: dict[str, Any] | None,
) -> dict[str, Any]:
    if requirements is None:
        return {"status": "not_requested", "source": None, "checks": [], "failures": []}

    checks: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []
    haystack = compact_text("\n".join(text_pages))
    for value in requirements["text"]:
        needle = compact_text(value)
        passed = bool(needle) and needle in haystack
        checks.append({"type": "required_text", "value": value, "passed": passed})
        if not passed:
            failures.append({"type": "required_text", "value": value})

    pages = requirements["pages"]
    for key, comparison in (("min", lambda actual, minimum: actual >= minimum),
                            ("max", lambda actual, maximum: actual <= maximum)):
        expected = pages.get(key)
        if not isinstance(expected, int) or isinstance(expected, bool):
            continue
        passed = comparison(page_count, expected)
        checks.append({
            "type": f"page_count_{key}",
            "expected": expected,
            "actual": page_count,
            "passed": passed,
        })
        if not passed:
            failures.append({
                "type": f"page_count_{key}",
                "expected": expected,
                "actual": page_count,
            })

    return {
        "status": "failed" if failures else "passed",
        "source": requirements["source"],
        "checks": checks,
        "failures": failures,
    }


def load_visual_review(
    path: Path,
    *,
    artifact_sha256: str,
    page_count: int,
    rendered_images: list[Path],
) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise PdfToolError("visual review must be a JSON object")
    errors: list[str] = []
    schema = payload.get("schema")
    if schema not in (None, "pilotdeck-qa-review/v1"):
        errors.append(f"unsupported review schema: {schema}")
    if payload.get("artifactSha256") != artifact_sha256:
        errors.append(
            "review-artifact-mismatch: the PDF changed after the review was recorded"
        )
    if payload.get("pageCount") != page_count:
        errors.append(
            "review-page-count-mismatch: "
            f"expected {page_count}, got {payload.get('pageCount')}"
        )

    seen: list[int] = []
    statuses: list[str] = []
    for item in payload.get("pages") or []:
        if not isinstance(item, dict):
            errors.append("every review page entry must be an object")
            continue
        number = item.get("page")
        if not isinstance(number, int) or isinstance(number, bool) or not 1 <= number <= page_count:
            errors.append(f"page number out of range: {number}")
            continue
        if number in seen:
            errors.append(f"duplicate page in review: {number}")
            continue
        seen.append(number)
        status = item.get("status")
        if status not in {"passed", "failed", "not_performed"}:
            errors.append(f"page {number} has an invalid status: {status}")
            continue
        statuses.append(status)
        recorded_image = item.get("imageSha256")
        if isinstance(recorded_image, str) and recorded_image and number <= len(rendered_images):
            actual = sha256_file(rendered_images[number - 1])
            if actual.casefold() != recorded_image.casefold():
                errors.append(
                    f"page {number} review is bound to a different rendered image"
                )

    missing = [number for number in range(1, page_count + 1) if number not in seen]
    if missing:
        errors.append(f"review-incomplete: missing pages {missing}")

    if errors or "failed" in statuses:
        status = "failed"
    elif "not_performed" in statuses:
        status = "not_performed"
    else:
        status = "passed"
    return {
        "status": status,
        "report": str(path),
        "pagesReviewed": sorted(seen),
        "pendingPages": sorted(missing),
        "errors": errors,
    }


def command_deliver(args: argparse.Namespace) -> int:
    input_path = resolved_file(args.input)
    artifact_sha = sha256_file(input_path)
    audit = audit_document(input_path)
    page_count = int(audit["pageCount"])
    requirements = normalize_acceptance(args)
    text_pages = extract_page_texts(input_path) if requirements and requirements["text"] else []
    coverage = evaluate_pdf_requirements(text_pages, page_count, requirements)

    render_dir = Path(
        args.render_dir if args.render_dir else default_qa_dir(input_path) / "render"
    ).expanduser().resolve()
    rendered: list[Path] = []
    if rendering_available():
        try:
            rendered = render_document(
                input_path,
                output_dir(str(render_dir)),
                args.dpi,
                output_file(args.montage) if args.montage else None,
            )
            render = {
                "status": "passed",
                "dpi": args.dpi,
                "pages": [str(path) for path in rendered],
                "reason": None,
            }
        except PdfToolError as exc:
            render = {"status": "failed", "dpi": args.dpi, "pages": [], "reason": str(exc)}
    else:
        render = {
            "status": "skipped",
            "dpi": args.dpi,
            "pages": [],
            "reason": "未完成视觉验收：pdftoppm (Poppler) 不可用，未生成页面预览",
        }

    gate_errors: list[dict[str, Any]] = []
    if args.require_render and render["status"] == "skipped":
        gate_errors.append({
            "code": "render_required",
            "message": "交付要求渲染，但 pdftoppm (Poppler) 不可用",
        })

    visual: dict[str, Any] = {
        "status": "not-reviewed",
        "artifactSha256": artifact_sha,
        "report": None,
        "pagesReviewed": [],
        "pendingPages": [],
        "errors": [],
    }
    if args.visual_review:
        review_path = resolved_file(args.visual_review, "visual review")
        visual = load_visual_review(
            review_path,
            artifact_sha256=artifact_sha,
            page_count=page_count,
            rendered_images=rendered,
        )
        visual["artifactSha256"] = artifact_sha

    warnings = list(audit["warnings"])
    if render["status"] == "skipped" and render["reason"]:
        warnings.append(render["reason"])

    failed = (
        bool(audit["hardFailures"])
        or coverage["status"] == "failed"
        or visual["status"] == "failed"
        or render["status"] == "failed"
        or bool(gate_errors)
    )
    if failed:
        status = "failed"
    elif (
        visual["status"] == "passed"
        and coverage["status"] == "passed"
        and not warnings
    ):
        status = "passed"
    else:
        status = "passed_with_warnings"

    report = {
        "schemaVersion": 1,
        "status": status,
        "artifact": {
            "file": str(input_path),
            "sha256": artifact_sha,
            "bytes": input_path.stat().st_size,
            "pageCount": page_count,
        },
        "audit": {
            "status": audit["status"],
            "hardFailures": audit["hardFailures"],
            "warnings": audit["warnings"],
            "capabilities": audit["capabilities"],
        },
        "coverage": coverage,
        "render": render,
        "visualReview": visual,
        "gates": {"requireRender": bool(args.require_render), "errors": gate_errors},
        "warnings": warnings,
    }
    report_path = (
        output_file(args.report)
        if args.report
        else default_qa_dir(input_path) / "delivery.json"
    )
    write_json(report_path, report)
    emit(
        {
            "status": status,
            "report": str(report_path),
            "artifact": artifact_sha,
            "pageCount": page_count,
            "coverage": coverage["status"],
            "render": render["status"],
            "visualReview": visual["status"],
        }
    )
    return 3 if status == "failed" else 0


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
    def role_name(value: Any, location: str) -> str | None:
        if value is None:
            return None
        if not isinstance(value, str) or not value.strip():
            raise PdfToolError(f"{location} must be a colour role name")
        return value.strip().lower()

    def callout_spec(value: Any, location: str) -> dict[str, Any] | None:
        if value is None:
            return None
        if not isinstance(value, dict):
            raise PdfToolError(f"{location} must be an object")
        title = value.get("title") or ""
        body_text = value.get("body") or ""
        if not isinstance(title, str) or not isinstance(body_text, str):
            raise PdfToolError(f"{location}.title/body must be strings")
        if not title.strip() and not body_text.strip():
            raise PdfToolError(f"{location} requires a title or a body")
        role = role_name(value.get("role", value.get("tone", "info")), f"{location}.role")
        return {"title": title.strip(), "body": body_text, "role": role}

    def table_style_spec(value: Any, location: str) -> dict[str, Any]:
        if value is None:
            return {}
        if not isinstance(value, dict):
            raise PdfToolError(f"{location} must be an object")
        resolved: dict[str, Any] = {}
        variant = value.get("variant")
        if variant is not None:
            variant_text = str(variant).strip()
            if variant_text not in TABLE_VARIANTS:
                raise PdfToolError(f"{location}.variant must be one of {', '.join(sorted(TABLE_VARIANTS))}")
            resolved["variant"] = variant_text
        zebra = value.get("zebra")
        if zebra is not None:
            if not isinstance(zebra, bool):
                raise PdfToolError(f"{location}.zebra must be a boolean")
            resolved["zebra"] = zebra
        header_role = role_name(
            value.get("headerRole", value.get("header_role")),
            f"{location}.headerRole",
        )
        if header_role:
            resolved["headerRole"] = header_role
        return resolved

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
                "accent": role_name(section.get("accent"), f"spec.sections[{index}].accent"),
                "callout": callout_spec(section.get("callout"), f"spec.sections[{index}].callout"),
                "tableStyle": table_style_spec(
                    section.get("tableStyle") or section.get("table_style"),
                    f"spec.sections[{index}].tableStyle",
                ),
            }
        )
    if markdown and not normalized and markdown["body"] and not body.strip():
        body = markdown["body"]
    raw_theme = (
        getattr(args, "design_theme", None)
        or spec.get("designTheme")
        or spec.get("design_theme")
    )
    theme_name = str(raw_theme).strip() if raw_theme is not None else ""
    if theme_name.lower() in NEUTRAL_THEME_NAMES:
        # Escape hatch for the pre-D1 neutral report.
        palette = None
    elif theme_name:
        palette = resolve_pdf_theme(theme_name)
    elif _shared_tokens_module() is not None:
        # D1: no --design-theme means the shared default theme, not "none".
        palette = resolve_pdf_theme("")
    else:
        # No shared tokens (user copied the skill without _shared/): stay neutral
        # rather than failing to build.
        palette = None
    toc = bool(getattr(args, "toc", False) or spec.get("toc") is True)
    return {
        "title": title.strip(),
        "body": body,
        "author": author.strip(),
        "sections": normalized,
        "images": top_images,
        "palette": palette,
        "toc": toc,
        "accent": role_name(spec.get("accent"), "spec.accent"),
        "callout": callout_spec(spec.get("callout"), "spec.callout"),
        "tableStyle": table_style_spec(
            spec.get("tableStyle") or spec.get("table_style"),
            "spec.tableStyle",
        ),
    }


def palette_colors(palette: dict[str, Any] | None) -> dict[str, str]:
    """Resolve the colors a PDF report needs, defaulting to the neutral baseline."""
    resolved = {
        "paper": "FFFFFF",
        "surface": "FFFFFF",
        "ink": "172033",
        "muted": "5F6B7A",
        "primary": "12404F",
        "accent": "B4552D",
        "support": "2F7183",
        "rule": "D8E0EA",
        "soft": "F3F4F6",
        "onPrimary": "FFFFFF",
    }
    if palette:
        for key in resolved:
            value = (palette.get("colors") or {}).get(key)
            if isinstance(value, str) and re.fullmatch(r"[0-9A-Fa-f]{6}", value):
                resolved[key] = value
    return resolved


def theme_fonts(palette: dict[str, Any] | None) -> tuple[str, str, float, float]:
    """Return (heading font, body font, body scale, line-height scale)."""
    if not palette:
        return bundled_font_name(), bundled_font_name(), 1.0, 1.0
    typography = palette.get("typography") or {}
    heading_role = str(typography.get("headingRole") or "sans")
    body_role = str(typography.get("bodyRole") or "sans")
    heading_font = (
        bundled_serif_font_name() if heading_role == "serif" else bundled_font_name()
    )
    body_font = bundled_serif_font_name() if body_role == "serif" else bundled_font_name()
    try:
        body_scale = float(typography.get("bodyScale") or 1.0)
    except (TypeError, ValueError):
        body_scale = 1.0
    try:
        line_scale = float(typography.get("lineHeightScale") or 1.0)
    except (TypeError, ValueError):
        line_scale = 1.0
    # Guard against a bad theme shrinking type into unreadable output.
    body_scale = min(max(body_scale, 0.85), 1.25)
    line_scale = min(max(line_scale, 0.9), 1.35)
    return heading_font, body_font, body_scale, line_scale


def build_table_flowable(
    rows: list[list[str]],
    *,
    cell_style: Any,
    header_style: Any,
    colors_map: dict[str, str],
    available_width: float,
    themed: bool,
    variant: str = "grid",
    zebra: bool | None = None,
    header_role: str | None = None,
    palette: dict[str, Any] | None = None,
) -> Any:
    from reportlab.lib import colors
    from reportlab.lib.units import mm
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.platypus import LongTable, Paragraph, TableStyle

    columns = len(rows[0])
    weights: list[int] = []
    for index in range(columns):
        weights.append(
            max(display_width(row[index]) if index < len(row) else 0 for row in rows) or 4
        )
    total = float(sum(weights))
    col_widths = [max(available_width * weight / total, 14 * mm) for weight in weights]
    scale = available_width / sum(col_widths)
    col_widths = [width * scale for width in col_widths]

    numeric_columns = {
        index
        for index in range(columns)
        if (values := [row[index] for row in rows[1:] if index < len(row) and row[index].strip()])
        and all(TABLE_NUMERIC.match(value) for value in values)
    }

    header_fill = colors_map["primary"] if themed else "F3F4F6"
    header_fg = colors_map["onPrimary"] if themed else colors_map["ink"]
    if header_role:
        role_colors = resolve_pdf_role(palette, header_role, "tableStyle.headerRole")
        header_fill = role_colors["fill"]
        header_fg = role_colors["onFill"]
    if variant == "three-line":
        # 三线表按学术规范：表头不上底色，靠上/中/下三条线分隔；
        # 指定 headerRole 时只借用它的字色，不铺底。
        header_fill = None
        if not header_role:
            header_fg = colors_map["ink"]
    effective_header_style = ParagraphStyle(
        "MakeCellHeaderRole",
        parent=header_style,
        textColor=colors.HexColor("#" + header_fg),
    )
    data = [[Paragraph(format_make_text(cell), effective_header_style) for cell in rows[0]]]
    for row in rows[1:]:
        data.append([Paragraph(format_make_text(cell), cell_style) for cell in row])

    header_rule = header_fill or colors_map["rule"]
    if variant == "three-line":
        ink_line = colors.HexColor("#" + colors_map["ink"])
        commands: list[tuple[Any, ...]] = [
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LINEABOVE", (0, 0), (-1, 0), 1.1, ink_line),
            ("LINEBELOW", (0, 0), (-1, 0), 0.7, ink_line),
            ("LINEBELOW", (0, -1), (-1, -1), 1.1, ink_line),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ("LEFTPADDING", (0, 0), (-1, -1), 5),
            ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ]
    else:
        commands = [
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#" + colors_map["rule"])),
            ("LINEBELOW", (0, 0), (-1, 0), 0.9, colors.HexColor("#" + header_rule)),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ("LEFTPADDING", (0, 0), (-1, -1), 5),
            ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ]
        if header_fill:
            commands.insert(0, ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#" + header_fill)))
    striped = themed if zebra is None else bool(zebra)
    if variant != "three-line" and striped:
        for index in range(2 if themed else 1, len(data), 2):
            commands.append(
                ("BACKGROUND", (0, index), (-1, index), colors.HexColor("#" + colors_map["surface"]))
            )
    for index in sorted(numeric_columns):
        commands.append(("ALIGN", (index, 1), (index, -1), "RIGHT"))
    table = LongTable(data, colWidths=col_widths, repeatRows=1, hAlign="LEFT")
    table.setStyle(TableStyle(commands))
    return table


def build_callout_flowable(
    callout: dict[str, Any],
    *,
    palette: dict[str, Any] | None,
    colors_map: dict[str, str],
    available_width: float,
    body_font: str,
    heading_font: str,
    body_scale: float,
    line_scale: float,
) -> Any:
    """提示框：左侧色条 + 浅色底，颜色来自角色名（与 docx/pptx/xlsx 同一套）。"""
    from reportlab.lib import colors
    from reportlab.lib.units import mm
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.platypus import Paragraph, Table, TableStyle

    role_colors = resolve_pdf_role(palette, callout.get("role") or "info", "callout.role")
    title = callout.get("title") or ""
    body_text = callout.get("body") or ""
    cells: list[list[Any]] = []
    if title:
        cells.append([
            Paragraph(
                xml_escape(title),
                ParagraphStyle(
                    "MakeCalloutTitle",
                    fontName=heading_font,
                    fontSize=10.5 * body_scale,
                    leading=14 * body_scale * line_scale,
                    textColor=colors.HexColor("#" + role_colors["fg"]),
                    spaceAfter=1.2 * mm,
                ),
            )
        ])
    if body_text:
        cells.append([
            Paragraph(
                format_make_text(body_text),
                ParagraphStyle(
                    "MakeCalloutBody",
                    fontName=body_font,
                    fontSize=10 * body_scale,
                    leading=14 * body_scale * line_scale,
                    textColor=colors.HexColor("#" + colors_map["ink"]),
                ),
            )
        ])
    table = Table(cells, colWidths=[available_width], hAlign="LEFT")
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#" + role_colors["bg"])),
                ("LINEBEFORE", (0, 0), (0, -1), 2.4, colors.HexColor("#" + role_colors["bar"])),
                ("LEFTPADDING", (0, 0), (-1, -1), 8),
                ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    return table


def write_made_pdf(output: Path, spec: dict[str, Any]) -> list[dict[str, Any]]:
    """Render the report. Returns the table-of-contents rows that were drawn."""
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_CENTER, TA_LEFT
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.pdfbase.pdfmetrics import stringWidth
    from reportlab.platypus import (
        Flowable,
        HRFlowable,
        PageBreak,
        Paragraph,
        SimpleDocTemplate,
        Spacer,
    )

    palette = spec.get("palette")
    colors_map = palette_colors(palette)
    heading_font, body_font, body_scale, line_scale = theme_fonts(palette)
    output.parent.mkdir(parents=True, exist_ok=True)
    ink = colors.HexColor("#" + colors_map["ink"])
    muted = colors.HexColor("#" + colors_map["muted"])
    rule = colors.HexColor("#" + colors_map["rule"])
    primary = colors.HexColor("#" + colors_map["primary"])
    accent = colors.HexColor("#" + colors_map["accent"])
    paper = colors.HexColor("#" + colors_map["paper"])
    title_text = spec["title"]
    themed = palette is not None
    global_accent = spec.get("accent")
    global_table_style = spec.get("tableStyle") or {}

    def header_footer(canvas, doc) -> None:
        canvas.saveState()
        if themed and colors_map["paper"] != "FFFFFF":
            canvas.setFillColor(paper)
            canvas.rect(0, 0, A4[0], A4[1], stroke=0, fill=1)
        if themed:
            canvas.setStrokeColor(primary)
            canvas.setLineWidth(0.6)
            canvas.line(doc.leftMargin, A4[1] - 14 * mm, A4[0] - doc.rightMargin, A4[1] - 14 * mm)
            canvas.setFillColor(accent)
            canvas.rect(doc.leftMargin, A4[1] - 16 * mm, 3 * mm, 2 * mm, stroke=0, fill=1)
        canvas.setStrokeColor(rule)
        canvas.setLineWidth(0.5)
        canvas.line(doc.leftMargin, 18 * mm, A4[0] - doc.rightMargin, 18 * mm)
        canvas.setFillColor(muted)
        canvas.setFont(body_font, 8)
        canvas.drawString(doc.leftMargin, 11 * mm, title_text[:48])
        canvas.drawRightString(A4[0] - doc.rightMargin, 11 * mm, f"{doc.page}")
        canvas.restoreState()

    class _ReportTemplate(SimpleDocTemplate):
        """Adds TOC entries when --toc is used."""

        def afterFlowable(self, flowable) -> None:  # noqa: D401 - reportlab hook
            if not isinstance(flowable, Paragraph):
                return
            level = TOC_LEVELS.get(flowable.style.name)
            if level is None:
                return
            text = " ".join(flowable.getPlainText().split())
            if not text:
                return
            self.notify("TOCEntry", (level, text, self.page))

    def _fit_text(text: str, font: str, size: float, room: float) -> str:
        """Shorten an entry to one line with an ellipsis."""
        if room <= 0:
            return ""
        if stringWidth(text, font, size) <= room:
            return text
        ellipsis = "…"
        ellipsis_width = stringWidth(ellipsis, font, size)
        trimmed = text
        while trimmed and stringWidth(trimmed, font, size) + ellipsis_width > room:
            trimmed = trimmed[:-1]
        return f"{trimmed}{ellipsis}" if trimmed else ""

    class _TocFlowable(Flowable):
        """Two-pass table of contents drawn straight onto the canvas.

        ReportLab's ``TableOfContents`` renders every row as a Paragraph
        carrying an ``<onDraw>`` leader callback. With the bundled variable
        CJK face those rows survive in the text layer but are dropped by the
        renderer (poppler and Quartz agree), which is why the shipped TOC came
        out as bare dot leaders. Drawing the rows ourselves keeps the leader,
        the indent and the page numbers predictable.
        """

        def __init__(
            self,
            levels: list[dict[str, Any]],
            rows: list[tuple[int, str, int]] | None = None,
        ) -> None:
            Flowable.__init__(self)
            self._levels = levels
            self._entries: list[tuple[int, str, int]] = []
            self._last: list[tuple[int, str, int]] = []
            self._rows = rows
            self._width = 0.0
            self._height = 0.0

        # -- indexing protocol used by BaseDocTemplate.multiBuild ----------
        def isIndexing(self) -> int:
            return 0 if self._rows is not None else 1

        def isSatisfied(self) -> bool:
            return self._entries == self._last

        def beforeBuild(self) -> None:
            # The rows drawn during this pass are the ones collected in the
            # previous pass; a fresh collection starts now.
            self._last = list(self._entries)
            self._entries = []

        def afterBuild(self) -> None:
            """Nothing to do: ``beforeBuild`` already published ``_last``."""

        def clearEntries(self) -> None:
            self._entries = []
            self._last = []

        def notify(self, kind: str, stuff: Any) -> None:
            if kind == "TOCEntry":
                self._entries.append(stuff)

        # -- layout --------------------------------------------------------
        def _rows_for_draw(self) -> list[tuple[int, str, int]]:
            return self._rows if self._rows is not None else self._last

        def rows(self) -> list[tuple[int, str, int]]:
            """The entries that were actually drawn."""
            return list(self._rows_for_draw())

        def _lead(self, level: int) -> float:
            return self._levels[min(int(level), len(self._levels) - 1)]["leading"]

        def wrap(self, avail_width: float, avail_height: float) -> tuple[float, float]:
            self._width = avail_width
            self._height = sum(self._lead(level) for level, _, _ in self._rows_for_draw())
            return avail_width, self._height

        def split(self, avail_width: float, avail_height: float) -> list[Any]:
            rows = self._rows_for_draw()
            used = 0.0
            cut = 0
            for index, (level, _, _) in enumerate(rows):
                lead = self._lead(level)
                if used + lead > avail_height:
                    break
                used += lead
                cut = index + 1
            if cut == 0 or cut >= len(rows):
                return []
            return [
                _TocFlowable(self._levels, rows[:cut]),
                _TocFlowable(self._levels, rows[cut:]),
            ]

        def draw(self) -> None:
            canvas = self.canv
            width = self._width
            top = self._height
            for level, text, page_number in self._rows_for_draw():
                spec_row = self._levels[min(int(level), len(self._levels) - 1)]
                font = spec_row["font"]
                size = spec_row["size"]
                leading = spec_row["leading"]
                top -= leading
                baseline = top + (leading - size) * 0.5 + size * 0.2
                indent = spec_row["indent"]
                page_text = str(page_number)
                page_width = stringWidth(page_text, font, size)
                room = width - indent - page_width - 4 * mm
                label = _fit_text(text, font, size, room)
                canvas.setFont(font, size)
                canvas.setFillColor(spec_row["color"])
                canvas.drawString(indent, baseline, label)
                canvas.drawRightString(width, baseline, page_text)
                gap_start = indent + stringWidth(label, font, size) + 2 * mm
                gap_end = width - page_width - 2 * mm
                if gap_end - gap_start > 6 * mm:
                    unit = " . "
                    unit_width = stringWidth(unit, font, size)
                    count = int((gap_end - gap_start) / unit_width)
                    if count > 0:
                        canvas.setFillColor(spec_row["color"])
                        canvas.drawString(gap_start, baseline, unit * count)

    doc = _ReportTemplate(
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
        fontName=heading_font,
        fontSize=22 * body_scale,
        leading=28 * body_scale * line_scale,
        textColor=primary if themed else ink,
        alignment=TA_LEFT,
        spaceAfter=8 * mm,
    )
    heading_style = ParagraphStyle(
        "MakeH2",
        parent=base["Heading2"],
        fontName=heading_font,
        fontSize=13 * body_scale,
        leading=18 * body_scale * line_scale,
        textColor=primary if themed else ink,
        spaceBefore=4 * mm,
        spaceAfter=2.5 * mm,
        keepWithNext=1,
    )
    subheading_style = ParagraphStyle(
        "MakeH3",
        parent=heading_style,
        fontSize=11 * body_scale,
        leading=15 * body_scale * line_scale,
        spaceBefore=3 * mm,
        spaceAfter=2 * mm,
        keepWithNext=1,
    )
    # ``####`` and deeper keep the H3 look but stay out of the table of
    # contents, which is driven by the style name (see TOC_LEVELS).
    deep_heading_style = ParagraphStyle("MakeH4", parent=subheading_style)
    body_style = ParagraphStyle(
        "MakeBody",
        parent=base["BodyText"],
        fontName=body_font,
        fontSize=11 * body_scale,
        leading=16 * body_scale * line_scale,
        textColor=ink,
        spaceAfter=3 * mm,
    )
    caption_style = ParagraphStyle(
        "MakeCaption",
        parent=body_style,
        fontSize=9 * body_scale,
        leading=12 * body_scale * line_scale,
        textColor=muted,
        alignment=TA_CENTER,
        spaceAfter=1 * mm,
    )
    cell_style = ParagraphStyle(
        "MakeCell",
        parent=body_style,
        fontSize=9.5 * body_scale,
        leading=13 * body_scale * line_scale,
        spaceAfter=0,
    )
    header_cell_style = ParagraphStyle(
        "MakeCellHeader",
        parent=cell_style,
        fontName=heading_font,
        textColor=colors.HexColor(
            "#" + (colors_map["onPrimary"] if themed else colors_map["ink"])
        ),
    )
    available_width = A4[0] - doc.leftMargin - doc.rightMargin

    def resolved_accent(role: str | None) -> tuple[Any, Any]:
        """Return (rule colour, heading text colour) for an accent role."""
        if not role:
            return accent, None
        role_colors = resolve_pdf_role(palette, role, "accent")
        return (
            colors.HexColor("#" + role_colors["fill"]),
            colors.HexColor("#" + role_colors["fg"]),
        )

    def add_body(text: str, table_style: dict[str, Any] | None = None) -> None:
        style = {**global_table_style, **(table_style or {})}
        for block in paragraph_blocks(text):
            rows = parse_table_block(block)
            if rows is None:
                story.append(flowable_paragraph(block, body_style))
                continue
            story.append(Spacer(1, 1.5 * mm))
            story.append(
                build_table_flowable(
                    rows,
                    cell_style=cell_style,
                    header_style=header_cell_style,
                    colors_map=colors_map,
                    available_width=available_width,
                    themed=themed,
                    variant=style.get("variant", "grid"),
                    zebra=style.get("zebra"),
                    header_role=style.get("headerRole"),
                    palette=palette,
                )
            )
            story.append(Spacer(1, 3 * mm))

    def add_callout(callout: dict[str, Any] | None) -> None:
        if not callout:
            return
        story.append(Spacer(1, 2 * mm))
        story.append(
            build_callout_flowable(
                callout,
                palette=palette,
                colors_map=colors_map,
                available_width=available_width,
                body_font=body_font,
                heading_font=heading_font,
                body_scale=body_scale,
                line_scale=line_scale,
            )
        )
        story.append(Spacer(1, 3 * mm))

    story: list[Any] = [flowable_paragraph(title_text, title_style)]

    def append_heading(
        text: str,
        style: Any,
        accent_role: str | None = None,
        use_global: bool = True,
    ) -> None:
        rule_color, text_color = resolved_accent(accent_role or (global_accent if use_global else None))
        if themed:
            story.append(Spacer(1, 1 * mm))
            story.append(
                HRFlowable(
                    width=14 * mm,
                    thickness=1.1,
                    color=rule_color,
                    spaceBefore=0,
                    spaceAfter=1.5 * mm,
                    hAlign="LEFT",
                )
            )
        if text_color is not None:
            style = ParagraphStyle(style.name, parent=style, textColor=text_color)
        story.append(flowable_paragraph(text, style))

    toc_flow: Any = None
    if spec.get("toc"):
        append_heading("目录", ParagraphStyle("MakeTocTitle", parent=heading_style), use_global=False)
        story.append(Spacer(1, 1.5 * mm))
        toc_flow = _TocFlowable(
            [
                {
                    "font": heading_font,
                    "size": 11 * body_scale,
                    "leading": 16 * body_scale,
                    "color": ink,
                    "indent": 0.0,
                },
                {
                    "font": body_font,
                    "size": 9.5 * body_scale,
                    "leading": 14 * body_scale,
                    "color": muted,
                    "indent": 6 * mm,
                },
            ]
        )
        story.append(toc_flow)
        story.append(PageBreak())
    add_body(spec["body"])
    add_callout(spec.get("callout"))
    story.extend(
        prepare_image_flowables(
            spec.get("images") or [], caption_style=caption_style,
            background=colors_map["paper"],
        )
    )
    for section in spec["sections"]:
        heading = section["heading"]
        level = int(section.get("level", 2) or 2)
        if level >= 4:
            style = deep_heading_style
        elif level == 3:
            style = subheading_style
        else:
            style = heading_style
        if heading:
            append_heading(heading, style, section.get("accent"))
        add_body(section["body"], section.get("tableStyle"))
        add_callout(section.get("callout"))
        story.extend(
            prepare_image_flowables(
                section.get("images") or [], caption_style=caption_style,
                background=colors_map["paper"],
            )
        )
        if heading and not paragraph_blocks(section["body"]) and not (section.get("images") or []):
            story.append(Spacer(1, 1 * mm))
    if not story:
        raise PdfToolError("make produced no content")
    if spec.get("toc"):
        doc.multiBuild(story, onFirstPage=header_footer, onLaterPages=header_footer)
    else:
        doc.build(story, onFirstPage=header_footer, onLaterPages=header_footer)
    if toc_flow is None:
        return []
    return [
        {"level": level, "text": text, "page": page}
        for level, text, page in toc_flow.rows()
    ]

def command_make(args: argparse.Namespace) -> int:
    spec = load_make_spec(args)
    out = Path(args.out).expanduser().resolve()
    if out.exists() and not args.force:
        raise PdfToolError(f"output already exists; pass --force to replace: {out}")
    out.parent.mkdir(parents=True, exist_ok=True)
    toc_entries = write_made_pdf(out, spec)
    if not out.is_file():
        raise PdfToolError(f"make did not create the requested output: {out}")
    audit = audit_document(out)
    if audit["hardFailures"]:
        raise PdfToolError("built PDF failed structural audit: " + "; ".join(audit["hardFailures"]))
    preview_dir = out.parent / ".pdf-qa" / out.stem
    audit_path = preview_dir / "audit.json"
    write_json(audit_path, audit)
    warnings = list(audit["warnings"])
    images: list[Path] = []
    if rendering_available():
        images = render_document(out, preview_dir, 144, None)
    else:
        warnings.append(
            "未完成视觉验收：pdftoppm (Poppler) 不可用，未生成页面预览；"
            "结构检查仍已完成"
        )
    payload: dict[str, Any] = {
        "status": "ok",
        "output": str(out),
        "pages": audit["pageCount"],
        "preview": [str(path) for path in images],
        "visualAcceptance": "performed" if images else "not_performed",
        "audit": str(audit_path),
        "warnings": warnings,
    }
    if toc_entries:
        payload["tocEntries"] = toc_entries
    palette = spec.get("palette")
    if palette:
        payload["theme"] = {"id": palette["id"], "label": palette["label"]}
        if palette.get("warning"):
            payload["themeWarning"] = palette["warning"]
    emit(payload)
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

    # 角色色：语义色不依赖主题，主题角色跟随色板；提示框/三线表要能真的落盘。
    neutral_danger = resolve_pdf_role(None, "danger", "self-test.role")
    if (
        neutral_danger["fg"] != "B42318"
        or neutral_danger["bg"] != "FDECEC"
        or neutral_danger["bar"] != "B42318"
    ):
        raise PdfToolError(f"self-test semantic role drifted: {neutral_danger}")
    themed_accent = resolve_pdf_role(resolve_pdf_theme("clinical"), "accent", "self-test.role")
    if themed_accent["fill"] != "B4552D" or themed_accent["bg"] == themed_accent["fill"]:
        raise PdfToolError(f"self-test theme role drifted: {themed_accent}")
    try:
        resolve_pdf_role(None, "accent", "self-test.role")
    except PdfToolError:
        pass
    else:
        raise PdfToolError("self-test expected theme roles to require a design theme")
    # 设计档 A：自定义强调色（hex）放行，糊在纸面上的浅色必须被拒。
    custom_accent = resolve_pdf_role(None, "#1F5FA9", "self-test.role")
    if custom_accent["fill"] != "1F5FA9" or custom_accent["onFill"] not in {"FFFFFF", "000000"}:
        raise PdfToolError(f"self-test custom accent drifted: {custom_accent}")
    try:
        resolve_pdf_role(None, "#FFF200", "self-test.role")
    except PdfToolError:
        pass
    else:
        raise PdfToolError("self-test expected low-contrast hex accent to be rejected")

    styled_spec = root / "styled.json"
    styled_pdf = root / "styled.pdf"
    styled_text = root / "styled-text.json"
    styled_tables = root / "styled-tables.json"
    write_json(
        styled_spec,
        {
            "title": "样式自检",
            "body": "| 指标 | 数值 |\n| --- | --- |\n| 心率 | 88 |",
            "tableStyle": {"variant": "three-line"},
            "callout": {"role": "warning", "title": "注意", "body": "语义色提示框。"},
            "sections": [
                {"heading": "风险提示", "accent": "danger", "body": "低血压处置。"},
                {
                    "heading": "生命体征",
                    "body": "| 时间 | 心率 |\n| --- | --- |\n| 08:00 | 88 |",
                    "tableStyle": {"variant": "grid"},
                },
            ],
        },
    )
    run_self_test_command(
        ["make", "--spec", str(styled_spec), "--out", str(styled_pdf), "--force"]
    )
    run_self_test_command(
        [
            "inspect",
            "--input",
            str(styled_pdf),
            "--out",
            str(root / "styled-inspection.json"),
            "--text-out",
            str(styled_text),
            "--tables-out",
            str(styled_tables),
        ]
    )
    styled_pages = json.loads(styled_text.read_text(encoding="utf-8")).get("pages") or []
    styled_body = "".join(str(page.get("text") or "") for page in styled_pages)
    for expected in ("注意", "语义色提示框", "风险提示", "心率", "88"):
        if expected not in styled_body:
            raise PdfToolError(f"self-test styled PDF lost '{expected}'")
    styled_table_pages = json.loads(styled_tables.read_text(encoding="utf-8")).get("pages") or []
    styled_table_count = sum(len(page.get("tables") or []) for page in styled_table_pages)
    if styled_table_count < 1:
        raise PdfToolError("self-test styled PDF lost its grid table")

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
            "styledPdf": str(styled_pdf),
            "semanticRole": neutral_danger["fg"],
            "themeRole": themed_accent["fill"],
            "styledTables": styled_table_count,
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

    deliver_parser = subparsers.add_parser(
        "deliver",
        help="Audit a PDF, check requirement coverage, and record delivery state",
    )
    deliver_parser.add_argument("--input", required=True)
    deliver_parser.add_argument("--report")
    deliver_parser.add_argument(
        "--acceptance",
        help="Protocol acceptance record (pilotdeck-qa-acceptance/v1)",
    )
    deliver_parser.add_argument(
        "--require-text",
        action="append",
        help="Text that must appear in the extracted PDF text; may be repeated",
    )
    deliver_parser.add_argument("--min-pages", type=int)
    deliver_parser.add_argument("--max-pages", type=int)
    deliver_parser.add_argument(
        "--visual-review",
        help="Protocol review record (pilotdeck-qa-review/v1) bound to this file",
    )
    deliver_parser.add_argument("--render-dir")
    deliver_parser.add_argument("--montage")
    deliver_parser.add_argument("--dpi", type=int, default=144)
    deliver_parser.add_argument(
        "--require-render",
        action="store_true",
        help="Fail delivery when rendering is unavailable",
    )
    deliver_parser.set_defaults(handler=command_deliver)

    make_parser = subparsers.add_parser("make", help="Create a PDF from title/body/spec using bundled fonts")
    make_parser.add_argument("--title")
    make_parser.add_argument("--body")
    make_parser.add_argument("--body-file")
    make_parser.add_argument("--markdown")
    make_parser.add_argument("--author")
    make_parser.add_argument("--spec")
    make_parser.add_argument(
        "--design-theme",
        dest="design_theme",
        help="Design theme ID, Chinese name or alias (see `tokens.py --list`)",
    )
    make_parser.add_argument(
        "--toc",
        action="store_true",
        help="Insert a table of contents built from level-1/2 headings",
    )
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
