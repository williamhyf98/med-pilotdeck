"""Shared helpers for mapping legacy per-skill reports into the QA protocol.

Adapters are read-only: they never rewrite a legacy report, never change what a
legacy command prints or writes, and never record a visual review that did not
happen. The unified report is an additional artefact (T3a.2).
"""

from __future__ import annotations

import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SHARED_QA_DIR = Path(__file__).resolve().parents[1]
if str(SHARED_QA_DIR) not in sys.path:
    sys.path.insert(0, str(SHARED_QA_DIR))

from qa_protocol import ACCEPTANCE_SCHEMA  # noqa: E402  (path set up above)

MAX_ISSUES = 60


class AdapterError(Exception):
    def __init__(self, message: str, code: str, details: dict | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.details = details or {}

    def as_dict(self) -> dict:
        return {"status": "error", "code": self.code, "error": str(self), "details": self.details}


def load_object(path: Path, label: str) -> dict:
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise AdapterError(f"{label} not found: {path}", "missing-report",
                           {"path": str(path)}) from exc
    except json.JSONDecodeError as exc:
        raise AdapterError(f"{label} is not valid JSON: {path}: {exc}", "invalid-report-json",
                           {"path": str(path)}) from exc
    except UnicodeDecodeError as exc:
        raise AdapterError(f"{label} is not a text JSON file: {path}", "invalid-report-json",
                           {"path": str(path)}) from exc
    if not isinstance(data, dict):
        raise AdapterError(f"{label} must be a JSON object", "invalid-report-shape",
                           {"path": str(path)})
    return data


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def as_issue_list(value: Any) -> list[dict]:
    """Legacy reports store either a plain list or a compacted {items, truncated} object."""
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)]
    if isinstance(value, dict) and isinstance(value.get("items"), list):
        return [item for item in value["items"] if isinstance(item, dict)]
    return []


def issue(severity: str, code: str, message: str, source: str, **extra: Any) -> dict:
    record: dict[str, Any] = {
        "severity": severity,
        "code": code,
        "message": message,
        "source": source,
    }
    for key, value in extra.items():
        if key in record or value is None:
            continue
        record[key] = value
    return record


def issue_from_legacy(item: dict, source: str, severity: str | None = None) -> dict:
    code = str(item.get("code") or item.get("type") or "unspecified")
    message = item.get("message")
    if not isinstance(message, str) or not message.strip():
        message = json.dumps(
            {key: value for key, value in item.items() if key not in {"code", "type", "message"}},
            ensure_ascii=False,
        )[:400]
    extras = {
        key: value
        for key, value in item.items()
        if key not in {"severity", "code", "type", "message", "source"}
    }
    return issue(severity or str(item.get("severity") or "warning"), code, message, source, **extras)


def compact_issues(items: list[dict]) -> list[dict]:
    if len(items) <= MAX_ISSUES:
        return items
    kept = items[:MAX_ISSUES]
    kept.append(issue(
        "warning",
        "issues-truncated",
        f"{len(items) - MAX_ISSUES} more issue(s) were omitted from this report; "
        "see the legacy report for the full list",
        "adapter",
        total=len(items),
    ))
    return kept


def derived_acceptance(
    skill: str,
    requirements: dict,
    *,
    source: str,
    style: dict | None = None,
    delivery: dict | None = None,
    now: str | None = None,
    note: str | None = None,
) -> dict:
    """Build an acceptance record from the requirements the legacy gate already used."""
    record: dict[str, Any] = {
        "schema": ACCEPTANCE_SCHEMA,
        "skill": skill,
        "createdAt": now or datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "derivedFrom": {
            "report": source,
            "note": note or (
                "Requirements were read back from the legacy report, not re-typed by hand."
            ),
        },
        "requirements": requirements,
    }
    if style:
        record["style"] = style
    if delivery:
        record["delivery"] = delivery
    return record


def write_json(path: Path, value: dict) -> Path:
    output = Path(path).expanduser()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return output


def clean_requirements(requirements: dict) -> dict:
    text = [item for item in requirements.get("text", []) if isinstance(item, str) and item.strip()]
    headings = []
    for item in requirements.get("headings", []):
        if not isinstance(item, dict) or not isinstance(item.get("text"), str):
            continue
        if not item["text"].strip():
            continue
        heading = {"text": item["text"].strip()}
        level = item.get("level")
        if isinstance(level, int) and not isinstance(level, bool) and 1 <= level <= 9:
            heading["level"] = level
        headings.append(heading)
    pages = {
        key: value
        for key, value in (requirements.get("pages") or {}).items()
        if key in {"min", "max"} and isinstance(value, int) and not isinstance(value, bool) and value >= 1
    }
    images = {
        key: value
        for key, value in (requirements.get("images") or {}).items()
        if key in {"min", "items"}
    }
    cleaned: dict[str, Any] = {"text": text, "headings": headings, "pages": pages}
    if images:
        cleaned["images"] = images
    return cleaned
