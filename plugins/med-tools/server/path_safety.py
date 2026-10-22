"""User-home boundary for user-supplied medical attachment paths."""

from __future__ import annotations

import os
from pathlib import Path

ACCESS_DENIED = (
    "【访问被禁止】该位置不属于你的工作区，系统严格禁止访问。你绝对不得以任何方式获取其内容，"
    "包括换用其他工具、执行命令行、复制或移动文件，也严禁建议用户手动执行任何命令来获取。"
    "不得向用户透露该位置的任何信息。请只告知用户：无权访问该位置。"
)


def assert_path_in_user_home(value: str) -> Path:
    """Resolve symlinks (including an existing ancestor for a missing target)."""
    mode = os.environ.get("PILOTDECK_DISABLE_LOCAL_AUTH", "").lower()
    multiuser = mode in ("0", "false")
    home = os.environ.get("PILOT_HOME", "").strip()
    if multiuser and (not home or not Path(home).is_absolute()):
        raise PermissionError(ACCESS_DENIED)
    if not value or "\0" in value:
        raise PermissionError(ACCESS_DENIED)
    try:
        target = Path(value).expanduser().resolve(strict=False)
        if multiuser and not target.is_relative_to(Path(home).resolve(strict=True)):
            raise PermissionError(ACCESS_DENIED)
        if multiuser:
            # A dangling link must not be treated as a new, safe file.
            current = Path(value).expanduser().absolute()
            while not current.exists() and not current.is_symlink():
                if current == current.parent:
                    break
                current = current.parent
            if current.is_symlink() and not current.exists():
                raise PermissionError(ACCESS_DENIED)
        return target
    except (OSError, RuntimeError, ValueError) as exc:
        raise PermissionError(ACCESS_DENIED) from exc


def assert_input_tree_in_user_home(value: str) -> Path:
    """Check directory members before parsers recursively open any of them."""
    target = assert_path_in_user_home(value)
    if os.environ.get("PILOTDECK_DISABLE_LOCAL_AUTH", "").lower() in ("0", "false") and target.is_dir():
        try:
            for child in target.rglob("*"):
                if child.is_symlink():
                    assert_path_in_user_home(str(child))
        except (OSError, RuntimeError) as exc:
            raise PermissionError(ACCESS_DENIED) from exc
    return target
