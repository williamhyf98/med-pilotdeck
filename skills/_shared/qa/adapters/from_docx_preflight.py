"""Map a DOCX preflight report onto the shared QA checks.

Only reads the report. The DOCX acceptance manifest keeps its own shape and the
``deliver``/``preflight`` commands are untouched.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import as_issue_list, clean_requirements, issue, issue_from_legacy  # noqa: E402

SKILL = "docx"
SOURCE = "docx-preflight"

# Codes that mean "the requested content was not delivered" rather than
# "the package is broken". Mirrors preflight.py::coverage_error_codes.
COVERAGE_ERROR_CODES = frozenset({
    "page-count-above-maximum",
    "page-count-below-minimum",
    "protected-source-changed",
    "rendered-text-coverage",
    "rendered-text-empty",
    "required-heading-missing",
    "toc-missing",
    "toc-not-populated",
    "blank-body-page",
    "unrequested-header",
    "unrequested-footer",
    "unrequested-page-numbers",
})
IMAGE_SHORTFALL_CODES = frozenset({"image-count-below-minimum"})


def _unresolved(report: dict) -> tuple[list[dict], list[dict]]:
    block = report.get("unresolved") if isinstance(report.get("unresolved"), dict) else {}
    errors = [item for item in as_issue_list(block.get("errors"))
              if item.get("severity", "error") == "error"]
    warnings = [item for item in as_issue_list(block.get("warnings"))
                if item.get("severity", "warning") != "error"]
    if errors or warnings:
        return errors, warnings
    # Compact reports may only keep gate_issues.
    gate = as_issue_list(report.get("gate_issues"))
    errors = [item for item in gate
              if item.get("severity") == "error" and not item.get("resolved")]
    warnings = [item for item in gate
                if item.get("severity") == "warning" and not item.get("resolved")]
    return errors, warnings


def map_report(report: dict, *, artifact_sha256: str) -> dict:
    checks_raw = report.get("checks") if isinstance(report.get("checks"), dict) else {}
    coverage = report.get("coverage") if isinstance(report.get("coverage"), dict) else {}
    artifact = report.get("artifact") if isinstance(report.get("artifact"), dict) else {}
    visual_raw = report.get("visual_review") if isinstance(report.get("visual_review"), dict) else {}
    errors, warnings = _unresolved(report)

    issues: list[dict] = []
    recorded_sha = artifact.get("sha256")
    stale = isinstance(recorded_sha, str) and recorded_sha != artifact_sha256
    if stale:
        issues.append(issue(
            "error",
            "artifact-changed-since-preflight",
            "The DOCX changed after preflight; the old acceptance evidence no longer applies",
            SOURCE,
            recordedSha256=recorded_sha,
            actualSha256=artifact_sha256,
        ))
    for item in errors:
        # A shortfall in requested images is a delivery gap, not a broken package.
        severity = "warning" if str(item.get("code")) in IMAGE_SHORTFALL_CODES else "error"
        issues.append(issue_from_legacy(item, SOURCE, severity))
    for item in warnings:
        issues.append(issue_from_legacy(item, SOURCE, "warning"))

    structural_failed = (
        stale
        or report.get("status") == "error"
        or checks_raw.get("package_validation") not in (None, "passed")
        or any(
            str(item.get("code")) not in COVERAGE_ERROR_CODES
            and str(item.get("code")) not in IMAGE_SHORTFALL_CODES
            for item in errors
        )
    )
    if structural_failed:
        structural = "failed"
    elif checks_raw.get("package_validation") == "passed":
        structural = "passed"
    else:
        structural = "not_checked"

    coverage_errors = [item for item in errors if str(item.get("code")) in COVERAGE_ERROR_CODES]
    content_failed = (
        bool(coverage_errors)
        or coverage.get("status") == "failed"
        or checks_raw.get("text_coverage") == "failed"
    )
    if content_failed:
        content = "failed"
    elif coverage.get("status") == "passed" or checks_raw.get("text_coverage") == "passed":
        content = "passed"
    else:
        content = "not_checked"

    visual = {"passed": "passed", "failed": "failed"}.get(
        str(visual_raw.get("status")), "not_performed")

    missing: list[dict] = []
    for item in [*errors, *warnings]:
        if str(item.get("code")) in IMAGE_SHORTFALL_CODES:
            missing.append({
                "value": "images",
                "reason": str(item.get("message") or "image count below the requested minimum"),
                "required": item.get("required"),
                "actual": item.get("actual"),
            })

    acceptance_req = report.get("acceptance") if isinstance(report.get("acceptance"), dict) else {}
    raw_requirements = acceptance_req.get("requirements")
    if isinstance(raw_requirements, dict):
        requirements = clean_requirements({
            "text": raw_requirements.get("required_text") or [],
            "headings": raw_requirements.get("required_headings") or [],
            "pages": raw_requirements.get("page_count") or {},
            "images": raw_requirements.get("images") or {},
        })
    else:
        requirements = clean_requirements({})

    style: dict = {}
    policy = raw_requirements.get("style_policy") if isinstance(raw_requirements, dict) else None
    if isinstance(policy, dict):
        if isinstance(policy.get("theme_label"), str):
            style["themeLabel"] = policy["theme_label"]
        if isinstance(policy.get("theme_id"), str):
            style["themeId"] = policy["theme_id"]
        if isinstance(policy.get("template"), str):
            style["template"] = policy["template"]

    render = report.get("render") if isinstance(report.get("render"), dict) else {}
    expected_pages = render.get("pages") if isinstance(render.get("pages"), int) else None

    visual_evidence = None
    if visual == "passed":
        pages_reviewed = [page for page in visual_raw.get("pages_reviewed") or []
                          if isinstance(page, int)]
        visual_evidence = {
            "source": SOURCE,
            "kind": "legacy-visual-review",
            "report": visual_raw.get("report"),
            "pagesReviewed": pages_reviewed,
            "artifactSha256": visual_raw.get("artifact_sha256"),
        }

    return {
        "checks": {"structural": structural, "content": content, "visual": visual,
                   "assets": "missing" if missing else "complete"},
        "issues": issues,
        "missingAssets": missing,
        "requirements": requirements,
        "style": style,
        "expectedPages": expected_pages,
        "visualEvidence": visual_evidence,
        "summary": {
            "legacyStatus": report.get("status"),
            "legacyPassed": report.get("passed"),
            "visualReviewStatus": visual_raw.get("status"),
            "pagesReviewed": visual_raw.get("pages_reviewed") or [],
        },
    }
