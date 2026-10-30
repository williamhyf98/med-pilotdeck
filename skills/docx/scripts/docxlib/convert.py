from __future__ import annotations

import os
import platform
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from .common import (
    DocxSkillError,
    assert_valid_docx,
    require_docx_path,
    temporary_sibling,
)
from .render import (
    _seed_libreoffice_profile,
    find_soffice,
    get_office_renderer_url,
)


PDF_CONTENT_TYPE = "application/pdf"
DOCX_CONTENT_TYPE = (
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
)


def _output_pdf_path(
    source: Path,
    output_path: str | Path,
    *,
    force: bool,
) -> Path:
    output = Path(output_path).expanduser().resolve()
    if output.suffix.lower() != ".pdf":
        raise DocxSkillError(
            f"PDF output must end with .pdf: {output}",
            code="invalid-pdf-output-path",
        )
    if output == source:
        raise DocxSkillError(
            "Input DOCX and output PDF must be different paths",
            code="artifact-path-collision",
        )
    if output.exists() and not output.is_file():
        raise DocxSkillError(
            f"PDF output path is not a file: {output}",
            code="output-path-invalid",
        )
    if output.exists() and not force:
        raise DocxSkillError(
            f"output already exists; pass --force to replace: {output}",
            code="output-exists",
        )
    output.parent.mkdir(parents=True, exist_ok=True)
    return output


def _validate_pdf_bytes(payload: bytes) -> None:
    if len(payload) < 8 or not payload.startswith(b"%PDF-"):
        raise DocxSkillError(
            "DOCX conversion returned an invalid PDF payload",
            code="invalid-pdf-output",
        )


def _renderer_headers(source: Path) -> dict[str, str]:
    file_name = source.name
    if not file_name.isascii():
        file_name = f"input{source.suffix.lower() or '.docx'}"
    return {
        "Content-Type": DOCX_CONTENT_TYPE,
        "X-File-Name": file_name,
    }


def _convert_remote(
    source: Path,
    *,
    timeout_seconds: int,
) -> tuple[bytes, str]:
    renderer_url = get_office_renderer_url()
    if not renderer_url:
        raise DocxSkillError(
            "PILOTDECK_OFFICE_RENDERER_URL is not configured",
            status="unsupported",
            code="office-renderer-not-configured",
        )
    request = urllib.request.Request(
        f"{renderer_url}/v1/convert/pdf",
        data=source.read_bytes(),
        method="POST",
        headers=_renderer_headers(source),
    )
    token = os.environ.get("PILOTDECK_OFFICE_RENDERER_TOKEN", "").strip()
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            payload = response.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace").strip()
        raise DocxSkillError(
            f"Office Renderer rejected DOCX: HTTP {exc.code} {detail[:500]}",
            code="office-renderer-http-error",
        ) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise DocxSkillError(
            f"Office Renderer request failed: {exc}",
            code="office-renderer-unreachable",
        ) from exc
    _validate_pdf_bytes(payload)
    return payload, renderer_url


def _convert_local(
    source: Path,
    *,
    timeout_seconds: int,
) -> tuple[bytes, str]:
    soffice = find_soffice()
    if not soffice:
        raise DocxSkillError(
            "LibreOffice soffice was not found; configure "
            "PILOTDECK_OFFICE_RENDERER_URL or install LibreOffice",
            status="unsupported",
            code="office-conversion-backend-unavailable",
            details={"backend": "LibreOffice"},
        )

    isolated_temp_root = (
        "/private/tmp"
        if platform.system() == "Darwin" and Path("/private/tmp").is_dir()
        else None
    )
    with tempfile.TemporaryDirectory(
        prefix="pilotdeck_soffice_profile_",
        dir=isolated_temp_root,
    ) as profile_dir:
        with tempfile.TemporaryDirectory(
            prefix="pilotdeck_soffice_output_",
            dir=isolated_temp_root,
        ) as convert_dir:
            profile_path = Path(profile_dir).resolve()
            _seed_libreoffice_profile(profile_path)
            env = os.environ.copy()
            env["HOME"] = profile_dir
            bundled_font_dir = os.environ.get("DOCX_SKILL_FONT_DIR", "").strip()
            if bundled_font_dir and Path(bundled_font_dir).is_dir():
                env["SAL_FONTPATH"] = bundled_font_dir
            if platform.system() == "Darwin" and Path("/private/tmp").is_dir():
                env["TMPDIR"] = "/private/tmp"
            command = [
                soffice,
                f"-env:UserInstallation={profile_path.as_uri()}",
                "--headless",
                "--invisible",
                "--norestore",
                "--nologo",
                "--nodefault",
                "--nolockcheck",
                "--nofirststartwizard",
                "--convert-to",
                "pdf",
                "--outdir",
                convert_dir,
                str(source),
            ]
            launch_command = (
                ["/bin/sh", "-c", 'exec "$@"', "pilotdeck-soffice", *command]
                if platform.system() == "Darwin"
                else command
            )
            try:
                process = subprocess.run(
                    launch_command,
                    capture_output=True,
                    text=True,
                    errors="replace",
                    timeout=timeout_seconds,
                    env=env,
                    check=False,
                )
            except subprocess.TimeoutExpired as exc:
                raise DocxSkillError(
                    f"LibreOffice conversion timed out after {timeout_seconds} seconds",
                    code="office-conversion-timeout",
                ) from exc

            candidates = sorted(Path(convert_dir).glob("*.pdf"))
            if process.returncode != 0 or not candidates:
                detail = (
                    process.stderr
                    or process.stdout
                    or "unknown conversion error"
                ).strip()
                raise DocxSkillError(
                    f"LibreOffice failed to create a PDF: {detail[:1000]}",
                    code="office-conversion-failed",
                )
            payload = candidates[0].read_bytes()
            _validate_pdf_bytes(payload)
            return payload, soffice


def convert_docx_to_pdf(
    input_path: str | Path,
    output_path: str | Path,
    *,
    force: bool = False,
    timeout_seconds: int = 180,
) -> dict[str, Any]:
    source = require_docx_path(input_path)
    assert_valid_docx(source)
    if timeout_seconds < 1:
        raise DocxSkillError("Timeout must be at least one second")
    output = _output_pdf_path(source, output_path, force=force)

    renderer_url = get_office_renderer_url()
    if renderer_url:
        payload, renderer = _convert_remote(
            source,
            timeout_seconds=timeout_seconds,
        )
    else:
        payload, renderer = _convert_local(
            source,
            timeout_seconds=timeout_seconds,
        )

    with temporary_sibling(output, suffix=".tmp.pdf") as staged:
        staged.write_bytes(payload)
        os.replace(staged, output)
    return {
        "status": "ok",
        "input": str(source),
        "output": str(output),
        "size": output.stat().st_size,
        "renderer": renderer,
        "format": PDF_CONTENT_TYPE,
    }
