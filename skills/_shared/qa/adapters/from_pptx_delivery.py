"""Map a PPTX ``delivery.json`` onto the shared QA checks.

``deliver`` keeps writing its own report; this adapter only reads it.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import clean_requirements, issue, issue_from_legacy, load_object  # noqa: E402

SKILL = "pptx"
SOURCE = "pptx-delivery"


def _requirement_text(spec: dict) -> dict:
    text: list[str] = []
    for requirement in spec.get("requirements") or []:
        if not isinstance(requirement, dict):
            continue
        groups = requirement.get("terms", requirement.get("expected"))
        label = requirement.get("label") or requirement.get("id")
        flat: list[str] = []
        for group in groups or []:
            if isinstance(group, str):
                flat.append(group)
            elif isinstance(group, list):
                flat.extend(str(alias) for alias in group if isinstance(alias, str))
        rendered = str(label) if label else " / ".join(flat)
        if rendered.strip():
            text.append(rendered.strip())
    pages = {}
    if isinstance(spec.get("slideCount"), int) and spec["slideCount"] > 0:
        pages = {"min": spec["slideCount"], "max": spec["slideCount"]}
    return {"text": text, "headings": [], "pages": pages}


def _derived_requirements(report: dict) -> dict:
    source = (report.get("requirements") or {}).get("source")
    if not isinstance(source, str) or source == "inline":
        return clean_requirements({})
    path = Path(source).expanduser()
    if not path.is_file():
        return clean_requirements({})
    try:
        spec = load_object(path, "PPTX requirements")
    except Exception:
        return clean_requirements({})
    return clean_requirements(_requirement_text(spec))


def map_report(report: dict, *, artifact_sha256: str) -> dict:
    artifact = report.get("artifact") if isinstance(report.get("artifact"), dict) else {}
    integrity = report.get("integrity") if isinstance(report.get("integrity"), dict) else {}
    gates = report.get("gates") if isinstance(report.get("gates"), dict) else {}
    audit = report.get("audit") if isinstance(report.get("audit"), dict) else {}
    counts = audit.get("counts") if isinstance(audit.get("counts"), dict) else {}
    coverage = audit.get("coverage") if isinstance(audit.get("coverage"), dict) else {}
    render = report.get("render") if isinstance(report.get("render"), dict) else {}
    render_status = str(render.get("status") or "")

    issues: list[dict] = []
    recorded_sha = artifact.get("sha256")
    stale = isinstance(recorded_sha, str) and recorded_sha != artifact_sha256
    if stale:
        issues.append(issue(
            "error",
            "artifact-changed-since-delivery",
            "The PPTX changed after delivery verification; the old audit and renders no longer apply",
            SOURCE,
            recordedSha256=recorded_sha,
            actualSha256=artifact_sha256,
        ))

    for item in integrity.get("errors") or []:
        issues.append(issue_from_legacy(item, SOURCE, "error"))
    gate_errors = [item for item in (gates.get("errors") or []) if isinstance(item, dict)]
    content_gate_errors = [item for item in gate_errors if item.get("code") == "coverage_required"]
    structural_gate_errors = [item for item in gate_errors if item.get("code") != "coverage_required"]
    for item in [*structural_gate_errors, *content_gate_errors]:
        issues.append(issue_from_legacy(item, SOURCE, "error"))
    for item in audit.get("errors") or []:
        issues.append(issue_from_legacy(item, SOURCE, "error"))
    for item in audit.get("warnings") or []:
        if isinstance(item, dict) and item.get("resolved"):
            continue
        issues.append(issue_from_legacy(item, SOURCE, "warning"))

    render_failed = render_status == "failed"
    if render_failed:
        issues.append(issue(
            "error",
            "render-failed",
            str(render.get("reason") or render.get("error") or "PPTX rendering failed"),
            SOURCE,
        ))
    elif render_status == "skipped":
        issues.append(issue(
            "warning",
            "visual-not-performed",
            str(render.get("warning") or render.get("reason") or "Rendering was not available"),
            SOURCE,
        ))

    structural_failed = (
        stale
        or integrity.get("status") == "failed"
        or bool(structural_gate_errors)
        or int(counts.get("errors") or 0) > 0
        or render_failed
    )
    if structural_failed:
        structural = "failed"
    elif audit.get("schemaVersion"):
        structural = "passed"
    else:
        structural = "not_checked"

    coverage_status = str(coverage.get("status") or "")
    if coverage_status == "failed" or content_gate_errors:
        content = "failed"
    elif coverage_status == "passed":
        content = "passed"
    else:
        content = "not_checked"

    slide_count = artifact.get("slideCount")
    return {
        "checks": {
            "structural": structural,
            "content": content,
            # delivery.json records renders, not a page-by-page human/model review.
            "visual": "not_performed",
            "assets": "complete",
        },
        "issues": issues,
        "missingAssets": [],
        "requirements": _derived_requirements(report),
        "style": {},
        "expectedPages": slide_count if isinstance(slide_count, int) else None,
        "summary": {
            "legacyStatus": report.get("status"),
            "auditStatus": audit.get("status"),
            "coverageStatus": coverage_status or None,
            "renderStatus": render_status or None,
            "slideCount": slide_count,
        },
    }
