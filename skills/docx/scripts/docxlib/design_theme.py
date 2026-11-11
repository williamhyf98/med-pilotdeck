"""Resolve DOCX `themed-v1` colors from the shared design tokens."""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
from types import ModuleType
from typing import Any, Iterator

from .common import DocxSkillError


def _skill_root() -> Path:
    # .../skills/docx/scripts/docxlib/design_theme.py -> .../skills/docx
    return Path(__file__).resolve().parents[2]


def _roots() -> Iterator[Path]:
    configured = os.environ.get("PILOTDECK_BUNDLED_SKILLS_DIR", "").strip()
    if configured:
        yield Path(configured).expanduser().resolve()
    yield _skill_root().parent


def _reader(root: Path) -> ModuleType | None:
    file = root / "_shared" / "tokens.py"
    if not file.is_file():
        return None
    spec = importlib.util.spec_from_file_location("pilotdeck_shared_tokens", file)
    if spec is None or spec.loader is None:
        return None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_SHARED_MODULE: ModuleType | None = None
_SHARED_RESOLVED = False


def shared_tokens_module() -> ModuleType | None:
    """`skills/_shared/tokens.py`（配色/对比度工具），按需加载并缓存。"""
    global _SHARED_MODULE, _SHARED_RESOLVED
    if _SHARED_RESOLVED:
        return _SHARED_MODULE
    for root in _roots():
        module = _reader(root)
        if module is not None:
            _SHARED_MODULE = module
            break
    _SHARED_RESOLVED = True
    return _SHARED_MODULE


def resolve_design_theme(name: str) -> dict[str, Any]:
    """Return the theme id/label plus the DOCX style tokens it controls."""
    for root in _roots():
        module = _reader(root)
        if module is None:
            continue
        try:
            selected = module.resolve_theme(
                name,
                bundled_skills_root=str(root),
                skill_root=str(_skill_root()),
            )
        except Exception as exc:  # noqa: BLE001 - re-raise with DOCX context
            raise DocxSkillError(
                f"Unknown or unavailable design theme: {name}: {exc}",
                code="invalid-design-theme",
            ) from exc
        theme = selected["theme"]
        colors = theme["colors"]
        # `archive` asks for a serif body; every other theme is sans. Without
        # this the themed document always stayed on the sans default, so the
        # serif theme never actually reached the DOCX font slot.
        body_role = (theme.get("typography") or {}).get("bodyRole", "sans")
        style = {
            "title_color": colors["primary"],
            "heading_color": colors["primary"],
            "body_color": colors["ink"],
            "cjk_family": "serif" if body_role == "serif" else "sans",
            "table_style": "Table Grid",
            "table_header_fill": colors["primary"],
            "table_header_text_color": colors["onPrimary"],
            "table_border_color": colors["rule"],
            "callout_fill": colors["soft"],
            "callout_border_color": colors["accent"],
        }
        return {
            "id": selected["id"],
            "label": theme["label"],
            "style": style,
            # 完整颜色词，供块级"语义角色色"解析（protocol.palette_for_policy）。
            "colors": {key: str(value).upper() for key, value in colors.items()},
            "warning": selected.get("warning")
            or (
                "design-tokens.json 不在随包目录中，已回退到内置最小主题"
                if selected.get("source") == "builtin-fallback"
                else None
            ),
        }
    raise DocxSkillError(
        "Shared design tokens are unavailable; themed-v1 requires the bundled skills/_shared data",
        code="design-theme-unavailable",
    )
