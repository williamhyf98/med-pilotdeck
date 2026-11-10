"""Map a ``html.sh audit`` report onto the shared QA checks.

HTML is never rendered on the server (T2c), so ``visual`` stays
``not_performed``. Structural findings are fact-class checks; requirement
coverage only exists when the caller passed ``--require-text`` /
``--require-heading`` to the audit.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import clean_requirements, issue_from_legacy  # noqa: E402

SKILL = "html"
SOURCE = "html-audit"
ASSET_CODES = {"missing-resource"}
REQUIREMENT_PREFIX = "requirement-not-met"


def _detail_value(item: dict) -> str | None:
    detail = item.get("detail")
    if isinstance(detail, dict):
        value = detail.get("value")
        if isinstance(value, str) and value:
            return value
    return None


def map_report(report: dict, *, artifact_sha256: str) -> dict:
    raw_issues = [item for item in report.get("issues") or [] if isinstance(item, dict)]

    issues: list[dict] = []
    missing_assets: list[dict] = []
    requirement_failures = 0
    audited_sha = report.get("sha256")
    stale = isinstance(audited_sha, str) and audited_sha != artifact_sha256
    if stale:
        issues.append(issue_from_legacy({
            "severity": "error",
            "code": "artifact-changed-since-audit",
            "message": "The page changed after it was audited; rerun html.sh audit",
            "recordedSha256": audited_sha,
            "actualSha256": artifact_sha256,
        }, SOURCE))
    for item in raw_issues:
        code = str(item.get("code") or "unspecified")
        if code in ASSET_CODES:
            # A missing image is a delivery gap, not a structural failure: the
            # page still opens and names the missing file.
            missing_assets.append({
                "value": _detail_value(item),
                "reason": str(item.get("message") or "资源缺失"),
            })
            continue
        if code.startswith(REQUIREMENT_PREFIX):
            requirement_failures += 1
        issues.append(issue_from_legacy(item, SOURCE))

    structural_errors = [
        item for item in issues
        if item["severity"] == "error" and not str(item["code"]).startswith(REQUIREMENT_PREFIX)
    ]
    structural = "failed" if structural_errors else "passed"

    requested = report.get("requirements") if isinstance(report.get("requirements"), dict) else {}
    checks_done = [item for item in requested.get("results") or [] if isinstance(item, dict)]
    if requirement_failures:
        content = "failed"
    elif checks_done:
        content = "passed"
    else:
        content = "not_checked"

    document = report.get("document") if isinstance(report.get("document"), dict) else {}
    requirements = clean_requirements({
        "text": [item for item in requested.get("text") or [] if isinstance(item, str)],
        "headings": [{"text": item} for item in requested.get("headings") or []
                     if isinstance(item, str)],
        "pages": {},
    })

    if checks_done:
        note = ("HTML 的必含内容与标题来自调用方显式给出的 --require-text / "
                "--require-heading；页面布局与视觉仍然没有被检查。")
    else:
        note = ("HTML 静态审计没有要求输入：acceptance 只记录调用方显式提出的要求，"
                "页面自身结构不回填为要求；视觉从未渲染，故为 not_performed。")
    return {
        "checks": {
            "structural": structural,
            "content": content,
            "visual": "not_performed",
            "assets": "complete",
        },
        "issues": issues,
        "missingAssets": missing_assets,
        "requirements": requirements,
        "requirementsNote": note,
        "style": {"theme": report.get("theme")},
        "expectedPages": None,
        "summary": {
            "auditStatus": report.get("status"),
            "bytes": report.get("bytes"),
            "title": document.get("title"),
            "headings": document.get("headings"),
            "images": document.get("images"),
            "issues": len(raw_issues),
            "requirementChecks": len(checks_done),
            "visualAcceptance": "not_performed",
        },
    }
