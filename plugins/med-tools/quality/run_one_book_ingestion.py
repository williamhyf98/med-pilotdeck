#!/usr/bin/env python3
"""Run one full PDF through MinerU, chunk it, and build a portable RAG bundle.

This is intentionally a thin orchestration script.  MinerU itself remains an
external runtime dependency supplied by configuration; generated data belongs
outside the git checkout.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
if str(PLUGIN_ROOT) not in sys.path:
    sys.path.insert(0, str(PLUGIN_ROOT))

from server.rag.ingestion_ledger import IngestionLedger
from server.rag.mineru_chunking import ChunkingConfig, build_mineru_chunks, write_chunks_jsonl
from server.rag.mineru_ingestion import ingest_pdf
from server.rag.mineru_runtime import MinerURuntime
from server.rag.mineru_adapter import MinerUInvocation
from server.rag.rag_bundle import build_rag_bundle


def main() -> int:
    args = _parse_args()
    source_pdf = args.pdf.resolve()
    run_dir = args.run_dir.resolve()
    bundle_dir = args.bundle_dir.resolve()

    _validate_safe_output_path(run_dir)
    _validate_safe_output_path(bundle_dir)
    if bundle_dir.exists():
        raise FileExistsError(f"bundle directory already exists: {bundle_dir}")

    runtime = MinerURuntime.from_environment()
    runtime.validate()

    mineru_output_dir = run_dir / "mineru"
    ledger = IngestionLedger(run_dir / "state" / "ingestion-ledger.sqlite")
    invocation = MinerUInvocation.from_runtime(
        runtime=runtime,
        source=source_pdf,
        output_dir=mineru_output_dir,
        language=args.language,
        device=args.device,
        formula_enabled=args.formula,
        table_enabled=args.table,
        timeout_seconds=args.timeout_seconds,
        cpu_threads=args.cpu_threads,
    )

    ingestion = ingest_pdf(ledger=ledger, invocation=invocation)
    if ingestion.output is None:
        raise RuntimeError("MinerU ingestion did not return an output descriptor")

    corpus_path = run_dir / "corpus" / "chunks.jsonl"
    chunks = build_mineru_chunks(
        source_pdf=source_pdf,
        content_list_path=ingestion.output.content_list_path,
        config=ChunkingConfig(max_chars=args.max_chars, overlap_chars=args.overlap_chars),
    )
    write_chunks_jsonl(chunks=chunks, destination=corpus_path)

    manifest_path = build_rag_bundle(
        corpus_path=corpus_path,
        destination=bundle_dir,
        corpus_id=args.corpus_id,
        name=args.name,
        version=args.version,
        license_id=args.license_id,
    ) / "manifest.json"

    summary = _summarize(
        source_pdf=source_pdf,
        run_dir=run_dir,
        bundle_dir=bundle_dir,
        manifest_path=manifest_path,
        chunk_count=len(chunks),
        skipped_mineru=ingestion.skipped,
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pdf", type=Path, required=True, help="source PDF path")
    parser.add_argument("--run-dir", type=Path, required=True, help="intermediate output directory")
    parser.add_argument("--bundle-dir", type=Path, required=True, help="final portable bundle directory")
    parser.add_argument("--corpus-id", required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--license-id", required=True)
    parser.add_argument("--language", default="ch")
    parser.add_argument("--device", default="cpu", choices=["cpu", "cuda", "mps"])
    parser.add_argument("--formula", action="store_true", help="enable MinerU formula parsing")
    parser.add_argument("--table", action="store_true", help="enable MinerU table parsing")
    parser.add_argument("--timeout-seconds", type=int, default=43_200)
    parser.add_argument("--cpu-threads", type=int, default=1)
    parser.add_argument("--max-chars", type=int, default=1_200)
    parser.add_argument("--overlap-chars", type=int, default=160)
    return parser.parse_args()


def _validate_safe_output_path(path: Path) -> None:
    resolved = path.resolve()
    allowed_root = Path("/slow_share/jiangzhenming").resolve()
    if allowed_root not in (resolved, *resolved.parents):
        raise ValueError(f"output must stay under {allowed_root}: {resolved}")
    if resolved == allowed_root:
        raise ValueError(f"refusing to write directly into broad root: {resolved}")


def _summarize(
    *,
    source_pdf: Path,
    run_dir: Path,
    bundle_dir: Path,
    manifest_path: Path,
    chunk_count: int,
    skipped_mineru: bool,
) -> dict[str, Any]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    return {
        "source_pdf": str(source_pdf),
        "run_dir": str(run_dir),
        "bundle_dir": str(bundle_dir),
        "manifest_path": str(manifest_path),
        "chunk_count": chunk_count,
        "row_count": manifest.get("row_count"),
        "asset_count": manifest.get("asset_count"),
        "dimension": manifest.get("dimension"),
        "embedding_model": manifest.get("embedding_model"),
        "mineru_skipped": skipped_mineru,
    }


if __name__ == "__main__":
    raise SystemExit(main())
