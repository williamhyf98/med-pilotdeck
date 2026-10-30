"""User-scoped path helpers for the MinerU ingestion service."""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Mapping

from .path_safety import ACCESS_DENIED


INGEST_ROOT_ENV = "MED_RAG_MINERU_INGEST_ROOT"
DEFAULT_INGEST_ROOT = Path("med-tools") / "mineru-ingest"


def resolve_mineru_root(env: Mapping[str, str] | None = None) -> Path:
    """Resolve the configured ingest root inside the current user's home."""

    values = os.environ if env is None else env
    home = _user_home(values)
    configured = str(values.get(INGEST_ROOT_ENV, "")).strip()
    candidate = Path(configured) if configured else home / DEFAULT_INGEST_ROOT
    return _assert_contained(candidate, home, allow_missing=True)


def assert_mineru_source_path(
    value: str, env: Mapping[str, str] | None = None
) -> Path:
    """Validate an existing source file belonging to the current user."""

    home = _user_home(os.environ if env is None else env)
    path = _assert_contained(Path(value), home, allow_missing=False)
    if not path.is_file():
        raise PermissionError(ACCESS_DENIED)
    return path


def assert_mineru_output_path(
    value: str, env: Mapping[str, str] | None = None
) -> Path:
    """Validate an output path whose missing descendants may be created."""

    home = _user_home(os.environ if env is None else env)
    return _assert_contained(Path(value), home, allow_missing=True)


def to_mineru_user_relative_path(
    value: str | Path, env: Mapping[str, str] | None = None
) -> str:
    """Convert a validated user path to a portable path relative to PILOT_HOME."""

    values = os.environ if env is None else env
    home = _user_home(values)
    path = Path(value)
    try:
        relative = path.resolve(strict=False).relative_to(home)
    except (OSError, RuntimeError, ValueError):
        raise PermissionError(ACCESS_DENIED)
    return relative.as_posix() or "."


def sanitize_mineru_payload(
    payload: Any, env: Mapping[str, str] | None = None
) -> Any:
    """Redact absolute paths from data returned through the MCP boundary."""

    values = os.environ if env is None else env
    home = _try_user_home(values)
    roots = _sensitive_roots(payload, values, home)
    return _sanitize_value(payload, key=None, home=home, roots=roots)


def _user_home(values: Mapping[str, str]) -> Path:
    raw = str(values.get("PILOT_HOME", "")).strip()
    if not raw or "\0" in raw:
        raise PermissionError(ACCESS_DENIED)
    home = Path(raw)
    if not home.is_absolute() or ".." in home.parts:
        raise PermissionError(ACCESS_DENIED)
    try:
        resolved = home.resolve(strict=True)
    except (OSError, RuntimeError, ValueError):
        raise PermissionError(ACCESS_DENIED)
    if not resolved.is_dir():
        raise PermissionError(ACCESS_DENIED)
    return resolved


def _try_user_home(values: Mapping[str, str]) -> Path | None:
    try:
        return _user_home(values)
    except PermissionError:
        return None


def _sensitive_roots(
    payload: Any, values: Mapping[str, str], home: Path | None
) -> list[str]:
    roots: set[str] = set()
    raw_home = str(values.get("PILOT_HOME", "")).strip()
    if raw_home:
        roots.add(raw_home.rstrip("/"))
        try:
            roots.add(str(Path(raw_home).resolve()).rstrip("/"))
        except (OSError, RuntimeError, ValueError):
            pass
    if home is not None:
        roots.add(str(home).rstrip("/"))
    for key in (INGEST_ROOT_ENV, "MED_RAG_MINERU_MODEL_ROOT"):
        raw = str(values.get(key, "")).strip()
        if raw:
            roots.add(raw.rstrip("/"))
            try:
                roots.add(str(Path(raw).resolve()).rstrip("/"))
            except (OSError, RuntimeError, ValueError):
                pass
    _collect_absolute_paths(payload, roots)
    return sorted((root for root in roots if root), key=len, reverse=True)


def _collect_absolute_paths(value: Any, roots: set[str]) -> None:
    if isinstance(value, Mapping):
        for item in value.values():
            _collect_absolute_paths(item, roots)
    elif isinstance(value, list):
        for item in value:
            _collect_absolute_paths(item, roots)
    elif isinstance(value, str) and value.startswith("/"):
        roots.add(value.rstrip("/"))


def _sanitize_value(
    value: Any, *, key: str | None, home: Path | None, roots: list[str]
) -> Any:
    if isinstance(value, Mapping):
        return {
            item_key: _sanitize_value(item, key=str(item_key), home=home, roots=roots)
            for item_key, item in value.items()
        }
    if isinstance(value, list):
        return [_sanitize_value(item, key=key, home=home, roots=roots) for item in value]
    if not isinstance(value, str):
        return value
    if key in {"launcher", "model_root"}:
        return "<configured>" if value else value
    if key in {
        "output_root",
        "path",
        "pdf_path",
        "source_file",
        "source_path",
        "job_dir",
    } or (key and (key.endswith("_path") or key.endswith("_dir"))):
        return _sanitize_path(value, home=home)
    if key in {"error", "warning"}:
        return _redact_text(value, roots)
    return value


def _sanitize_path(value: str, *, home: Path | None) -> str:
    if not value.startswith("/"):
        return value
    if home is None:
        return "<redacted-path>"
    try:
        relative = Path(value).resolve(strict=False).relative_to(home)
    except (OSError, RuntimeError, ValueError):
        return "<redacted-path>"
    return relative.as_posix() or "."


def _redact_text(value: str, roots: list[str]) -> str:
    redacted = value
    for root in roots:
        redacted = redacted.replace(root, "<redacted-path>")
    return re.sub(r"(?<![\w])/(?:[^/\s]+/)*[^/\s]+", "<redacted-path>", redacted)


def _assert_contained(path: Path, home: Path, *, allow_missing: bool) -> Path:
    if not str(path) or "\0" in str(path):
        raise PermissionError(ACCESS_DENIED)
    if not path.is_absolute() or ".." in path.parts:
        raise PermissionError(ACCESS_DENIED)

    try:
        _check_existing_components(path, home)
        resolved = path.resolve(strict=not allow_missing)
        resolved.relative_to(home)
    except (OSError, RuntimeError, ValueError):
        raise PermissionError(ACCESS_DENIED)
    return resolved


def _check_existing_components(path: Path, home: Path) -> None:
    """Reject external and dangling links before the parser sees a path."""

    current = Path(path.anchor)
    for part in path.parts[1:]:
        current /= part
        if not current.is_symlink():
            continue
        try:
            current.relative_to(home)
        except ValueError:
            # System prefixes such as macOS /var may themselves be links.
            # Their resolved target is covered by the final containment check.
            continue
        try:
            target = current.resolve(strict=True)
            target.relative_to(home)
        except (OSError, RuntimeError, ValueError):
            raise PermissionError(ACCESS_DENIED)
