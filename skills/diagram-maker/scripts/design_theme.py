"""Resolve a PilotDeck design theme into concrete SVG paint values.

`diagram-maker` keeps two independent axes:

* ``theme``          — ``clean`` / ``architecture``; shapes and node kinds only.
* ``design_theme``   — one of the six shared palettes; colours and fonts only.

Resolving a design theme never touches layout: node boxes, ranks and edge
routing are computed from the declarative input alone. Without ``--design-theme``
the renderer keeps the original hard-coded palette byte for byte.
"""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
from types import ModuleType
from typing import Any


class DesignThemeError(ValueError):
    """Raised when a design theme name is unknown or the tokens are unusable."""


def _skill_root() -> Path:
    # .../skills/diagram-maker/scripts/design_theme.py -> .../skills/diagram-maker
    return Path(__file__).resolve().parents[1]


def _roots() -> list[Path]:
    roots: list[Path] = []
    configured = os.environ.get("PILOTDECK_BUNDLED_SKILLS_DIR", "").strip()
    if configured:
        roots.append(Path(configured).expanduser().resolve())
    skills_dir = _skill_root().parent
    if skills_dir not in roots:
        roots.append(skills_dir)
    return roots


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


def resolve(name: str) -> dict[str, Any]:
    """Return ``{id, label, theme, source}`` for a theme name/id/alias."""
    for root in _roots():
        module = _reader(root)
        if module is None:
            continue
        try:
            return module.resolve_theme(
                name,
                bundled_skills_root=str(root),
                skill_root=str(_skill_root()),
            )
        except Exception as exc:  # noqa: BLE001 - re-raise with diagram context
            raise DesignThemeError(str(exc)) from exc
    raise DesignThemeError(
        "设计主题不可用：找不到 skills/_shared/design-tokens.json；"
        "请使用完整交付包，或在离线包内补齐 _shared 目录。"
    )


def _mix(hex_color: str, other: str, ratio: float) -> str:
    """Blend `hex_color` towards `other`; ratio 0 keeps `hex_color`."""
    a = [int(hex_color[index:index + 2], 16) for index in (0, 2, 4)]
    b = [int(other[index:index + 2], 16) for index in (0, 2, 4)]
    blended = [round(a[i] + (b[i] - a[i]) * ratio) for i in range(3)]
    return "#" + "".join(f"{value:02x}" for value in blended)


def _svg_font(stack: str) -> str:
    """Make a CSS font stack safe inside a double-quoted XML attribute."""
    return stack.replace('"', "'")


def palette(name: str) -> dict[str, Any]:
    """Concrete paint values for one design theme.

    Node fills are light tints of the theme's own roles so the dark `ink` text
    stays readable in greyscale printing as well as on screen.
    """
    selected = resolve(name)
    theme = selected["theme"]
    colors = theme["colors"]
    typography = theme.get("typography") or {}
    tokens = _tokens_for(selected)
    font_roles = tokens.get("fontRoles") or {}
    semantic = tokens.get("semantic") or {}

    body_role = typography.get("bodyRole") or "sans"
    heading_role = typography.get("headingRole") or body_role
    body_font = (font_roles.get(body_role) or {}).get("htmlStack") or "system-ui,sans-serif"
    heading_font = (font_roles.get(heading_role) or {}).get("htmlStack") or body_font

    paper = colors["paper"]
    soft = colors["soft"]
    accent = colors["accent"]
    support = colors["support"]
    danger_bg = (semantic.get("danger") or {}).get("bg") or soft

    return {
        "id": selected["id"],
        "label": theme["label"],
        "background": f"#{paper}",
        "title": f"#{colors['primary']}",
        "node_text": f"#{colors['ink']}",
        "node_stroke": f"#{colors['muted']}",
        "edge": f"#{colors['muted']}",
        "arrow": f"#{colors['muted']}",
        "group_stroke": f"#{colors['rule']}",
        "group_label": f"#{colors['muted']}",
        "edge_label": f"#{colors['muted']}",
        "halo": f"#{paper}",
        "body_font": _svg_font(body_font),
        "heading_font": _svg_font(heading_font),
        "fill": {
            "neutral": f"#{colors['surface']}",
            "input": _mix(soft, support, 0.22),
            "process": f"#{soft}",
            "decision": _mix(soft, accent, 0.18),
            "storage": _mix(soft, support, 0.3),
            "external": _mix(soft, accent, 0.08),
            "risk": f"#{danger_bg}",
        },
        "layout_variant": theme.get("layoutVariant"),
    }


def _tokens_for(selected: dict[str, Any]) -> dict[str, Any]:
    """Re-load the raw token document so fontRoles/semantic stay available."""
    for root in _roots():
        module = _reader(root)
        if module is None:
            continue
        try:
            return module.load_tokens(
                bundled_skills_root=str(root),
                skill_root=str(_skill_root()),
            )["tokens"]
        except Exception:  # noqa: BLE001 - fall through to defaults
            continue
    return {}


def available_names() -> list[str]:
    """Human readable list of the public themes, for error messages."""
    for root in _roots():
        module = _reader(root)
        if module is None:
            continue
        try:
            listed = module.list_themes(
                bundled_skills_root=str(root),
                skill_root=str(_skill_root()),
            )
        except Exception:  # noqa: BLE001 - ignore and fall through
            continue
        return [
            f"{item['label']} ({item['id']})"
            for item in listed["themes"]
            if item.get("status") != "hidden"
        ]
    return []
