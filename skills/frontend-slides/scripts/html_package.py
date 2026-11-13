#!/usr/bin/env python3
"""Build an offline HTML folder deliverable.

Copies only the files the page actually references, renames them by content
hash under assets/, rewrites the references, and replaces missing <img>
targets with an explicit "图片未提供" placeholder. No browser, no network.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import time
import zipfile
from pathlib import Path, PurePosixPath
from urllib.parse import unquote, urlsplit

from html_audit import Collector, _classify, _relative_within

IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".bmp"}
PLACEHOLDER_CSS = (
    ".pd-missing-image{display:inline-block;padding:.55em .8em;border:1px dashed "
    "currentColor;border-radius:8px;font-size:.95em;opacity:.85}"
)
MISSING_TAG_RE = re.compile(r"<img\b[^>]*>", re.IGNORECASE)


def _workspace_root(explicit: str | None) -> Path:
    if explicit:
        return Path(explicit).expanduser().resolve()
    for name in ("PILOTDECK_WORKSPACE_DIR", "PILOTDECK_WORKSPACE_CWD", "PILOTDECK_PROJECT_ROOT"):
        value = os.environ.get(name, "").strip()
        if value:
            return Path(value).expanduser().resolve()
    work = os.environ.get("PILOTDECK_WORK_DIR", "").strip()
    if work:
        path = Path(work).expanduser().resolve()
        for ancestor in (path, *path.parents):
            if ancestor.name == "work" and ancestor.parent.name == "scratch":
                return ancestor.parent.parent.resolve()
        return path.parent.resolve()
    return Path.cwd().resolve()


def _now_stamp(timezone: str) -> str:
    from datetime import datetime

    try:
        from zoneinfo import ZoneInfo

        zone = ZoneInfo(timezone)
    except Exception:  # noqa: BLE001 - fall back to host local time
        zone = None
    return datetime.now(zone).strftime("%Y%m%d-%H%M")


def _safe_stem(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_-]+", "-", value).strip("-")
    return cleaned or "asset"


def _safe_page_name(value: str) -> str:
    """Keep CJK for the user-facing folder name; strip path separators only."""
    cleaned = re.sub(r'[\x00-\x1f/\\:*?"<>|]+', "-", value).strip(" -")
    return cleaned or "html"


def _signature_ok(path: Path) -> bool:
    suffix = path.suffix.lower()
    try:
        with path.open("rb") as handle:
            head = handle.read(64)
    except OSError:
        return False
    if suffix == ".png":
        return head.startswith(b"\x89PNG\r\n\x1a\n")
    if suffix in {".jpg", ".jpeg"}:
        return head.startswith(b"\xff\xd8\xff")
    if suffix == ".gif":
        return head.startswith((b"GIF87a", b"GIF89a"))
    if suffix == ".webp":
        return head[:4] == b"RIFF" and head[8:12] == b"WEBP"
    if suffix == ".bmp":
        return head.startswith(b"BM")
    if suffix == ".svg":
        return b"<svg" in head.lower()
    if suffix == ".avif":
        return b"ftypavif" in head
    return True


def _hex_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _scan(html: Path) -> tuple[str, Collector, list[dict]]:
    raw = html.read_text(encoding="utf-8", errors="replace")
    parser = Collector()
    parser.feed(raw)
    parser.close()
    base = html.parent
    refs: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for ref in parser.resources:
        kind = _classify(ref["value"])
        if ref["tag"] == "a" and kind not in {"javascript", "unsafe-data"}:
            # Page-to-page links are not copied; a folder delivery owns only
            # its own entry page and assets.
            continue
        key = (ref["attr"], ref["value"])
        if key in seen:
            continue
        seen.add(key)
        entry = {**ref, "kind": kind, "status": None, "resolved": None}
        if kind == "local":
            status, resolved = _relative_within(base, ref["value"])
            entry["status"] = status
            entry["resolved"] = str(resolved) if resolved else None
        refs.append(entry)
    css_refs: list[dict] = []
    for value in parser.css_urls:
        key = ("url", value)
        if key in seen:
            continue
        seen.add(key)
        kind = _classify(value)
        entry = {"tag": "css", "attr": "url", "value": value, "kind": kind,
                 "status": None, "resolved": None}
        if kind == "local":
            status, resolved = _relative_within(base, value)
            entry["status"] = status
            entry["resolved"] = str(resolved) if resolved else None
        css_refs.append(entry)
    return raw, parser, [*refs, *css_refs]


def _replacement_patterns(value: str) -> list[tuple[str, str]]:
    quoted = [f'src="{value}"', f"src='{value}'",
              f'href="{value}"', f"href='{value}'",
              f"data-src=\"{value}\"", f"data-src='{value}'"]
    patterns = [(item, "src") for item in quoted]
    patterns.extend([
        (f"url({value})", "url"),
        (f'url("{value}")', "url"),
        (f"url('{value}')", "url"),
    ])
    return patterns


def _rewrite(raw: str, mapping: dict[str, str]) -> str:
    text = raw
    for original, target in mapping.items():
        for pattern, _kind in _replacement_patterns(original):
            attr, _, rest = pattern.partition("=")
            quote = rest[0] if rest and rest[0] in "\"'" else ""
            if attr.startswith("url"):
                if quote:
                    replacement = f'url("{target}")'
                else:
                    replacement = f"url({target})"
            else:
                replacement = f'{attr}={quote}{target}{quote}' if quote else f"{attr}={target}"
            text = text.replace(pattern, replacement)
        # srcset holds a comma-separated list, not a single attribute value.
        text = re.sub(
            r"srcset=([\"'])(.*?)\1",
            lambda match, old=original, new=target: (
                f'srcset={match.group(1)}{match.group(2).replace(old, new)}{match.group(1)}'
            ),
            text,
            flags=re.IGNORECASE | re.DOTALL,
        )
    return text


def _placeholder_for(raw: str, value: str, label: str) -> tuple[str, bool]:
    replaced = False

    def swap(match: re.Match[str]) -> str:
        nonlocal replaced
        tag = match.group(0)
        if not re.search(rf"""\bsrc\s*=\s*["']{re.escape(value)}["']""", tag):
            return tag
        replaced = True
        safe = label.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        return f'<span class="pd-missing-image">图片未提供（原文件：{safe}）</span>'

    return MISSING_TAG_RE.sub(swap, raw), replaced


def _inject_placeholder_css(raw: str) -> str:
    if "pd-missing-image{" in raw.replace(" ", ""):
        return raw
    style = f"<style>\n{PLACEHOLDER_CSS}\n</style>\n"
    if re.search(r"</head>", raw, re.IGNORECASE):
        return re.sub(r"</head>", style + "</head>", raw, count=1, flags=re.IGNORECASE)
    return style + raw


def package(
    html_path: Path,
    *,
    out_dir: Path | None,
    update: bool,
    workspace: Path,
    timezone: str,
    make_zip: bool = True,
) -> dict:
    started = time.perf_counter()
    html_path = html_path.expanduser().resolve()
    if not html_path.is_file():
        raise SystemExit(f"HTML file not found: {html_path}")
    if html_path.suffix.lower() not in {".html", ".htm"}:
        raise SystemExit("Input must be an .html file")
    workspace = workspace.resolve()
    try:
        html_path.relative_to(workspace)
    except ValueError:
        raise SystemExit(f"HTML source must live inside the workspace: {workspace}")

    raw, parser, refs = _scan(html_path)
    scanned = time.perf_counter()
    blocked = [
        ref for ref in refs
        if ref["kind"] in {"external", "file-url", "other-scheme", "javascript", "unsafe-data"}
        or ref["status"] in {"outside", "absolute"}
    ]
    if blocked:
        return {
            "status": "blocked",
            "code": "unportable-reference",
            "message": "去掉外链、file://、绝对路径和目录穿越后再打包",
            "references": blocked,
        }

    missing_images = [
        ref for ref in refs
        if ref["status"] != "inside" or not Path(ref["resolved"]).exists()
    ]
    non_image_missing = [
        ref for ref in missing_images if ref["tag"] != "img" or ref["attr"] != "src"
    ]
    if non_image_missing:
        return {
            "status": "blocked",
            "code": "missing-resource",
            "message": "非图片资源缺失时不能自动占位，请补齐或从页面移除后再打包",
            "references": non_image_missing,
        }

    if out_dir is None:
        exports = workspace / "exports"
        base = exports / f"{_safe_page_name(html_path.stem)}_{_now_stamp(timezone)}"
        candidate = base
        index = 2
        while candidate.exists():
            candidate = Path(f"{base}-{index}")
            index += 1
        target = candidate
    else:
        target = out_dir.expanduser().resolve()
        try:
            target.relative_to(workspace)
        except ValueError:
            return {
                "status": "blocked",
                "code": "output-outside-workspace",
                "message": "输出目录必须在工作区内",
                "output": str(target),
            }
        if target.exists() and not update:
            return {
                "status": "blocked",
                "code": "output-exists",
                "message": "目录已存在；确认要更新旧目录时才加 --update",
                "output": str(target),
            }
        if update and not (target / "index.html").is_file():
            return {
                "status": "blocked",
                "code": "not-an-existing-delivery",
                "message": "--update 只用于已有 index.html 的交付目录",
                "output": str(target),
            }
        if target == html_path.parent:
            return {
                "status": "blocked",
                "code": "output-would-overwrite-source",
                "message": "输出目录不能是源文件所在目录",
                "output": str(target),
            }

    mapping: dict[str, str] = {}
    assets: list[dict] = []
    used: dict[tuple[str, str], str] = {}
    for ref in refs:
        if ref["status"] != "inside" or not ref["resolved"]:
            continue
        source = Path(ref["resolved"])
        if not source.is_file():
            continue
        digest = _hex_digest(source)
        suffix = source.suffix.lower()
        key = (digest, suffix)
        if key in used:
            mapping[ref["value"]] = used[key]
            continue
        stem = _safe_stem(PurePosixPath(unquote(urlsplit(ref["value"]).path)).stem)
        name = f"{stem}-{digest[:8]}{suffix}"
        relative = f"assets/{name}"
        used[key] = relative
        mapping[ref["value"]] = relative
        assets.append({
            "source": str(source),
            "target": relative,
            "sha256": digest,
            "bytes": source.stat().st_size,
            "decodable": _signature_ok(source) if suffix in IMAGE_SUFFIXES else True,
        })

    collected = time.perf_counter()
    text = _rewrite(raw, mapping)
    missing_report: list[dict] = []
    for ref in missing_images:
        value = ref["value"]
        label = unquote(urlsplit(value).path) or value
        if ref["tag"] == "img" and ref["attr"] == "src":
            text, replaced = _placeholder_for(text, value, label)
            missing_report.append({
                "value": value,
                "replaced": replaced,
                "reason": "文件不存在",
            })
        else:
            missing_report.append({"value": value, "replaced": False, "reason": "文件不存在"})
    if any(item["replaced"] for item in missing_report):
        text = _inject_placeholder_css(text)

    target.mkdir(parents=True, exist_ok=True)
    assets_dir = target / "assets"
    if assets:
        assets_dir.mkdir(parents=True, exist_ok=True)
    for entry in assets:
        destination = target / entry["target"]
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(entry["source"], destination)
    copied = time.perf_counter()

    index = target / "index.html"
    temporary = target / ".index.html.tmp"
    temporary.write_text(text, encoding="utf-8")
    os.replace(temporary, index)
    written = time.perf_counter()

    zip_path: Path | None = None
    zip_sha256: str | None = None
    if make_zip:
        managed = [index, *(target / entry["target"] for entry in assets)]
        zip_path, zip_sha256 = _write_zip(target, managed)
    finished = time.perf_counter()

    return {
        "status": "ok" if not missing_report else "delivered_with_missing_assets",
        "output": str(target),
        "index": str(index),
        "html_sha256": hashlib.sha256(index.read_bytes()).hexdigest(),
        "zip": str(zip_path) if zip_path else None,
        "zip_sha256": zip_sha256,
        "assets": assets,
        "missing": missing_report,
        "theme": parser.theme or None,
        "visual_acceptance": "not_performed",
        "timing_ms": {
            "scan": round((scanned - started) * 1000, 2),
            "collect": round((collected - scanned) * 1000, 2),
            "copy": round((copied - collected) * 1000, 2),
            "write": round((written - copied) * 1000, 2),
            "zip": round((finished - written) * 1000, 2),
            "total": round((finished - started) * 1000, 2),
        },
    }


def _write_zip(target: Path, files: list[Path]) -> tuple[Path, str]:
    """Deterministic zip: sorted entries, fixed timestamps, fixed permissions."""
    zip_path = target.with_name(f"{target.name}.zip")
    temporary = target.with_name(f"{target.name}.zip.tmp")
    with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED) as archive:
        for file in sorted(set(files)):
            relative = file.relative_to(target).as_posix()
            info = zipfile.ZipInfo(relative, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, file.read_bytes())
    os.replace(temporary, zip_path)
    return zip_path, _hex_digest(zip_path)


