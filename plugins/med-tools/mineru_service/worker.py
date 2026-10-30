"""Worker bridge from HTTP jobs to the existing MinerU ingest service."""

from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path
from typing import Any

from server.mineru_ingest import MinerUIngestService

from .config import MinerUServiceConfig


def run_job(job_dir: Path, config: MinerUServiceConfig) -> None:
    request = json.loads((job_dir / "request.json").read_text(encoding="utf-8"))
    source = job_dir / "input" / str(request["filename"])
    tenant_root = job_dir.parent.parent
    # The existing ingest path guard requires both input and output below PILOT_HOME.
    pilot_home = tenant_root
    ingest_root = job_dir / "ingest-root"
    pilot_home.mkdir(parents=True, exist_ok=True, mode=0o700)
    ingest_root.mkdir(parents=True, exist_ok=True, mode=0o700)

    environment = config.runtime_environment()
    environment.update(
        {
            "PILOT_HOME": str(pilot_home),
            "MED_RAG_MINERU_INGEST_ROOT": str(ingest_root),
            "MED_RAG_MINERU_DEFAULT_DEVICE": config.default_device,
        }
    )
    service = MinerUIngestService(output_root=ingest_root, environment=environment)
    result = service.run_sync(
        pdf_path=str(source),
        book_id=request.get("book_id"),
        title=request.get("title"),
        volume=request.get("volume"),
        language=request.get("language", "ch"),
        device=config.default_device,
        start_page=request.get("start_page"),
        end_page=request.get("end_page"),
        page_index_offset=request.get("page_index_offset"),
        formula_enabled=bool(request.get("formula_enabled", False)),
        table_enabled=bool(request.get("table_enabled", False)),
        timeout_seconds=min(
            int(request.get("timeout_seconds") or config.job_timeout_seconds),
            config.job_timeout_seconds,
        ),
        cpu_threads=request.get("cpu_threads"),
        max_chars=int(request.get("max_chars", 1200)),
        overlap_chars=int(request.get("overlap_chars", 160)),
    )
    inner_job_dir = Path(str(result["job_dir"]))
    _build_public_bundle(
        job_dir=job_dir,
        inner_job_dir=inner_job_dir,
        filename=str(request["filename"]),
        source_sha256=str(request.get("source_sha256") or ""),
        result=result,
    )


def _build_public_bundle(
    *,
    job_dir: Path,
    inner_job_dir: Path,
    filename: str,
    source_sha256: str,
    result: dict[str, Any],
) -> None:
    public = job_dir / "artifacts"
    public.mkdir(parents=True, exist_ok=True, mode=0o700)
    manifest = json.loads((inner_job_dir / "manifest.json").read_text(encoding="utf-8"))
    for document in manifest.get("source_documents", []):
        if isinstance(document, dict):
            document["source_path"] = filename
    manifest["source_documents"] = [
        document
        for document in manifest.get("source_documents", [])
        if isinstance(document, dict)
    ]
    _write_json(public / "manifest.json", manifest)

    for relative in ("quality_report.json",):
        _copy_file(inner_job_dir / relative, public / relative)

    for relative in (
        "corpus/chunks.jsonl",
        "corpus/pages.jsonl",
        "corpus/assets.jsonl",
    ):
        source = inner_job_dir / relative
        destination = public / relative
        if relative.endswith("chunks.jsonl"):
            _copy_jsonl_with_filename(source, destination, filename)
        else:
            _copy_file(source, destination)

    assets = _read_jsonl(public / "corpus/assets.jsonl")
    for asset in assets:
        asset_path = str(asset.get("path") or "")
        if not asset_path.startswith("assets/") or ".." in Path(asset_path).parts:
            raise ValueError("MinerU asset path is invalid")
        asset_source = inner_job_dir / asset_path
        try:
            asset_source.resolve(strict=True).relative_to(inner_job_dir.resolve())
        except (OSError, RuntimeError, ValueError) as exc:
            raise ValueError("MinerU asset path escapes the job") from exc
        _copy_file(asset_source, public / asset_path)

    raw_root = inner_job_dir / "mineru_raw"
    if raw_root.is_dir():
        for source in raw_root.rglob("*"):
            if not source.is_file():
                continue
            relative = source.relative_to(raw_root)
            if not (
                source.name.endswith(".md")
                or source.name.endswith("_content_list.json")
                or source.name.endswith("_model.json")
            ):
                continue
            try:
                source.resolve(strict=True).relative_to(raw_root.resolve())
            except (OSError, RuntimeError, ValueError) as exc:
                raise ValueError("MinerU raw artifact escapes the job") from exc
            _copy_file(source, public / "mineru_raw" / relative)

    descriptors = []
    for path in sorted(public.rglob("*")):
        if not path.is_file():
            continue
        relative = path.relative_to(public).as_posix()
        descriptors.append(
            {
                "path": relative,
                "sha256": _sha256_file(path),
                "bytes": path.stat().st_size,
            }
        )
    (job_dir / "result.json").write_text(
        json.dumps(
            {
                "manifest": manifest,
                "artifacts": descriptors,
                "source_sha256": source_sha256,
                "input_type": Path(filename).suffix.lower().lstrip("."),
                "parser": manifest.get("parser", {}),
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )


def _copy_jsonl_with_filename(source: Path, destination: Path, filename: str) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    lines = []
    for item in _read_jsonl(source):
        if isinstance(item, dict) and "source_file" in item:
            item["source_file"] = filename
        lines.append(json.dumps(item, ensure_ascii=False))
    destination.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")


def _copy_file(source: Path, destination: Path) -> None:
    if not source.is_file():
        raise ValueError("MinerU output artifact is missing")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()
