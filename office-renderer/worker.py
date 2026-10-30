#!/usr/bin/env python3
"""Run one Office rendering job inside the Renderer bwrap boundary."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("render-docx", "convert"), required=True)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--target", choices=("pdf", "xlsx"))
    parser.add_argument("--dpi", type=int, default=144)
    parser.add_argument("--emit-pdf", action="store_true")
    parser.add_argument("--include-text", action="store_true")
    return parser.parse_args()


def _configure_environment() -> None:
    # A worker must never recursively call the remote Renderer.
    os.environ.pop("PILOTDECK_OFFICE_RENDERER_URL", None)
    os.environ.pop("PILOTDECK_OFFICE_RENDERER_TOKEN", None)
    os.environ.setdefault("DOCX_SKILL_SOFFICE", "/usr/bin/soffice")
    os.environ.setdefault(
        "DOCX_SKILL_FONT_DIR",
        str(Path(__file__).resolve().parents[1] / "pdf" / "assets" / "fonts"),
    )


def _render_docx(args: argparse.Namespace) -> dict:
    import sys

    scripts_dir = Path(__file__).resolve().parents[1] / "scripts"
    sys.path.insert(0, str(scripts_dir))
    from docxlib.render import render_docx

    result = render_docx(
        args.input,
        args.output_dir,
        dpi=args.dpi,
        emit_pdf=args.emit_pdf,
        include_text=args.include_text,
        timeout_seconds=120,
    )
    if args.emit_pdf and result.get("pdf"):
        result_path = Path(args.output_dir) / "result.pdf"
        source_pdf = Path(result["pdf"]).resolve()
        if source_pdf != result_path.resolve():
            shutil.copy2(source_pdf, result_path)
        result["pdf"] = str(result_path)
    return result


def _convert(args: argparse.Namespace) -> dict:
    target = args.target
    if target not in {"pdf", "xlsx"}:
        raise ValueError("conversion target is required")

    input_path = Path(args.input).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    profile_parent = Path(os.environ.get("TMPDIR", str(output_dir)))
    profile_parent.mkdir(parents=True, exist_ok=True)
    output_format = (
        "pdf"
        if target == "pdf"
        else "xlsx:Calc MS Excel 2007 XML"
    )
    with tempfile.TemporaryDirectory(
        prefix="pilotdeck-office-profile-",
        dir=str(profile_parent),
    ) as profile_dir:
        with tempfile.TemporaryDirectory(
            prefix="pilotdeck-office-output-",
            dir=str(profile_parent),
        ) as convert_dir:
            command = [
                os.environ.get("DOCX_SKILL_SOFFICE", "/usr/bin/soffice"),
                f"-env:UserInstallation={Path(profile_dir).as_uri()}",
                "--headless",
                "--nologo",
                "--nodefault",
                "--nolockcheck",
                "--nofirststartwizard",
                "--convert-to",
                output_format,
                "--outdir",
                convert_dir,
                str(input_path),
            ]
            process = subprocess.run(
                command,
                capture_output=True,
                text=True,
                errors="replace",
                timeout=120,
                check=False,
            )
            generated = sorted(
                path
                for path in Path(convert_dir).iterdir()
                if path.is_file() and path.suffix.lower() == f".{target}"
            )
            if not generated or generated[0].stat().st_size == 0:
                detail = (process.stderr or process.stdout or "unknown conversion error").strip()
                raise RuntimeError(
                    f"LibreOffice failed to create {target}: {detail[:1000]}"
                )
            result_path = output_dir / f"result.{target}"
            shutil.copy2(generated[0], result_path)
            return {
                "status": "ok",
                "target": target,
                "output": str(result_path),
                "size": result_path.stat().st_size,
            }


def _write_render_archive(output_dir: Path, result: dict, emit_pdf: bool) -> Path:
    pages = sorted(
        path for path in output_dir.iterdir()
        if path.is_file() and path.name.startswith("page-") and path.suffix == ".png"
    )
    manifest = {
        **result,
        "status": "ok",
        "pages": result.get("pages", len(pages)),
        "images": [path.name for path in pages],
        "pdf": "result.pdf" if emit_pdf and (output_dir / "result.pdf").is_file() else None,
        "backend": "node12-office-renderer",
    }
    archive_path = output_dir / "result.zip"
    with zipfile.ZipFile(
        archive_path,
        mode="w",
        compression=zipfile.ZIP_STORED,
    ) as archive:
        archive.writestr(
            "manifest.json",
            json.dumps(manifest, ensure_ascii=False),
        )
        for page in pages:
            archive.write(page, page.name)
        if emit_pdf and (output_dir / "result.pdf").is_file():
            archive.write(output_dir / "result.pdf", "result.pdf")
    return archive_path


def main() -> int:
    args = _parse_args()
    _configure_environment()
    try:
        result = _render_docx(args) if args.mode == "render-docx" else _convert(args)
        if args.mode == "render-docx":
            result["archive"] = str(
                _write_render_archive(Path(args.output_dir), result, args.emit_pdf)
            )
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(
            json.dumps(
                {
                    "status": "error",
                    "code": getattr(exc, "code", None) or "office-renderer-worker-failed",
                    "error": str(exc),
                },
                ensure_ascii=False,
            )
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
