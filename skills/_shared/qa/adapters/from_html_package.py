"""Map a ``html.sh package`` report onto the shared QA checks.

The package gate decides what actually reached the user's folder: a blocked
packaging run is a structural failure, missing images are an explicit delivery
gap. Layout and visual design stay unchecked because no browser is involved.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import clean_requirements, issue  # noqa: E402

SKILL = "html"
SOURCE = "html-package"


def _reference_issue(reference: dict) -> dict:
    value = reference.get("value")
    kind = str(reference.get("kind") or "reference")
    return issue(
        "error",
        "unportable-reference",
        f"页面引用了离线交付带不走的资源（{kind}）：{value}",
        SOURCE,
        value=value,
        referenceKind=kind,
        status=reference.get("status"),
    )


def map_report(report: dict, *, artifact_sha256: str) -> dict:
    status = str(report.get("status") or "")
    issues: list[dict] = []
    blocked = status == "blocked"
    packaged_sha = report.get("html_sha256")
    stale = isinstance(packaged_sha, str) and packaged_sha != artifact_sha256
    if stale:
        issues.append(issue(
            "error",
            "artifact-changed-since-package",
            "index.html changed after packaging; rerun html.sh package",
            SOURCE,
            recordedSha256=packaged_sha,
            actualSha256=artifact_sha256,
        ))
    if blocked:
        code = str(report.get("code") or "package-blocked")
        issues.append(issue(
            "error",
            f"package-blocked:{code}",
            str(report.get("message") or "HTML 打包被拒绝"),
            SOURCE,
            packageCode=code,
        ))
        for reference in report.get("references") or []:
            if isinstance(reference, dict):
                issues.append(_reference_issue(reference))

    missing_assets = [
        {
            "value": item.get("value"),
            "reason": str(item.get("reason") or "文件不存在"),
            "replaced": bool(item.get("replaced")),
        }
        for item in report.get("missing") or []
        if isinstance(item, dict)
    ]

    assets = [item for item in report.get("assets") or [] if isinstance(item, dict)]
    undecodable = [item for item in assets if item.get("decodable") is False]
    for item in undecodable:
        issues.append(issue(
            "error",
            "asset-undecodable",
            f"图片文件存在但无法解码：{item.get('source')}",
            SOURCE,
            target=item.get("target"),
        ))

    return {
        "checks": {
            "structural": "failed" if blocked or stale or undecodable else "passed",
            "content": "not_checked",
            "visual": "not_performed",
            "assets": "complete",
        },
        "issues": issues,
        "missingAssets": missing_assets,
        "requirements": clean_requirements({"text": [], "headings": [], "pages": {}}),
        "requirementsNote": (
            "打包报告只描述文件是否搬得走、图片是否齐全；不含用户要求，"
            "必含内容需由 `html.sh audit --require-text/--require-heading` 记录。"
        ),
        "style": {"theme": report.get("theme")},
        "expectedPages": None,
        "summary": {
            "packageStatus": status,
            "assets": len(assets),
            "missing": len(missing_assets),
            "zip": report.get("zip"),
            "output": report.get("output"),
            "visualAcceptance": "not_performed",
        },
    }
