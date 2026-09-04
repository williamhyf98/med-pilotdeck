#!/usr/bin/env python3
"""Run the fixed RAG query suite against the active med-tools corpus."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError as exc:
            raise SystemExit(f"{path}:{line_number}: invalid JSONL: {exc}") from exc
    return rows


def summarize_case(case: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    chunks = payload.get("chunks") if isinstance(payload.get("chunks"), list) else []
    top = chunks[0] if chunks else {}
    top_image_refs = [
        ref for ref in (top.get("image_refs") or []) if isinstance(ref, dict)
    ]
    top3_chunks = chunks[:3]
    image_refs = [
        ref
        for chunk in chunks
        for ref in (chunk.get("image_refs") or [])
        if isinstance(ref, dict)
    ]
    interleave = (
        payload.get("interleave_context")
        if isinstance(payload.get("interleave_context"), list)
        else []
    )
    display_images = [
        segment
        for segment in interleave
        if isinstance(segment, dict) and segment.get("type") == "image"
    ]
    haystack = "\n".join(
        str(chunk.get(key, ""))
        for chunk in chunks
        for key in ("title", "section", "chapter_path", "text", "contents")
    )
    expected_terms = [str(term) for term in case.get("expected_terms") or []]
    matched_terms = [term for term in expected_terms if term in haystack]
    return {
        "id": case["id"],
        "query": case["query"],
        "topic": case.get("topic"),
        "status": payload.get("status"),
        "mode": payload.get("mode"),
        "elapsed_ms": payload.get("elapsed_ms"),
        "chunk_count": payload.get("chunk_count"),
        "top_chunk_id": top.get("chunk_id"),
        "top_title": top.get("title"),
        "top_section": top.get("section"),
        "top_page_start": top.get("page_start"),
        "top_page_end": top.get("page_end"),
        "top_score": top.get("score"),
        "top_image_ref_count": len(top_image_refs),
        "top3_image_ref_count": sum(
            len(chunk.get("image_refs") or []) for chunk in top3_chunks
        ),
        "image_ref_count": len(image_refs),
        "display_image_count": len(display_images),
        "first_image_path": top_image_refs[0].get("path") if top_image_refs else None,
        "expected_image": case.get("expected_image"),
        "expected_terms": expected_terms,
        "matched_terms": matched_terms,
        "term_recall": len(matched_terms) / len(expected_terms) if expected_terms else None,
        "needs_human_review": True,
        "human_verdict": "pending",
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--suite", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--top-k", type=int, default=5)
    parser.add_argument("--min-score", type=float, default=0.0)
    parser.add_argument("--prefer-lexical", action="store_true")
    args = parser.parse_args()

    from server.rag.query import query_rag

    cases = load_jsonl(args.suite)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", encoding="utf-8") as handle:
        for case in cases:
            payload = query_rag(
                query=case["query"],
                top_k=args.top_k,
                min_score=args.min_score,
                prefer_lexical=args.prefer_lexical,
            )
            handle.write(json.dumps(summarize_case(case, payload), ensure_ascii=False) + "\n")
    print(f"wrote {len(cases)} rows to {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
