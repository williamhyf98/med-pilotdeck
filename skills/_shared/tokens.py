"""Read bundled design themes without loading document-generation dependencies."""

import json
import os
from pathlib import Path
import sys


_SHARED_ROOT = Path(__file__).resolve().parent
_FALLBACK = {
    "schemaVersion": 2,
    "defaultTheme": "clinical",
    "semantic": {
        "danger": {"fg": "B42318", "bg": "FDECEC", "onFg": "FFFFFF"},
        "warning": {"fg": "B45309", "bg": "FDF3E3", "onFg": "FFFFFF"},
        "success": {"fg": "157F3D", "bg": "E9F5EE", "onFg": "FFFFFF"},
        "info": {"fg": "1F5FA9", "bg": "EAF1FA", "onFg": "FFFFFF"},
    },
    "fontRoles": {
        "sans": {"officeWindows": "Microsoft YaHei", "officeMac": "PingFang SC",
                 "libreOffice": "Noto Sans CJK SC", "pdfFile": "NotoSansSC-VF.ttf",
                 "htmlStack": "system-ui,sans-serif", "htmlBundle": []},
        "serif": {"officeWindows": "SimSun", "officeMac": "Songti SC",
                  "libreOffice": "Noto Serif CJK SC", "pdfFile": "NotoSerifSC-Regular.ttf",
                  "htmlStack": "serif", "htmlBundle": []},
        "mono": {"officeWindows": "Consolas", "officeMac": "Menlo",
                 "libreOffice": "DejaVu Sans Mono", "pdfFile": None,
                 "htmlStack": "monospace", "htmlBundle": []},
    },
    "themes": {
        "clinical": {
            "label": "临床晨光", "aliases": ["临床"], "status": "stable",
            "colors": {
                "paper": "FFFFFF", "surface": "FFFFFF", "ink": "172033",
                "muted": "5F6B7A", "primary": "12404F", "accent": "B4552D",
                "support": "2F7183", "rule": "D8E0EA", "soft": "F3F4F6",
                "onPrimary": "FFFFFF", "onDark": "FFFFFF", "onDarkMuted": "D8E0EA",
            },
        },
    },
    "recommend": [],
}


def _candidates(bundled_skills_root=None, skill_root=None):
    roots = [
        bundled_skills_root or os.environ.get("PILOTDECK_BUNDLED_SKILLS_DIR"),
        _SHARED_ROOT.parent,
        Path(skill_root).resolve().parent if skill_root else None,
    ]
    seen = set()
    for root in roots:
        if root is None:
            continue
        file = Path(root).resolve() / "_shared" / "design-tokens.json"
        if file not in seen:
            seen.add(file)
            yield file


def _validate_usable(tokens, file):
    if not isinstance(tokens, dict) or tokens.get("schemaVersion") != 2:
        version = tokens.get("schemaVersion") if isinstance(tokens, dict) else None
        raise ValueError(f"Unsupported theme schemaVersion at {file}: {version}")
    if (not isinstance(tokens.get("semantic"), dict)
            or not isinstance(tokens.get("fontRoles"), dict)
            or not isinstance(tokens.get("recommend"), list)
            or not isinstance(tokens.get("themes"), dict)
            or tokens.get("defaultTheme") not in tokens["themes"]):
        raise ValueError(f"Incomplete theme data at {file}: required top-level data is missing")
    color_keys = ("paper", "surface", "ink", "muted", "primary", "accent", "support",
                  "rule", "soft", "onPrimary", "onDark", "onDarkMuted")
    for theme_id, theme in tokens["themes"].items():
        if (not isinstance(theme, dict)
                or not isinstance(theme.get("label"), str)
                or not isinstance(theme.get("aliases"), list)
                or not isinstance(theme.get("colors"), dict)
                or any(not isinstance(theme["colors"].get(key), str) for key in color_keys)):
            raise ValueError(f"Incomplete theme data at {file}: {theme_id} is missing required fields")


def load_tokens(*, bundled_skills_root=None, skill_root=None):
    for file in _candidates(bundled_skills_root, skill_root):
        try:
            raw = file.read_text(encoding="utf-8")
        except FileNotFoundError:
            continue
        try:
            tokens = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError(f"Invalid theme JSON at {file}: {exc}") from exc
        _validate_usable(tokens, file)
        return {"tokens": tokens, "source": str(file), "reason": None}
    return {
        "tokens": _FALLBACK,
        "source": "builtin-fallback",
        "reason": "design-tokens.json is missing from the configured skill roots",
    }


def _pick(tokens, name):
    name = name or tokens["defaultTheme"]
    matches = [
        (theme_id, theme) for theme_id, theme in tokens["themes"].items()
        if name in [theme_id, theme["label"], *theme.get("aliases", [])]
    ]
    if len(matches) != 1:
        available = ", ".join(
            f"{theme['label']} ({theme_id})" for theme_id, theme in tokens["themes"].items()
            if theme.get("status") != "hidden"
        )
        raise ValueError(f"Unknown or ambiguous design theme: {name}; available: {available}")
    theme_id, theme = matches[0]
    return {
        "id": theme_id,
        "theme": theme,
        "warning": "vital 现映射至 clinical，视觉效果将变化；旧版 PPTX 配色请使用 vital-legacy"
        if name == "vital" else None,
    }


def resolve_theme(name=None, **options):
    loaded = load_tokens(**options)
    return {**_pick(loaded["tokens"], name), "source": loaded["source"], "reason": loaded["reason"]}


def list_themes(**options):
    loaded = load_tokens(**options)
    return {
        "themes": [
            {"id": theme_id, "label": theme["label"], "aliases": theme["aliases"],
             "status": theme["status"], "default": theme_id == loaded["tokens"]["defaultTheme"]}
            for theme_id, theme in loaded["tokens"]["themes"].items()
            if theme["status"] != "hidden"
        ],
        "source": loaded["source"],
        "reason": loaded["reason"],
    }


def recommend_theme(features, **options):
    loaded = load_tokens(**options)
    tags = set(features if isinstance(features, list) else [features])
    rule = next(
        (rule for rule in loaded["tokens"]["recommend"] if any(tag in tags for tag in rule["match"])),
        None,
    )
    selected = _pick(loaded["tokens"], rule["theme"] if rule else None)
    return {**selected, "recommended": rule is not None,
            "source": loaded["source"], "reason": loaded["reason"]}


if __name__ == "__main__":
    args = sys.argv[1:]
    try:
        if args == ["--list"]:
            result = list_themes()
        elif len(args) == 2 and args[0] == "--theme":
            result = resolve_theme(args[1])
        elif len(args) == 2 and args[0] == "--recommend":
            result = recommend_theme(args[1].split(","))
        else:
            raise ValueError("Usage: tokens.py <--list|--theme NAME|--recommend tag,tag>")
        print(json.dumps(result, ensure_ascii=False))
    except ValueError as exc:
        print(exc, file=sys.stderr)
        sys.exit(2)
