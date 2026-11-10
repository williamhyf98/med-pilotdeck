"""Map a spreadsheets report (deliver / audit / make) onto the shared QA checks."""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import as_issue_list, clean_requirements, issue, issue_from_legacy  # noqa: E402

SKILL = "xlsx"
SOURCE = "xlsx-report"

CONTENT_FAILURE_TYPES = frozenset({"requirement_not_met"})


def _audit_block(report: dict) -> dict:
    audit = report.get("audit")
    if isinstance(audit, dict) and ("hardFailures" in audit or "coverage" in audit):
        return audit
    return report


def _failure_issue(failure: dict) -> dict:
    kind = str(failure.get("type") or "hard_failure")
    if kind == "requirement_not_met":
        requirement = failure.get("requirement") or {}
        location = "!".join(str(part) for part in (
            requirement.get("sheet"), requirement.get("range") or requirement.get("cell")
        ) if part)
        message = f"未满足验收要求：{requirement.get('type')}"
        if location:
            message = f"{message} ({location})"
        return issue("error", f"requirement-not-met:{requirement.get('type')}", message, SOURCE,
                     requirement=requirement)
    payload = {key: value for key, value in failure.items() if key != "type"}
    return issue("error", kind, json.dumps(payload, ensure_ascii=False)[:400], SOURCE)


def _derived_requirements(audit: dict) -> dict:
    checks = (audit.get("coverage") or {}).get("checks") or []
    text: list[str] = []
    for check in checks:
        if not isinstance(check, dict) or not check.get("type"):
            continue
        location = "!".join(str(part) for part in (
            check.get("sheet"), check.get("range") or check.get("cell")
        ) if part)
        text.append(f"{check['type']}: {location}" if location else str(check["type"]))
    return clean_requirements({"text": text})


def map_report(report: dict, *, artifact_sha256: str) -> dict:
    audit = _audit_block(report)
    coverage = audit.get("coverage") if isinstance(audit.get("coverage"), dict) else {}
    render = report.get("render") if isinstance(report.get("render"), dict) else {}
    warnings = as_issue_list(audit.get("warnings"))
    dispositions = audit.get("warningDispositions") if isinstance(audit.get("warningDispositions"), dict) else {}
    # A "passed" disposition status means every audit warning was explicitly
    # accepted with a rationale; those must not resurface as open issues.
    warnings_settled = dispositions.get("status") in {"passed", "not_needed"}

    issues: list[dict] = []
    recorded_sha = report.get("sha256")
    stale = isinstance(recorded_sha, str) and recorded_sha != artifact_sha256
    if stale:
        issues.append(issue(
            "error",
            "artifact-changed-since-report",
            "The workbook changed after the delivery report was written",
            SOURCE,
            recordedSha256=recorded_sha,
            actualSha256=artifact_sha256,
        ))

    hard = [item for item in audit.get("hardFailures") or [] if isinstance(item, dict)]
    content_failures = [item for item in hard if item.get("type") in CONTENT_FAILURE_TYPES]
    structural_failures = [item for item in hard if item.get("type") not in CONTENT_FAILURE_TYPES]
    for item in hard:
        issues.append(_failure_issue(item))
    if not warnings_settled:
        for item in warnings:
            issues.append(issue_from_legacy(item, SOURCE, "warning"))

    blank_pages = [page for page in (report.get("blankPages") or []) if isinstance(page, dict)]
    if blank_pages:
        issues.append(issue(
            "error",
            "blank-print-page",
            f"{len(blank_pages)} print page(s) rendered blank",
            SOURCE,
            pages=blank_pages[:10],
        ))

    render_warning = report.get("warning")
    if isinstance(render_warning, str) and render_warning.strip() and not render:
        issues.append(issue("warning", "visual-not-performed", render_warning.strip(), SOURCE))

    structural_failed = stale or bool(structural_failures) or bool(blank_pages)
    if structural_failed:
        structural = "failed"
    elif "hardFailures" in audit or audit.get("status") in {
            "ok", "warning", "error", "passed", "passed_with_warnings"}:
        structural = "passed"
    else:
        structural = "not_checked"

    coverage_status = str(coverage.get("status") or "")
    if coverage_status == "failed" or content_failures:
        content = "failed"
    elif coverage_status == "passed":
        content = "passed"
    else:
        content = "not_checked"

    pages = render.get("pages") if isinstance(render.get("pages"), list) else None
    expected_pages = len(pages) if pages else None

    return {
        "checks": {
            "structural": structural,
            "content": content,
            "visual": "not_performed",
            "assets": "complete",
        },
        "issues": issues,
        "missingAssets": [],
        "requirements": _derived_requirements(audit),
        "style": {},
        "expectedPages": expected_pages,
        "summary": {
            "legacyStatus": report.get("status"),
            "auditStatus": audit.get("status"),
            "coverageStatus": coverage_status or None,
            "renderedPages": expected_pages,
        },
    }
