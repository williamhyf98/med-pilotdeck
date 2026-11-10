#!/usr/bin/env python3
"""Static audit for offline HTML deliverables.

Fact-class checks only: no browser, no rendering, no network. Estimates are
not part of this tool. Exit code is 0 for ok/warning and 1 when an error
class issue is found.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys
import time
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit

VOID_TAGS = {
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
    "meta", "param", "source", "track", "wbr",
}
# Tags whose closing tag may legally be omitted in HTML.
OPTIONAL_CLOSE = {
    "p", "li", "dt", "dd", "tr", "td", "th", "thead", "tbody", "tfoot",
    "option", "optgroup", "colgroup", "rt", "rp",
}
MEDIA_TAGS = {"img", "svg", "table", "canvas", "video", "audio", "iframe", "object", "embed"}
RESOURCE_ATTRS = (
    ("img", "src"),
    ("source", "src"),
    ("video", "src"),
    ("video", "poster"),
    ("audio", "src"),
    ("script", "src"),
    ("link", "href"),
    ("object", "data"),
)
CSS_URL_RE = re.compile(r"url\(\s*['\"]?([^'\")]+)['\"]?\s*\)", re.IGNORECASE)
VAR_RE = re.compile(r"(--pd-[a-z0-9-]+)\s*:\s*([^;}\n]+)")
NETWORK_RE = re.compile(r"\bfetch\s*\(|\bXMLHttpRequest\b|\bnew\s+WebSocket\b")
SCHEME_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*:")

SKILL_ROOT = Path(__file__).resolve().parents[1]
SKILLS_ROOT = SKILL_ROOT.parent


def _tokens_path() -> Path | None:
    candidates = []
    configured = os.environ.get("PILOTDECK_BUNDLED_SKILLS_DIR", "").strip()
    if configured:
        candidates.append(Path(configured).expanduser() / "_shared/design-tokens.json")
    candidates.append(SKILLS_ROOT / "_shared/design-tokens.json")
    for file in candidates:
        if file.is_file():
            return file
    return None


class Collector(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.stack: list[tuple[str, int]] = []
        self.unclosed: list[dict[str, object]] = []
        self.ids: Counter[str] = Counter()
        self.resources: list[dict[str, str]] = []
        self.css_urls: list[str] = []
        self.images: list[dict[str, object]] = []
        self.styles: list[str] = []
        self.scripts: list[dict[str, object]] = []
        self.inline_script_text: list[str] = []
        self.sections: list[dict[str, object]] = []
        self.closed_sections: list[dict[str, object]] = []
        self.title = ""
        self._in_title = False
        self._style_buffer: list[str] | None = None
        self._script: dict[str, object] | None = None
        self.lang = ""
        self.charset = ""
        self.headings = 0
        self.heading_items: list[dict] = []
        self._heading_buffer: list[str] | None = None
        self._heading_level = 0
        self.text_parts: list[str] = []
        self.theme = ""
        self._style_attrs: list[str] = []
        self.base_tag = False
        self.viewport = False
        self.event_handlers: list[str] = []
        self.forms: list[str] = []
        self.meta_refresh = ""
        self.blocks: list[dict[str, object]] = []
        self.closed_blocks: list[dict[str, object]] = []

    # -- helpers ---------------------------------------------------------
    def _media(self) -> None:
        for section in self.sections:
            section["media"] = int(section["media"]) + 1

    def _text(self, text: str) -> None:
        size = len(text.strip())
        if size:
            for section in self.sections:
                section["text"] = int(section["text"]) + size

    # -- parser hooks ----------------------------------------------------
    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = {name.lower(): (value or "") for name, value in attrs}
        if tag == "html":
            self.lang = values.get("lang", "")
        if tag == "base":
            self.base_tag = True
        if tag == "meta" and values.get("charset"):
            self.charset = values["charset"].strip().lower()
        if tag == "meta" and values.get("name", "").strip().lower() == "viewport":
            self.viewport = True
        if tag == "meta" and values.get("http-equiv", "").strip().lower() == "refresh":
            self.meta_refresh = values.get("content", "")
        if tag == "form":
            self.forms.append(values.get("action", ""))
        if "data-pd-block" in values:
            kind = values["data-pd-block"].strip().lower() or tag
            self.blocks.append({
                "kind": kind,
                "tag": tag,
                "line": self.getpos()[0],
                "chars": 0,
                "images": 0,
                "rows": [],
                "columns": values.get("data-pd-columns", ""),
            })
        if tag == "tr":
            for block in self.blocks:
                block["rows"].append(0)
        if tag in {"td", "th"}:
            for block in self.blocks:
                rows = block["rows"]
                if rows:
                    rows[-1] = int(rows[-1]) + 1
        for name in values:
            if name.startswith("on") and len(name) > 2:
                self.event_handlers.append(name)
        if tag == "style":
            self._style_buffer = []
        if tag == "script":
            self._script = {"src": values.get("src", ""), "text": ""}
            self.scripts.append(self._script)
        if tag == "title":
            self._in_title = True
        if re.fullmatch(r"h[1-6]", tag):
            self.headings += 1
            self._heading_buffer = []
            self._heading_level = int(tag[1])
        if "id" in values and values["id"]:
            self.ids[values["id"]] += 1
        if "data-pd-theme" in values:
            self.theme = values["data-pd-theme"].strip()
        if "style" in values and values["style"]:
            self._style_attrs.append(values["style"])
        for owner, attr in RESOURCE_ATTRS:
            if tag == owner and values.get(attr):
                self.resources.append({"tag": tag, "attr": attr, "value": values[attr].strip()})
        if tag == "a" and values.get("href"):
            self.resources.append({"tag": "a", "attr": "href", "value": values["href"].strip()})
        if values.get("srcset"):
            for part in values["srcset"].split(","):
                url = part.strip().split(" ")[0]
                if url:
                    self.resources.append({"tag": tag, "attr": "srcset", "value": url})
        if tag == "img":
            self.images.append({"src": values.get("src", ""), "alt": "alt" in values})
        if tag in MEDIA_TAGS:
            for block in self.blocks:
                block["images"] = int(block["images"]) + 1
        if tag == "section":
            self.sections.append({"line": self.getpos()[0], "text": 0, "media": 0})
        if tag in MEDIA_TAGS:
            self._media()
        if tag not in VOID_TAGS:
            self.stack.append((tag, self.getpos()[0]))

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = {name.lower(): (value or "") for name, value in attrs}
        if tag == "img":
            self.images.append({"src": values.get("src", ""), "alt": "alt" in values})
        for owner, attr in RESOURCE_ATTRS:
            if tag == owner and values.get(attr):
                self.resources.append({"tag": tag, "attr": attr, "value": values[attr].strip()})
        self._media()

    def handle_endtag(self, tag: str) -> None:
        if self.blocks and self.blocks[-1]["tag"] == tag:
            self.closed_blocks.append(self.blocks.pop())
        if tag == "style" and self._style_buffer is not None:
            self.styles.append("".join(self._style_buffer))
            self._style_buffer = None
        if tag == "script" and self._script is not None:
            text = str(self._script.get("text") or "")
            if text:
                self.inline_script_text.append(text)
            self._script = None
        if tag == "title":
            self._in_title = False
        if re.fullmatch(r"h[1-6]", tag) and self._heading_buffer is not None:
            text = _collapse(" ".join(self._heading_buffer))
            if text:
                self.heading_items.append({"level": self._heading_level, "text": text})
            self._heading_buffer = None
        if tag == "section" and self.sections:
            self.closed_sections.append(self.sections.pop())
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index][0] == tag:
                for child, line in self.stack[index + 1:]:
                    if child not in OPTIONAL_CLOSE:
                        self.unclosed.append({"tag": child, "line": line})
                del self.stack[index:]
                break

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title += data
        if self._style_buffer is not None:
            self._style_buffer.append(data)
            return
        if self._script is not None:
            self._script["text"] = str(self._script["text"]) + data
            return
        if self._heading_buffer is not None:
            self._heading_buffer.append(data)
        self.text_parts.append(data)
        for block in self.blocks:
            block["chars"] = int(block["chars"]) + len(data.strip())
        self._text(data)

    def close(self) -> None:
        super().close()
        while self.blocks:
            self.closed_blocks.append(self.blocks.pop())
        for tag, line in self.stack:
            if tag in OPTIONAL_CLOSE:
                continue
            self.unclosed.append({"tag": tag, "line": line})
        for block in [*self.styles, *self._style_attrs]:
            self.css_urls.extend(match.group(1).strip() for match in CSS_URL_RE.finditer(block))


def _is_local(value: str) -> bool:
    lowered = value.lower()
    return not (
        lowered.startswith(("http://", "https://", "//", "file://"))
        or lowered.startswith("data:")
    )


def _classify(value: str) -> str:
    lowered = value.lower()
    if lowered.startswith(("http://", "https://", "//")):
        return "external"
    if lowered.startswith("file://"):
        return "file-url"
    if lowered.startswith("data:"):
        return "data" if _safe_data_url(lowered) else "unsafe-data"
    if lowered.startswith("javascript:"):
        return "javascript"
    if lowered.startswith("#"):
        return "anchor"
    if SCHEME_RE.match(value) and not re.match(r"^[a-zA-Z]:[\\/]", value):
        return "other-scheme"
    return "local"


def _safe_data_url(lowered: str) -> bool:
    """Allow inert inline payloads only; reject executable documents."""
    if lowered.startswith(("data:image/svg", "data:text/html", "data:application/xhtml",
                           "data:application/javascript", "data:text/javascript")):
        return False
    return lowered.startswith((
        "data:image/png", "data:image/jpeg", "data:image/gif", "data:image/webp",
        "data:image/avif", "data:image/bmp",
        "data:font/", "data:application/font", "data:application/octet-stream",
    ))


def _issue(severity: str, code: str, message: str, detail: dict | None = None) -> dict:
    item = {"severity": severity, "code": code, "message": message}
    if detail:
        item["detail"] = detail
    return item


def _collapse(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def _squeeze(value: str) -> str:
    """Whitespace-insensitive form: inline markup must not break a requirement match."""
    return re.sub(r"\s+", "", value or "")


def _requirement_checks(
    require_text: list[str],
    require_headings: list[str],
    body_text: str,
    heading_items: list[dict],
) -> tuple[list[dict], list[dict]]:
    results: list[dict] = []
    issues: list[dict] = []
    haystack = _squeeze(body_text)
    heading_pool = [_squeeze(str(item["text"])) for item in heading_items]
    for value in require_text:
        needle = _squeeze(value)
        passed = bool(needle) and needle in haystack
        results.append({"type": "text", "value": value, "status": "passed" if passed else "failed"})
        if not passed:
            issues.append(_issue(
                "error",
                "requirement-not-met:text",
                f"页面正文里找不到要求的内容：{value}",
                {"value": value},
            ))
    for value in require_headings:
        needle = _squeeze(value)
        passed = bool(needle) and any(
            needle in item or (item and item in needle) for item in heading_pool
        )
        results.append({
            "type": "heading", "value": value, "status": "passed" if passed else "failed",
        })
        if not passed:
            issues.append(_issue(
                "error",
                "requirement-not-met:heading",
                f"页面里找不到要求的标题：{value}",
                {"value": value},
            ))
    return results, issues


def _relative_within(base: Path, value: str) -> tuple[str, Path | None]:
    clean = unquote(urlsplit(value).path)
    if not clean:
        return "empty", None
    if clean.startswith("/"):
        return "absolute", None
    resolved = (base / clean).resolve()
    try:
        resolved.relative_to(base)
    except ValueError:
        return "outside", resolved
    return "inside", resolved


def _theme_checks(
    declared: str,
    styles: list[str],
    inline: list[str],
) -> tuple[list[dict], dict]:
    issues: list[dict] = []
    tokens_file = _tokens_path()
    report: dict = {"declared": declared or None, "id": None, "missing": [], "mismatched": []}
    if not declared:
        # The default theme is clinical, so a page that inlines the bundled
        # token CSS but forgets data-pd-theme renders unpainted: the selectors
        # are all scoped to html[data-pd-theme="..."]. Say so instead of
        # silently passing the theme check.
        if any(re.search(r"--pd-paper\s*:", block) for block in [*styles, *inline]):
            issues.append(_issue(
                "warning",
                "theme-attribute-missing",
                "Theme tokens are inlined but <html> has no data-pd-theme; "
                "no theme rule would apply. The default theme is 'clinical'.",
                {"expected": "clinical"},
            ))
        return issues, report
    if tokens_file is None:
        issues.append(_issue(
            "warning",
            "theme-tokens-unavailable",
            "design-tokens.json was not found; theme values were not verified.",
        ))
        return issues, report
    tokens = json.loads(tokens_file.read_text(encoding="utf-8"))
    matches = [
        theme_id for theme_id, theme in tokens["themes"].items()
        if declared in [theme_id, theme.get("label"), *theme.get("aliases", [])]
    ]
    if len(matches) != 1:
        issues.append(_issue(
            "error",
            "unknown-theme",
            f"data-pd-theme={declared!r} does not resolve to exactly one bundled theme.",
            {"declared": declared},
        ))
        return issues, report
    theme_id = matches[0]
    report["id"] = theme_id
    if declared != theme_id:
        issues.append(_issue(
            "error",
            "theme-id-required",
            f"data-pd-theme must use the canonical id {theme_id!r}; aliases such as {declared!r} do not match the CSS selector.",
            {"declared": declared, "expected": theme_id},
        ))
        return issues, report
    theme = tokens["themes"][theme_id]

    def kebab(value: str) -> str:
        return re.sub(r"[A-Z]", lambda m: f"-{m.group(0).lower()}", value)

    expected: dict[str, str] = {}
    for key, value in theme["colors"].items():
        expected[f"--pd-{kebab(key)}"] = value.upper()
    for name, semantic in tokens["semantic"].items():
        expected[f"--pd-{name}"] = semantic["fg"].upper()
        expected[f"--pd-{name}-bg"] = semantic["bg"].upper()

    blocks = [*styles, *inline]
    selector = re.compile(
        rf'html\[data-pd-theme\s*=\s*["\']?{re.escape(theme_id)}["\']?\s*\]\s*\{{([^}}]*)\}}',
        re.IGNORECASE | re.DOTALL,
    )
    scoped = next((match.group(1) for block in blocks if (match := selector.search(block))), None)
    report["scope"] = "selector" if scoped is not None else "document"
    if scoped is None:
        issues.append(_issue(
            "warning",
            "theme-scope-not-found",
            f"No html[data-pd-theme=\"{theme_id}\"] block found; tokens were checked across the whole document.",
            {"theme": theme_id},
        ))
    declared_vars: dict[str, str] = {}
    for block in ([scoped] if scoped is not None else blocks):
        for name, value in VAR_RE.findall(block):
            declared_vars[name.strip()] = value.strip()
    for name, value in expected.items():
        actual = declared_vars.get(name)
        if actual is None:
            report["missing"].append(name)
            issues.append(_issue(
                "error",
                "theme-token-missing",
                f"{theme_id} is missing {name}.",
                {"theme": theme_id, "token": name},
            ))
            continue
        if actual.upper().lstrip("#") != value:
            report["mismatched"].append(name)
            issues.append(_issue(
                "error",
                "theme-token-mismatch",
                f"{name} is {actual!r}; {theme_id} requires #{value}.",
                {"theme": theme_id, "token": name, "expected": f"#{value}", "actual": actual},
            ))
    for name in ("--pd-font-body", "--pd-font-heading", "--pd-font-mono"):
        if name not in declared_vars:
            report["missing"].append(name)
            issues.append(_issue(
                "error",
                "theme-token-missing",
                f"{theme_id} is missing {name}.",
                {"theme": theme_id, "token": name},
            ))
    return issues, report


ESTIMATE_CHARS_PER_LINE = 60
ESTIMATE_LINE_HEIGHT = 26
ESTIMATE_BLOCK_PADDING = 80
ESTIMATE_MAX_HEIGHT = 1350  # 150% of a 900 px viewport
ESTIMATE_MAX_WIDTH = 1440  # 150% of a 960 px column
ESTIMATE_TABLE_COLUMN = 96
ESTIMATE_FIGURE_COLUMN = 260


def _estimate_blocks(blocks: list[dict[str, object]]) -> tuple[list[dict], list[dict]]:
    """Heuristic layout budget for explicitly marked blocks only.

    Never blocks delivery; results are warnings in the internal report.
    """
    estimates: list[dict] = []
    issues: list[dict] = []
    for block in blocks:
        kind = str(block["kind"])
        chars = int(block["chars"])
        entry: dict[str, object] = {
            "kind": kind,
            "line": block["line"],
            "chars": chars,
            "images": int(block["images"]),
            "estimated_height_px": None,
            "estimated_width_px": None,
        }
        if kind == "table":
            rows = [int(value) for value in block["rows"]]
            columns = max(rows) if rows else 0
            width = columns * ESTIMATE_TABLE_COLUMN + 40
            entry["columns"] = columns
            entry["rows"] = len(rows)
            entry["estimated_width_px"] = width
            entry["estimated_height_px"] = len(rows) * 34 + 60
            if width > ESTIMATE_MAX_WIDTH:
                issues.append(_issue(
                    "warning",
                    "estimate-wide-table",
                    f"表宽估算 {width}px 超过 {ESTIMATE_MAX_WIDTH}px，列可能被挤压或需要横向滚动。",
                    {"line": block["line"], "columns": columns, "estimated_width_px": width},
                ))
        elif kind == "figure-grid":
            raw = str(block["columns"] or "3")
            columns = int(raw) if raw.isdigit() else 3
            width = columns * ESTIMATE_FIGURE_COLUMN
            entry["columns"] = columns
            entry["estimated_width_px"] = width
            if width > ESTIMATE_MAX_WIDTH:
                issues.append(_issue(
                    "warning",
                    "estimate-figure-overflow",
                    f"图组按 {columns} 列估算宽 {width}px，超过 {ESTIMATE_MAX_WIDTH}px。",
                    {"line": block["line"], "columns": columns, "estimated_width_px": width},
                ))
        else:
            lines = max(1, math.ceil(chars / ESTIMATE_CHARS_PER_LINE))
            height = lines * ESTIMATE_LINE_HEIGHT + ESTIMATE_BLOCK_PADDING
            entry["estimated_lines"] = lines
            entry["estimated_height_px"] = height
            if height > ESTIMATE_MAX_HEIGHT:
                issues.append(_issue(
                    "warning",
                    "estimate-tall-block",
                    f"区块高度估算 {height}px，超过 {ESTIMATE_MAX_HEIGHT}px，考虑拆分或改为表格/分页。",
                    {"line": block["line"], "estimated_height_px": height},
                ))
        estimates.append(entry)
    return estimates, issues


def audit(
    path: Path,
    *,
    max_bytes: int = 8 * 1024 * 1024,
    estimate: bool = True,
    require_text: list[str] | None = None,
    require_headings: list[str] | None = None,
) -> dict:
    started = time.perf_counter()
    if path.is_dir():
        path = path / "index.html"
    path = path.resolve()
    if not path.is_file():
        raise SystemExit(f"HTML file not found: {path}")
    base = path.parent
    raw = path.read_text(encoding="utf-8", errors="replace")
    size = path.stat().st_size

    parser = Collector()
    parser.feed(raw)
    parser.close()
    parsed = time.perf_counter()

    issues: list[dict] = []
    counts = {"external": 0, "missing": 0, "outside": 0, "absolute": 0, "local": 0}

    checked: list[str] = []
    for ref in parser.resources:
        value = ref["value"]
        kind = _classify(value)
        if kind == "external":
            counts["external"] += 1
            if ref["tag"] in {"script", "link", "img", "source", "video", "audio", "object"}:
                issues.append(_issue(
                    "error",
                    "external-resource",
                    f"<{ref['tag']} {ref['attr']}> loads an external resource in an offline deliverable.",
                    {"value": value},
                ))
            else:
                issues.append(_issue(
                    "warning",
                    "external-link",
                    "A link points to an external site; it will not work offline.",
                    {"value": value},
                ))
            continue
        if kind == "file-url":
            issues.append(_issue(
                "error", "file-url", "file:// references are not portable.", {"value": value}
            ))
            continue
        if kind == "javascript":
            issues.append(_issue(
                "error", "javascript-url", "javascript: URLs are executable content and are blocked.",
                {"value": value},
            ))
            continue
        if kind == "unsafe-data":
            issues.append(_issue(
                "error", "unsafe-data-url",
                "Only inert inline payloads (raster images, fonts) are allowed as data: URLs.",
                {"value": value[:80]},
            ))
            continue
        if kind in {"data", "anchor", "other-scheme"}:
            continue
        status, resolved = _relative_within(base, value)
        if status == "empty":
            continue
        if status == "absolute":
            counts["absolute"] += 1
            issues.append(_issue(
                "error", "absolute-resource", "Resources must use relative paths.",
                {"value": value},
            ))
            continue
        if status == "outside":
            counts["outside"] += 1
            issues.append(_issue(
                "error", "resource-outside-page", "Reference escapes the page directory.",
                {"value": value},
            ))
            continue
        counts["local"] += 1
        checked.append(str(resolved))
        if not resolved or not resolved.exists():
            counts["missing"] += 1
            issues.append(_issue(
                "error", "missing-resource",
                "Referenced file does not exist next to the page.",
                {"value": value},
            ))

    for value in parser.css_urls:
        kind = _classify(value)
        if kind == "external":
            issues.append(_issue(
                "error", "external-css-resource",
                "CSS url() points to an external resource.",
                {"value": value},
            ))
        elif kind == "javascript":
            issues.append(_issue(
                "error", "javascript-url", "CSS url() uses javascript:.", {"value": value}
            ))
        elif kind == "unsafe-data":
            issues.append(_issue(
                "error", "unsafe-data-url", "CSS url() uses an executable data: payload.",
                {"value": value[:80]},
            ))
        elif kind == "file-url":
            issues.append(_issue(
                "error", "file-url", "CSS url() uses file://.", {"value": value}
            ))
        elif kind == "local":
            status, resolved = _relative_within(base, value)
            if status in {"absolute", "outside"}:
                issues.append(_issue(
                    "error", "resource-outside-page",
                    "CSS url() escapes the page directory.",
                    {"value": value},
                ))
            elif resolved is not None and not resolved.exists():
                issues.append(_issue(
                    "error", "missing-resource",
                    "CSS url() target does not exist.",
                    {"value": value},
                ))

    if re.search(r"@import\b", "\n".join(parser.styles), re.IGNORECASE):
        issues.append(_issue(
            "warning", "css-import",
            "@import in an offline single file often hides a missing dependency; inline it instead.",
        ))

    for script in parser.scripts:
        if script.get("src"):
            issues.append(_issue(
                "error", "external-script",
                "External <script src> is not allowed; inline the code.",
                {"value": script["src"]},
            ))
    if any(NETWORK_RE.search(text) for text in parser.inline_script_text):
        issues.append(_issue(
            "warning", "network-call",
            "Inline script appears to call fetch/XMLHttpRequest/WebSocket; offline pages should stay static.",
        ))

    for image in parser.images:
        if not image["alt"]:
            issues.append(_issue(
                "warning", "img-alt-missing",
                "Image has no alt attribute; screen readers and missing-image states need it.",
                {"src": image["src"]},
            ))

    duplicates = [value for value, count in parser.ids.items() if count > 1]
    for value in duplicates:
        issues.append(_issue(
            "error", "duplicate-id", "Element id is not unique.", {"id": value}
        ))

    for block in parser.unclosed:
        issues.append(_issue(
            "error", "unclosed-tag",
            f"<{block['tag']}> opened at line {block['line']} is never closed.",
            block,
        ))

    for section in parser.closed_sections:
        if int(section["text"]) == 0 and int(section["media"]) == 0:
            issues.append(_issue(
                "warning", "empty-section",
                "Section has no text, media, or table content.",
                {"line": section["line"]},
            ))

    if not parser.title.strip():
        issues.append(_issue("warning", "missing-title", "Document has no non-empty <title>."))
    if parser.base_tag:
        issues.append(_issue(
            "error",
            "base-tag",
            "<base> changes how relative paths resolve; remove it from folder deliverables.",
        ))
    if not parser.viewport:
        issues.append(_issue(
            "warning", "missing-viewport",
            "Add <meta name=\"viewport\"> so the page is readable on narrow screens.",
        ))
    if parser.event_handlers:
        names = sorted(set(parser.event_handlers))
        issues.append(_issue(
            "warning", "inline-event-handler",
            "Inline event handlers increase the executable surface; prefer a small inline <script>.",
            {"attributes": names},
        ))
    if parser.meta_refresh:
        content = parser.meta_refresh.strip()
        if re.search(r"url\s*=\s*['\"]?(?:https?:)?//", content, re.IGNORECASE):
            issues.append(_issue(
                "error", "external-redirect",
                "<meta http-equiv=refresh> redirects to an external site.",
                {"content": content},
            ))
        else:
            issues.append(_issue(
                "warning", "meta-refresh",
                "<meta http-equiv=refresh> changes the reading flow; avoid it in reports.",
                {"content": content},
            ))
    for action in parser.forms:
        if not action:
            continue
        if action.lower().startswith("javascript:"):
            issues.append(_issue(
                "error", "javascript-url", "Form action uses javascript:.", {"value": action}
            ))
        elif _classify(action) == "external":
            issues.append(_issue(
                "warning", "external-form-action",
                "Form submits to an external site; offline delivery cannot.",
                {"value": action},
            ))
    if not parser.headings:
        issues.append(_issue("warning", "missing-heading", "Document has no h1-h6 headings."))
    if not parser.lang:
        issues.append(_issue("warning", "missing-lang", "<html> has no lang attribute."))
    if parser.charset != "utf-8":
        issues.append(_issue(
            "warning", "missing-charset", "Declare <meta charset=\"utf-8\"> for Chinese text."
        ))
    if size > max_bytes:
        issues.append(_issue(
            "warning", "large-file",
            f"HTML is {size} bytes; single-file delivery above {max_bytes} bytes is hard to open.",
            {"bytes": size},
        ))

    theme_issues, theme_report = _theme_checks(parser.theme, parser.styles, parser._style_attrs)
    issues.extend(theme_issues)

    estimates: list[dict] = []
    if estimate:
        estimates, estimate_issues = _estimate_blocks(parser.closed_blocks)
        issues.extend(estimate_issues)

    requirement_results, requirement_issues = _requirement_checks(
        [item for item in (require_text or []) if str(item).strip()],
        [item for item in (require_headings or []) if str(item).strip()],
        "".join(parser.text_parts),
        parser.heading_items,
    )
    issues.extend(requirement_issues)

    finished = time.perf_counter()
    errors = sum(1 for item in issues if item["severity"] == "error")
    warnings = sum(1 for item in issues if item["severity"] == "warning")
    status = "error" if errors else ("warning" if warnings else "ok")
    return {
        "status": status,
        "file": str(path),
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "bytes": size,
        "theme": theme_report,
        "counts": {**counts, "errors": errors, "warnings": warnings},
        "document": {
            "title": parser.title.strip(),
            "lang": parser.lang or None,
            "charset": parser.charset or None,
            "headings": parser.headings,
            "headingTexts": parser.heading_items,
            "images": len(parser.images),
            "scripts_inline": len(parser.inline_script_text),
            "sections": len(parser.closed_sections),
        },
        "issues": issues,
        "requirements": {
            "text": [item for item in (require_text or []) if str(item).strip()],
            "headings": [item for item in (require_headings or []) if str(item).strip()],
            "results": requirement_results,
        },
        "estimates": {"enabled": estimate, "blocks": estimates},
        "visual_acceptance": "not_performed",
        "timing_ms": {
            "parse": round((parsed - started) * 1000, 2),
            "checks": round((finished - parsed) * 1000, 2),
            "total": round((finished - started) * 1000, 2),
        },
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Static audit for offline HTML deliverables")
    parser.add_argument("path", help="HTML file or a directory containing index.html")
    parser.add_argument("--out", help="Write the JSON report here instead of stdout")
    parser.add_argument("--max-bytes", type=int, default=8 * 1024 * 1024)
    parser.add_argument("--no-estimate", action="store_true",
                        help="Skip the heuristic layout budget (warnings only)")
    parser.add_argument("--require-text", action="append", default=[],
                        metavar="TEXT", help="Fail the audit when this text is missing")
    parser.add_argument("--require-heading", action="append", default=[],
                        metavar="TEXT", help="Fail the audit when this heading is missing")
    args = parser.parse_args(argv)
    report = audit(
        Path(args.path),
        max_bytes=args.max_bytes,
        estimate=not args.no_estimate,
        require_text=args.require_text,
        require_headings=args.require_heading,
    )
    text = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.out:
        Path(args.out).expanduser().write_text(text, encoding="utf-8")
        print(json.dumps({"status": report["status"], "out": args.out,
                          "errors": report["counts"]["errors"],
                          "warnings": report["counts"]["warnings"]}, ensure_ascii=False))
    else:
        sys.stdout.write(text)
    return 1 if report["status"] == "error" else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
