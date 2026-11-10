"""Map a ``diagram.sh audit`` report onto the shared QA checks.

Diagrams are deterministic SVG, so geometry (viewBox bounds, node overflow,
label truncation, report-width budget) can be checked without a browser.
Whether the drawing *looks* right still needs a human or an image model, so
``visual`` stays ``not_performed``.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import clean_requirements, issue, issue_from_legacy  # noqa: E402

SKILL = "diagram"
SOURCE = "diagram-audit"
TRUNCATION_CODE = "label-truncated"


def map_report(report: dict, *, artifact_sha256: str) -> dict:
    raw_issues = [item for item in report.get("issues") or [] if isinstance(item, dict)]
    issues = [issue_from_legacy(item, SOURCE) for item in raw_issues]
    audited_sha = report.get("sha256")
    stale = isinstance(audited_sha, str) and audited_sha != artifact_sha256
    if stale:
        issues.append(issue(
            "error",
            "artifact-changed-since-audit",
            "图示在审计之后被改动；请重新生成或重新审计",
            SOURCE,
            recordedSha256=audited_sha,
            actualSha256=artifact_sha256,
        ))

    content_block = report.get("content") if isinstance(report.get("content"), dict) else {}
    labels = [item for item in content_block.get("labels") or [] if isinstance(item, str)]
    truncated = [item for item in content_block.get("truncated") or [] if isinstance(item, dict)]
    if truncated and not any(item["code"] == TRUNCATION_CODE for item in issues):
        # Only reachable when a caller hands us a report without the issue list.
        issues.append(issue(
            "error",
            TRUNCATION_CODE,
            f"{len(truncated)} 个节点的文案超过三行上限，渲染时会丢字。",
            SOURCE,
            nodes=[item.get("node") for item in truncated],
        ))

    # A truncated label is a content defect, not a layout/security failure.
    structural_errors = [
        item for item in issues
        if item["severity"] == "error" and item["code"] != TRUNCATION_CODE
    ]
    structural = "failed" if structural_errors else "passed"

    if not labels:
        content = "not_checked"
    elif truncated or any(item["code"] == TRUNCATION_CODE for item in issues):
        content = "failed"
    else:
        content = "passed"

    geometry = report.get("geometry") if isinstance(report.get("geometry"), dict) else {}
    viewbox = report.get("viewBox") if isinstance(report.get("viewBox"), dict) else {}
    budget = report.get("budget") if isinstance(report.get("budget"), dict) else {}
    return {
        "checks": {
            "structural": structural,
            "content": content,
            "visual": "not_performed",
            "assets": "complete",
        },
        "issues": issues,
        "missingAssets": [],
        "requirements": clean_requirements({"text": [], "headings": [], "pages": {}}),
        "requirementsNote": (
            "图示几何审计只核对画布边界、节点溢出与文案截断；"
            "acceptance 不回填图示自身文案，避免把产物当成要求。"
        ),
        "style": {"theme": report.get("theme")},
        "expectedPages": None,
        "summary": {
            "auditStatus": report.get("status"),
            "nodes": (report.get("counts") or {}).get("nodes"),
            "texts": (report.get("counts") or {}).get("texts"),
            "labels": len(labels),
            "truncated": len(truncated),
            "viewBoxWidth": viewbox.get("width"),
            "viewBoxHeight": viewbox.get("height"),
            "maxRight": geometry.get("maxRight"),
            "maxBottom": geometry.get("maxBottom"),
            "widthBudget": budget.get("maxWidth"),
            "widthExceeded": budget.get("exceeded"),
            "visualAcceptance": "not_performed",
        },
    }