def verify(target: Path) -> dict:
    """Check that a packaged folder is complete and its zip matches disk."""
    target = target.expanduser().resolve()
    index = target / "index.html"
    result: dict = {
        "status": "failed",
        "output": str(target),
        "index": str(index),
        "issues": [],
        "visual_acceptance": "not_performed",
    }
    if not index.is_file():
        result["issues"].append({"severity": "error", "code": "missing-index",
                                 "message": "Folder delivery has no index.html."})
        return result

    from html_audit import audit as audit_html

    report = audit_html(index)
    result["audit_status"] = report["status"]
    for item in report["issues"]:
        if item["severity"] == "error":
            result["issues"].append({**item, "source": "audit"})

    zip_path = target.with_name(f"{target.name}.zip")
    result["zip"] = str(zip_path) if zip_path.is_file() else None
    if not zip_path.is_file():
        result["issues"].append({
            "severity": "warning",
            "code": "zip-missing",
            "message": "No sibling .zip; users may have to download each file separately.",
        })
    else:
        try:
            with zipfile.ZipFile(zip_path) as archive:
                bad = archive.testzip()
                names = sorted(archive.namelist())
                result["zip_entries"] = len(names)
                if bad:
                    result["issues"].append({"severity": "error", "code": "zip-corrupt",
                                             "message": f"Zip entry failed CRC: {bad}"})
                if "index.html" not in names:
                    result["issues"].append({"severity": "error", "code": "zip-missing-index",
                                             "message": "Zip does not contain index.html."})
                for name in names:
                    disk = target / name
                    if not disk.is_file():
                        result["issues"].append({
                            "severity": "error",
                            "code": "zip-entry-missing-on-disk",
                            "message": f"{name} is in the zip but not on disk.",
                        })
                        continue
                    if hashlib.sha256(archive.read(name)).hexdigest() != _hex_digest(disk):
                        result["issues"].append({
                            "severity": "error",
                            "code": "zip-entry-mismatch",
                            "message": f"{name} differs between the zip and disk.",
                        })
        except zipfile.BadZipFile as error:
            result["issues"].append({"severity": "error", "code": "zip-corrupt",
                                     "message": f"Zip cannot be read: {error}"})

    errors = sum(1 for item in result["issues"] if item["severity"] == "error")
    warnings = sum(1 for item in result["issues"] if item["severity"] == "warning")
    result["status"] = "failed" if errors else ("warning" if warnings else "ok")
    return result


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Build an offline HTML folder deliverable")
    parser.add_argument("--html")
    parser.add_argument("--verify", metavar="DIR", help="Verify an existing folder delivery")
    parser.add_argument("--out-dir")
    parser.add_argument("--update", action="store_true")
    parser.add_argument("--no-zip", action="store_true", help="Skip the sibling .zip archive")
    parser.add_argument("--workspace")
    parser.add_argument("--timezone", default=os.environ.get("PILOTDECK_TIMEZONE", "Asia/Shanghai"))
    parser.add_argument("--report")
    args = parser.parse_args(argv)

    if args.verify:
        report = verify(Path(args.verify))
    else:
        if not args.html:
            parser.error("--html is required unless --verify is used")
        report = package(
            Path(args.html),
            out_dir=Path(args.out_dir) if args.out_dir else None,
            update=args.update,
            workspace=_workspace_root(args.workspace),
            timezone=args.timezone,
            make_zip=not args.no_zip,
        )
    text = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.report:
        report_path = Path(args.report).expanduser()
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(text, encoding="utf-8")
    # --report 只是留档：stdout 永远打全量（含 errors / missing assets 明细）。
    sys.stdout.write(text)
    return 0 if report["status"] in {"ok", "warning", "delivered_with_missing_assets"} else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
