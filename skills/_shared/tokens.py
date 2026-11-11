"""Read bundled design themes without loading document-generation dependencies."""

import json
import os
import re
from pathlib import Path
import sys


_SHARED_ROOT = Path(__file__).resolve().parent

# --- 自定义强调色（设计档 A）的对比度门禁 -------------------------------
# 调色板之外只允许"自定义强调色"：用户/模型给一个 hex，系统负责保证它看得清。
# 语义四色（success/warning/danger/info）永远取自 design-tokens.json，不参与自定义。
MIN_TEXT_CONTRAST = 4.5  # 正文文字 / 表格文字与其底色
MIN_UI_CONTRAST = 3.0    # 色条、实底、大字号、非文字图形
MIN_LINE_CONTRAST = 1.5  # 表格边框 / 分隔线（只要求"看得见"）

_HEX6 = re.compile(r"^#?([0-9A-Fa-f]{6})$")


def normalize_hex(value):
    """`#1F5FA9` / `1f5fa9` → `1F5FA9`；角色名、3 位缩写、非法值 → None。"""
    if not isinstance(value, str):
        return None
    match = _HEX6.match(value.strip())
    return match.group(1).upper() if match else None


def _channels(hex_value):
    return tuple(int(hex_value[index:index + 2], 16) for index in (0, 2, 4))


def _linear(channel):
    srgb = channel / 255
    return srgb / 12.92 if srgb <= 0.04045 else ((srgb + 0.055) / 1.055) ** 2.4


def relative_luminance(hex_value):
    red, green, blue = (_linear(value) for value in _channels(hex_value))
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue


def contrast_ratio(foreground, background):
    """WCAG 2.1 对比度（1.0–21.0）。两侧都必须是 6 位 hex。"""
    first = relative_luminance(normalize_hex(foreground) or foreground)
    second = relative_luminance(normalize_hex(background) or background)
    high, low = sorted((first, second), reverse=True)
    return (high + 0.05) / (low + 0.05)


def mix_hex(hex_value, toward="FFFFFF", weight=0.12):
    """把 `hex_value` 按 `weight` 的比例保留，其余换成 `toward`。

    与 pdf 现有的浅底算法（0.12）保持同一口径，避免四端出现色差。
    """
    front = _channels(normalize_hex(hex_value) or "000000")
    back = _channels(normalize_hex(toward) or "FFFFFF")
    return "".join(
        f"{round(value * weight + target * (1 - weight)):02X}"
        for value, target in zip(front, back)
    )


def on_color(background, dark="000000", light="FFFFFF"):
    """在该底色上，黑字和白字哪个更清楚就给哪个。"""
    background = normalize_hex(background) or background
    return (
        light
        if contrast_ratio(light, background) >= contrast_ratio(dark, background)
        else dark
    )


def suggest_contrast(value, background, minimum):
    """朝黑/白两个方向分档微调，返回第一个达标的颜色；找不到返回 None。"""
    color = normalize_hex(value) or value
    background = normalize_hex(background) or background
    for toward in ("FFFFFF", "000000"):
        for step in range(1, 21):
            candidate = mix_hex(color, toward=toward, weight=max(0.0, 1 - step * 0.05))
            if contrast_ratio(candidate, background) >= minimum:
                return candidate
    return None


def ensure_contrast(value, background, minimum, field="颜色"):
    """校验自定义色；返回规范化 hex，不达标抛 ValueError（并给出最近的可通过色）。"""
    color = normalize_hex(value)
    if color is None:
        raise ValueError(
            f"{field} 必须是 6 位 hex（如 #1F5FA9）或角色名，收到 {value!r}"
        )
    ground = normalize_hex(background)
    if ground is None:
        raise ValueError(f"{field} 缺少可比较的底色：{background!r}")
    ratio = contrast_ratio(color, ground)
    if ratio + 1e-9 >= minimum:
        return color
    hint = suggest_contrast(color, ground, minimum)
    suggestion = f"；可改用 #{hint}" if hint else ""
    raise ValueError(
        f"{field} #{color} 与底色 #{ground} 的对比度只有 {ratio:.2f}:1，"
        f"低于要求的 {minimum}:1{suggestion}"
    )


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
