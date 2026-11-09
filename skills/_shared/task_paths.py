from __future__ import annotations

import os
from pathlib import Path


TASK_ROOT_NAMES = {"inbox", "scratch", "exports"}


def pilotdeck_task_root() -> Path | None:
    configured = (
        os.environ.get("PILOTDECK_WORKSPACE_DIR", "").strip()
        or os.environ.get("PILOTDECK_WORKSPACE_CWD", "").strip()
    )
    if not configured:
        return None
    root = Path(os.path.abspath(Path(configured).expanduser()))
    if not root.is_dir():
        raise ValueError("PILOTDECK_WORKSPACE_DIR does not identify an existing task directory")
    return root


def resolve_task_resource(
    value: object,
    *,
    base_dir: Path,
    label: str = "resource",
) -> Path:
    raw = str(value or "").strip()
    if not raw:
        raise ValueError(f"{label} path is required")
    if raw.lower().startswith(("http://", "https://")):
        raise ValueError(f"{label}: remote resources are not allowed; use a local task file")

    raw_path = Path(raw).expanduser()
    candidate = Path(os.path.abspath(raw_path if raw_path.is_absolute() else base_dir / raw_path))
    task_root = pilotdeck_task_root()
    if task_root is None:
        return candidate

    try:
        lexical_relative = candidate.relative_to(task_root)
    except ValueError as exc:
        raise ValueError(f"{label} must resolve to a file inside the current task") from exc

    cursor = task_root
    for part in lexical_relative.parts:
        cursor /= part
        if cursor.is_symlink():
            raise ValueError(f"{label} cannot use a symbolic-link path")

    try:
        relative = Path(os.path.realpath(candidate)).relative_to(task_root)
    except ValueError as exc:
        raise ValueError(f"{label} must resolve to a file inside the current task") from exc

    if not relative.parts or relative.parts[0] not in TASK_ROOT_NAMES:
        raise ValueError(f"{label} must be under inbox, scratch, or exports")
    if not candidate.is_file():
        raise ValueError(f"{label} must be a regular file")
    return Path(os.path.realpath(candidate))
