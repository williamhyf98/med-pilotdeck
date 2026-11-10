#!/usr/bin/env python3
"""Versioned QA protocol shared by DOCX, PPTX, XLSX, PDF, HTML and diagrams.

The protocol is additive: existing per-skill reports stay valid. This module
only defines the frozen shapes, the status machine and the per-page matrix.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

PROTOCOL = "pilotdeck-qa/v1"
ACCEPTANCE_SCHEMA = "pilotdeck-qa-acceptance/v1"
REVIEW_SCHEMA = "pilotdeck-qa-review/v1"
REPORT_SCHEMA = "pilotdeck-qa-report/v1"

SKILLS = ("docx", "pptx", "xlsx", "pdf", "html", "diagram")
PAGE_STATUSES = ("passed", "failed", "not_performed")
CHECK_STATES = ("passed", "failed", "not_checked", "not_performed")
ASSET_STATES = ("complete", "missing", "not_applicable")
REPORT_STATUSES = ("passed", "passed_with_warnings", "failed", "delivered_with_missing_assets")


class QaError(Exception):
    def __init__(self, message: str, code: str, details: dict | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.details = details or {}

    def as_dict(self) -> dict:
        return {"status": "error", "code": self.code, "error": str(self), "details": self.details}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _load_object(path: Path, label: str) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise QaError(f"{label} not found: {path}", "missing-file", {"path": str(path)}) from exc
    except json.JSONDecodeError as exc:
        raise QaError(f"{label} is not valid JSON: {path}: {exc}", "invalid-json",
                      {"path": str(path)}) from exc
    if not isinstance(data, dict):
        raise QaError(f"{label} must be a JSON object", "invalid-shape", {"path": str(path)})
    return data


def load_acceptance(path: Path) -> dict:
    return validate_acceptance(_load_object(path, "Acceptance record"))


def validate_acceptance(data: dict) -> dict:
    if data.get("schema") != ACCEPTANCE_SCHEMA:
        raise QaError("Acceptance record has the wrong schema",
                      "invalid-acceptance-schema",
                      {"expected": ACCEPTANCE_SCHEMA, "actual": data.get("schema")})
    if data.get("skill") not in SKILLS:
        raise QaError("Acceptance record names an unknown skill",
                      "invalid-skill", {"skill": data.get("skill")})
    requirements = data.get("requirements")
    if not isinstance(requirements, dict):
        raise QaError("Acceptance record requires a requirements object",
                      "invalid-acceptance")
    text = requirements.get("text", [])
    if not isinstance(text, list) or any(not isinstance(item, str) or not item.strip() for item in text):
        raise QaError("requirements.text must be a list of non-empty strings", "invalid-acceptance")
    headings = requirements.get("headings", [])
    if not isinstance(headings, list) or any(
        not isinstance(item, dict) or not isinstance(item.get("text"), str)
        for item in headings
    ):
        raise QaError("requirements.headings must be objects with text", "invalid-acceptance")
    pages = requirements.get("pages", {})
    if not isinstance(pages, dict):
        raise QaError("requirements.pages must be an object", "invalid-acceptance")
    for key in ("min", "max"):
        value = pages.get(key)
        if value is not None and (not isinstance(value, int) or value < 1):
            raise QaError(f"requirements.pages.{key} must be a positive integer",
                          "invalid-acceptance")
    if pages.get("min") and pages.get("max") and pages["min"] > pages["max"]:
        raise QaError("requirements.pages.min cannot exceed max", "invalid-acceptance")
    return data


def load_review(path: Path) -> dict:
    return _load_object(path, "Review record")


def validate_review(
    data: dict,
    *,
    artifact_sha256: str | None = None,
    expected_pages: int | None = None,
) -> dict:
    if data.get("schema") != REVIEW_SCHEMA:
        raise QaError("Review record has the wrong schema",
                      "invalid-review-schema",
                      {"expected": REVIEW_SCHEMA, "actual": data.get("schema")})
    page_count = data.get("pageCount")
    if not isinstance(page_count, int) or page_count < 1:
        raise QaError("Review requires a positive pageCount", "invalid-review")
    if expected_pages is not None and page_count != expected_pages:
        raise QaError("Review pageCount does not match the rendered artifact",
                      "review-page-count-mismatch",
                      {"expected": expected_pages, "actual": page_count})
    if artifact_sha256 and data.get("artifactSha256") != artifact_sha256:
        raise QaError(
            "Review is bound to a different artifact hash; the file changed after review",
            "review-artifact-mismatch",
            {"expected": artifact_sha256, "actual": data.get("artifactSha256")},
        )
    pages = data.get("pages")
    if not isinstance(pages, list):
        raise QaError("Review requires a pages array", "invalid-review")
    seen: list[int] = []
    for item in pages:
        if not isinstance(item, dict):
            raise QaError("Every page entry must be an object", "invalid-review")
        number = item.get("page")
        if not isinstance(number, int) or number < 1 or number > page_count:
            raise QaError("Page numbers must be within pageCount", "invalid-review",
                          {"page": number, "pageCount": page_count})
        if number in seen:
            raise QaError("Page numbers must be unique", "review-duplicate-page", {"page": number})
        seen.append(number)
        if item.get("status") not in PAGE_STATUSES:
            raise QaError("Page status must be passed, failed or not_performed",
                          "invalid-review", {"page": number, "status": item.get("status")})
        if not isinstance(item.get("notes", ""), str):
            raise QaError("Page notes must be a string", "invalid-review", {"page": number})
    missing = [number for number in range(1, page_count + 1) if number not in seen]
    if missing:
        raise QaError(
            "Every rendered page must appear in the review matrix",
            "review-incomplete",
            {"missingPages": missing},
        )
    return data


def visual_state(review: dict | None) -> tuple[str, dict]:
    if review is None:
        return "not_performed", {"pages": 0, "passed": 0, "failed": 0, "not_performed": 0}
    counts = {"passed": 0, "failed": 0, "not_performed": 0}
    for item in review["pages"]:
        counts[item["status"]] += 1
    if counts["failed"]:
        state = "failed"
    elif counts["not_performed"]:
        state = "not_performed"
    else:
        state = "passed"
    return state, {"pages": review["pageCount"], **counts}


def derive_status(
    *,
    checks: dict,
    issues: list[dict],
    visual: str,
    assets: str,
) -> str:
    if checks.get("structural") == "failed" or visual == "failed":
        return "failed"
    if any(item.get("severity") == "error" for item in issues):
        return "failed"
    if assets == "missing":
        return "delivered_with_missing_assets"
    if visual != "passed" or checks.get("content") != "passed":
        return "passed_with_warnings"
    if any(item.get("severity") == "warning" for item in issues):
        return "passed_with_warnings"
    return "passed"


def build_report(
    *,
    skill: str,
    artifact_path: Path,
    acceptance_path: Path,
    review_path: Path | None = None,
    checks: dict | None = None,
    issues: list[dict] | None = None,
    missing_assets: list[dict] | None = None,
    timings_ms: dict | None = None,
    now: str | None = None,
    visual_evidence: dict | None = None,
) -> dict:
    if skill not in SKILLS:
        raise QaError("Unknown skill", "invalid-skill", {"skill": skill})
    artifact_path = artifact_path.expanduser().resolve()
    if not artifact_path.is_file():
        raise QaError("Artifact not found", "missing-artifact", {"path": str(artifact_path)})
    artifact_sha = sha256_file(artifact_path)

    acceptance = load_acceptance(acceptance_path)
    if acceptance["skill"] != skill:
        raise QaError("Acceptance record belongs to a different skill",
                      "skill-mismatch", {"acceptance": acceptance["skill"], "requested": skill})

    review = None
    if review_path is not None:
        review = load_review(review_path)
        validate_review(review, artifact_sha256=artifact_sha)
    review_visual, page_matrix = visual_state(review)

    normalized_checks = {
        "structural": "not_checked",
        "content": "not_checked",
        "visual": review_visual,
        "assets": "complete",
        **(checks or {}),
    }
    for key in ("structural", "content"):
        if normalized_checks[key] not in CHECK_STATES:
            raise QaError(f"checks.{key} has an invalid state",
                          "invalid-checks", {"key": key, "value": normalized_checks[key]})
    if normalized_checks["assets"] not in ASSET_STATES:
        raise QaError("checks.assets has an invalid state", "invalid-checks",
                      {"value": normalized_checks["assets"]})

    evidence = (
        validate_visual_evidence(visual_evidence, artifact_sha256=artifact_sha)
        if visual_evidence is not None
        else None
    )
    if review is not None and normalized_checks["visual"] != review_visual:
        raise QaError(
            "checks.visual conflicts with the supplied review matrix",
            "visual-state-conflict",
            {"review": review_visual, "checks": normalized_checks["visual"]},
        )
    if normalized_checks["visual"] == "passed" and review is None and evidence is None:
        raise QaError(
            "visual=passed requires a page matrix or legacy visual evidence",
            "visual-evidence-missing",
        )

    if issues is not None and not isinstance(issues, list):
        raise QaError("issues must be an array", "invalid-issues")
    if missing_assets is not None and not isinstance(missing_assets, list):
        raise QaError("missingAssets must be an array", "invalid-missing-assets")
    if timings_ms is not None and not isinstance(timings_ms, dict):
        raise QaError("timingsMs must be an object", "invalid-timings")
    issues = list(issues or [])
    missing = list(missing_assets or [])
    if missing:
        normalized_checks["assets"] = "missing"
    status = derive_status(
        checks=normalized_checks,
        issues=issues,
        visual=normalized_checks["visual"],
        assets=normalized_checks["assets"],
    )
    report = {
        "schema": REPORT_SCHEMA,
        "protocol": PROTOCOL,
        "skill": skill,
        "status": status,
        "artifact": {
            "path": str(artifact_path),
            "sha256": artifact_sha,
            "bytes": artifact_path.stat().st_size,
        },
        "acceptance": {
            "path": str(acceptance_path.expanduser().resolve()),
            "sha256": sha256_file(acceptance_path.expanduser().resolve()),
        },
        "review": None if review is None else {
            "path": str(review_path.expanduser().resolve()),
            "sha256": sha256_file(review_path.expanduser().resolve()),
            "pageMatrix": page_matrix,
        },
        "checks": normalized_checks,
        "issues": issues,
        "missingAssets": missing,
        "timingsMs": timings_ms or {},
        "generatedAt": now or datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    if evidence is not None:
        report["visualEvidence"] = evidence
    validate_report(report)
    return report


def validate_visual_evidence(evidence: dict, *, artifact_sha256: str | None = None) -> dict:
    """Evidence recorded by a skill's own review gate, carried over by an adapter.

    A legacy gate that already bound a per-page review to the artifact hash is
    real evidence; it just lives in another file. Requiring it explicitly keeps
    ``visual=passed`` from being asserted without any traceable record.
    """
    if not isinstance(evidence, dict):
        raise QaError("visualEvidence must be an object", "invalid-visual-evidence")
    pages = evidence.get("pagesReviewed")
    if not isinstance(pages, list) or not pages:
        raise QaError("visualEvidence.pagesReviewed must be a non-empty array",
                      "invalid-visual-evidence")
    if any(not isinstance(page, int) or isinstance(page, bool) or page < 1 for page in pages):
        raise QaError("visualEvidence.pagesReviewed must contain page numbers",
                      "invalid-visual-evidence")
    if len(set(pages)) != len(pages):
        raise QaError("visualEvidence.pagesReviewed contains duplicate pages",
                      "invalid-visual-evidence")
    recorded = evidence.get("artifactSha256")
    if recorded is not None and artifact_sha256 is not None and recorded != artifact_sha256:
        raise QaError(
            "visualEvidence belongs to a different artifact",
            "visual-evidence-artifact-mismatch",
            {"expected": artifact_sha256, "actual": recorded},
        )
    if not isinstance(evidence.get("source"), str) or not evidence["source"].strip():
        raise QaError("visualEvidence.source must name the producing report",
                      "invalid-visual-evidence")
    return evidence


def validate_report(report: dict) -> dict:
    if report.get("schema") != REPORT_SCHEMA:
        raise QaError("Report has the wrong schema", "invalid-report-schema",
                      {"expected": REPORT_SCHEMA, "actual": report.get("schema")})
    if report.get("protocol") != PROTOCOL:
        raise QaError("Report uses a different protocol version", "invalid-protocol",
                      {"expected": PROTOCOL, "actual": report.get("protocol")})
    if report.get("skill") not in SKILLS:
        raise QaError("Report names an unknown skill", "invalid-skill")
    if report.get("status") not in REPORT_STATUSES:
        raise QaError("Report has an unknown status", "invalid-report-status",
                      {"status": report.get("status")})
    artifact = report.get("artifact") or {}
    if not isinstance(artifact.get("sha256"), str) or len(artifact["sha256"]) != 64:
        raise QaError("Report artifact.sha256 is missing or malformed", "invalid-report")
    checks = report.get("checks") or {}
    for key in ("structural", "content"):
        if checks.get(key) not in CHECK_STATES:
            raise QaError(f"Report checks.{key} is invalid", "invalid-report", {"key": key})
    if checks.get("visual") not in PAGE_STATUSES:
        raise QaError("Report checks.visual is invalid", "invalid-report")
    if report["status"] == "passed" and checks.get("visual") != "passed":
        raise QaError("A passed report requires a completed visual review",
                      "report-status-conflict")
    if report["status"] == "passed" and checks.get("content") != "passed":
        raise QaError("A passed report requires content checks", "report-status-conflict")
    if report["status"] == "passed_with_warnings" and checks.get("visual") == "failed":
        raise QaError("Visual review failed; the report cannot be a warning-level pass",
                      "report-status-conflict")
    if report["status"] == "delivered_with_missing_assets" and checks.get("assets") != "missing":
        raise QaError("delivered_with_missing_assets requires missing assets",
                      "report-status-conflict")
    if report["status"] == "passed" and not report.get("review") and not report.get("visualEvidence"):
        raise QaError(
            "A passed report requires a review matrix or carried-over visual evidence",
            "report-evidence-missing",
        )
    return report


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="PilotDeck QA protocol (v1)")
    sub = parser.add_subparsers(dest="command", required=True)

    accept = sub.add_parser("validate-acceptance")
    accept.add_argument("path")

    review = sub.add_parser("validate-review")
    review.add_argument("path")
    review.add_argument("--artifact")
    review.add_argument("--pages", type=int)

    build = sub.add_parser("build")
    build.add_argument("--skill", required=True, choices=SKILLS)
    build.add_argument("--artifact", required=True)
    build.add_argument("--acceptance", required=True)
    build.add_argument("--review")
    build.add_argument("--checks", help="JSON file with structural/content/assets states")
    build.add_argument("--issues", help="JSON file with an issues array")
    build.add_argument("--missing-assets", help="JSON file with a missingAssets array")
    build.add_argument("--timings", help="JSON file with a timingsMs object")
    build.add_argument("--visual-evidence", help="JSON file with carried-over visual evidence")
    build.add_argument("--now")
    build.add_argument("--out")

    validate = sub.add_parser("validate-report")
    validate.add_argument("path")

    args = parser.parse_args(argv)
    try:
        if args.command == "validate-acceptance":
            data = load_acceptance(Path(args.path))
            print(json.dumps({"status": "ok", "schema": data["schema"], "skill": data["skill"]},
                             ensure_ascii=False))
            return 0
        if args.command == "validate-review":
            artifact_sha = sha256_file(Path(args.artifact)) if args.artifact else None
            data = validate_review(load_review(Path(args.path)),
                                   artifact_sha256=artifact_sha, expected_pages=args.pages)
            visual, matrix = visual_state(data)
            print(json.dumps({"status": "ok", "visual": visual, "matrix": matrix},
                             ensure_ascii=False))
            return 0
        if args.command == "build":
            def optional(path: str | None, default):
                return default if path is None else json.loads(Path(path).read_text(encoding="utf-8"))

            report = build_report(
                skill=args.skill,
                artifact_path=Path(args.artifact),
                acceptance_path=Path(args.acceptance),
                review_path=Path(args.review) if args.review else None,
                checks=optional(args.checks, None),
                issues=optional(args.issues, None),
                missing_assets=optional(args.missing_assets, None),
                timings_ms=optional(args.timings, None),
                now=args.now,
                visual_evidence=optional(args.visual_evidence, None),
            )
            text = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
            if args.out:
                Path(args.out).expanduser().write_text(text, encoding="utf-8")
                print(json.dumps({"status": report["status"], "out": args.out}, ensure_ascii=False))
            else:
                sys.stdout.write(text)
            return 0 if report["status"] in {"passed", "passed_with_warnings",
                                             "delivered_with_missing_assets"} else 1
        if args.command == "validate-report":
            report = validate_report(_load_object(Path(args.path), "QA report"))
            print(json.dumps({"status": "ok", "reportStatus": report["status"]},
                             ensure_ascii=False))
            return 0
    except QaError as exc:
        print(json.dumps(exc.as_dict(), ensure_ascii=False))
        return 1
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
