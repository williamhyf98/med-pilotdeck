"""Map a PDF ``delivery.json`` onto the shared QA checks.

``pdf.sh deliver`` keeps writing its own report; this adapter only reads it.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import clean_requirements, issue  # noqa: E402

SKILL = "pdf"
SOURCE = "pdf-delivery"


def _derived_requirements(coverage: dict) -> dict:
    text: list[str] = []
    pages: dict[str, int] = {}
    for check in coverage.get("checks") or []:
        if not isinstance(check, dict):
            continue
        kind = check.get("type")
        if kind == "required_text" and isinstance(check.get("value"), str):
            text.append(check["value"])
        elif kind == "page_count_min" and isinstance(check.get("expected"), int):
            pages["min"] = check["expected"]
        elif kind == "page_count_max" and isinstance(check.get("expected"), int):
            pages["max"] = check["expected"]
    return clean_requirements({"text": text, "pages": pages})


def _coverage_issues(coverage: dict) -> list[dict]:
    issues: list[dict] = []
    for failure in coverage.get("failures") or []:
        if not isinstance(failure, dict):
            continue
        kind = str(failure.get("type") or "requirement")
        if kind == "required_text":
            message = f"PDF 文本中缺少要求的内容：{failure.get('value')}"
        elif kind == "page_count_min":
            message = f"页数不足：要求至少 {failure.get('expected')} 页，实际 {failure.get('actual')} 页"
        elif kind == "page_count_max":
            message = f"页数超出：要求最多 {failure.get('expected')} 页，实际 {failure.get('actual')} 页"
        else:
            message = f"未满足验收要求：{kind}"
        issues.append(issue("error", f"requirement-not-met:{kind}", message, SOURCE,
                            requirement=failure))
    return issues


def map_report(report: dict, *, artifact_sha256: str) -> dict:
    artifact = report.get("artifact") if isinstance(report.get("artifact"), dict) else {}
    audit = report.get("audit") if isinstance(report.get("audit"), dict) else {}
    coverage = report.get("coverage") if isinstance(report.get("coverage"), dict) else {}
    render = report.get("render") if isinstance(report.get("render"), dict) else {}
    visual_raw = report.get("visualReview") if isinstance(report.get("visualReview"), dict) else {}
    gates = report.get("gates") if isinstance(report.get("gates"), dict) else {}

    issues: list[dict] = []
    recorded_sha = artifact.get("sha256")
    stale = isinstance(recorded_sha, str) and recorded_sha != artifact_sha256
    if stale:
        issues.append(issue(
            "error",
            "artifact-changed-since-delivery",
            "The PDF changed after delivery verification; the old audit and renders no longer apply",
            SOURCE,
            recordedSha256=recorded_sha,
            actualSha256=artifact_sha256,
        ))

    hard_failures = [item for item in audit.get("hardFailures") or [] if isinstance(item, str)]
    for message in hard_failures:
        issues.append(issue("error", "audit-hard-failure", message, SOURCE))
    for message in audit.get("warnings") or []:
        if isinstance(message, str):
            issues.append(issue("warning", "audit-warning", message, SOURCE))

    gate_errors = [item for item in gates.get("errors") or [] if isinstance(item, dict)]
    for item in gate_errors:
        issues.append(issue(
            "error",
            str(item.get("code") or "delivery-gate"),
            str(item.get("message") or "delivery gate failed"),
            SOURCE,
        ))

    render_status = str(render.get("status") or "")
    if render_status == "failed":
        issues.append(issue(
            "error",
            "render-failed",
            str(render.get("reason") or "PDF rendering failed"),
            SOURCE,
        ))
    elif render_status == "skipped":
        issues.append(issue(
            "warning",
            "visual-not-performed",
            str(render.get("reason") or "Rendering was not available"),
            SOURCE,
        ))

    issues.extend(_coverage_issues(coverage))

    visual_status = str(visual_raw.get("status") or "not-reviewed")
    for message in visual_raw.get("errors") or []:
        if isinstance(message, str):
            issues.append(issue("error", "visual-review-invalid", message, SOURCE))

    structural_failed = (
        stale
        or bool(hard_failures)
        or bool(gate_errors)
        or render_status == "failed"
    )
    if structural_failed:
        structural = "failed"
    elif audit.get("status") in {"ok", "failed"}:
        structural = "passed"
    else:
        structural = "not_checked"

    coverage_status = str(coverage.get("status") or "")
    if coverage_status == "failed":
        content = "failed"
    elif coverage_status == "passed":
        content = "passed"
    else:
        content = "not_checked"

    if visual_status == "failed":
        visual = "failed"
    elif visual_status == "passed":
        visual = "passed"
    else:
        visual = "not_performed"

    page_count = artifact.get("pageCount")
    visual_evidence = None
    if visual == "passed":
        visual_evidence = {
            "source": SOURCE,
            "kind": "legacy-visual-review",
            "report": visual_raw.get("report"),
            "pagesReviewed": [
                page for page in visual_raw.get("pagesReviewed") or [] if isinstance(page, int)
            ],
            "artifactSha256": recorded_sha,
        }
    return {
        "checks": {
            "structural": structural,
            "content": content,
            "visual": visual,
            "assets": "complete",
        },
        "issues": issues,
        "missingAssets": [],
        "requirements": _derived_requirements(coverage),
        "style": {},
        "expectedPages": page_count if isinstance(page_count, int) else None,
        "visualEvidence": visual_evidence,
        "summary": {
            "legacyStatus": report.get("status"),
            "auditStatus": audit.get("status"),
            "coverageStatus": coverage_status or None,
            "renderStatus": render_status or None,
            "visualReviewStatus": visual_status,
            "pageCount": page_count,
        },
    }
