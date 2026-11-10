#!/usr/bin/env python3
"""Convert a legacy DOCX/PPTX/XLSX report into a unified QA report.

The legacy report and the legacy commands are never modified. This command is a
read-only translation layer (T3a.2):

    python3 skills/_shared/qa/adapters/adapt.py docx \
        --report qa/preflight-final.json --artifact exports/report.docx \
        --out qa/qa-report.json

Without ``--acceptance`` the adapter writes ``acceptance.derived.json`` next to
the output, derived from the requirements the legacy gate already enforced.
"""

from __future__ import annotations

import argparse
import importlib
import json
import sys
from pathlib import Path

ADAPTER_DIR = Path(__file__).resolve().parent
QA_DIR = ADAPTER_DIR.parent
for path in (ADAPTER_DIR, QA_DIR):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from common import (  # noqa: E402
    AdapterError,
    compact_issues,
    derived_acceptance,
    load_object,
    sha256_file,
    write_json,
)
from qa_protocol import (  # noqa: E402
    QaError,
    build_report,
    load_review,
    validate_review,
)

ADAPTERS = {
    "docx": "from_docx_preflight",
    "pptx": "from_pptx_delivery",
    "xlsx": "from_xlsx_report",
    "pdf": "from_pdf_delivery",
    # HTML has two gates: the static audit and the folder/zip packager.
    "html": "from_html_audit",
    "diagram": "from_diagram_report",
}

HTML_ADAPTERS = {
    "audit": "from_html_audit",
    "package": "from_html_package",
}


def html_kind(report: dict, requested: str | None) -> str:
    if requested in HTML_ADAPTERS:
        return requested
    if "document" in report or "estimates" in report:
        return "audit"
    if "index" in report or "html_sha256" in report or "missing" in report:
        return "package"
    raise AdapterError(
        "HTML report is neither an audit nor a package report",
        "unknown-html-report",
        {"keys": sorted(report)},
    )


def run(args: argparse.Namespace) -> dict:
    skill = args.command
    report_path = Path(args.report).expanduser().resolve()
    artifact_path = Path(args.artifact).expanduser().resolve()
    if not artifact_path.is_file():
        raise AdapterError(f"Artifact not found: {artifact_path}", "missing-artifact",
                           {"path": str(artifact_path)})
    legacy = load_object(report_path, f"{skill} report")
    artifact_sha = sha256_file(artifact_path)

    module_name = ADAPTERS[skill]
    kind_used = None
    if skill == "html":
        kind_used = html_kind(legacy, getattr(args, "kind", None))
        module_name = HTML_ADAPTERS[kind_used]
    mapped = importlib.import_module(module_name).map_report(
        legacy, artifact_sha256=artifact_sha)
    out_path = (Path(args.out).expanduser().resolve()
                if args.out else report_path.parent / "qa-report.json")

    if args.acceptance:
        acceptance_path = Path(args.acceptance).expanduser().resolve()
    else:
        acceptance_path = out_path.parent / "acceptance.derived.json"
        write_json(acceptance_path, derived_acceptance(
            skill,
            mapped["requirements"],
            source=str(report_path),
            style=mapped.get("style") or None,
            now=args.now,
            note=mapped.get("requirementsNote"),
        ))

    review_path = Path(args.review).expanduser().resolve() if args.review else None
    expected_pages = mapped.get("expectedPages")
    if review_path is not None and isinstance(expected_pages, int) and expected_pages > 0:
        validate_review(
            load_review(review_path),
            artifact_sha256=artifact_sha,
            expected_pages=expected_pages,
        )

    checks = dict(mapped["checks"])
    if review_path is not None and checks.get("visual") != "failed":
        # Let build_report derive the visual state from the page matrix. A legacy
        # "failed" verdict is never upgraded by a newer review.
        checks.pop("visual", None)

    qa_report = build_report(
        skill=skill,
        artifact_path=artifact_path,
        acceptance_path=acceptance_path,
        review_path=review_path,
        checks=checks,
        issues=compact_issues(mapped["issues"]),
        missing_assets=mapped["missingAssets"],
        timings_ms={},
        now=args.now,
        visual_evidence=mapped.get("visualEvidence"),
    )
    qa_report["legacy"] = {
        "report": str(report_path),
        "sha256": sha256_file(report_path),
        "acceptanceDerived": not bool(args.acceptance),
        "summary": mapped.get("summary") or {},
    }
    if kind_used:
        qa_report["legacy"]["kind"] = kind_used
    write_json(out_path, qa_report)
    return {
        "status": qa_report["status"],
        "skill": skill,
        "out": str(out_path),
        "acceptance": str(acceptance_path),
        "checks": qa_report["checks"],
        "issues": len(qa_report["issues"]),
        "missingAssets": len(qa_report["missingAssets"]),
        "summary": mapped.get("summary") or {},
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="PilotDeck QA legacy-report adapters")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ADAPTERS:
        child = sub.add_parser(name, help=f"Convert a legacy {name} report")
        child.add_argument("--report", required=True, help="Legacy report JSON")
        child.add_argument("--artifact", required=True, help="Delivered artifact")
        child.add_argument("--acceptance", help="QA acceptance record (otherwise derived)")
        child.add_argument("--review", help="QA review record (page matrix)")
        child.add_argument("--out", help="Unified report path (default: next to the legacy report)")
        child.add_argument("--now", help="Fixed timestamp for reproducible reports")
        if name == "html":
            child.add_argument("--kind", choices=sorted(HTML_ADAPTERS),
                               help="HTML report kind (auto-detected when omitted)")
    args = parser.parse_args(argv)

    try:
        result = run(args)
    except (AdapterError, QaError) as exc:
        print(json.dumps(exc.as_dict(), ensure_ascii=False))
        return 1
    except Exception as exc:  # noqa: BLE001 - keep the CLI contract on stdout
        import traceback

        traceback.print_exc()
        print(json.dumps({
            "status": "error",
            "code": "adapter-crash",
            "error": f"{type(exc).__name__}: {exc}",
        }, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["status"] in {"passed", "passed_with_warnings",
                                     "delivered_with_missing_assets"} else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
