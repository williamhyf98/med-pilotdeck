"""统一绘图样式 + 中文字体（技能自带模块，脚本里 `import analysis_plot` 即可）。

执行器已经把技能脚本目录放进 `sys.path`，所以分析脚本可以直接：

    import analysis_plot
    analysis_plot.apply()          # 注册随包中文字体 + 统一 rcParams
    import matplotlib.pyplot as plt

只做三件事：注册随包的 Noto Sans SC / Noto Serif SC（离线也一定有），挑一个
这台机器真的能用的中文字族，设几个影响可读性的 rcParams。后端由执行器通过
`MPLBACKEND=Agg` 指定，这里不碰。
"""

from __future__ import annotations

import os
from pathlib import Path

# 优先随包字体，其次系统中常见的中文字体
PREFERRED_FAMILIES = (
    "Noto Sans SC",
    "Source Han Sans SC",
    "Noto Sans CJK SC",
    "WenQuanYi Zen Hei",
    "Microsoft YaHei",
    "Hiragino Sans GB",
    "Songti SC",
    "Arial Unicode MS",
)

DEFAULT_DPI = 160


def _font_dirs() -> list[Path]:
    dirs: list[Path] = []
    for part in os.environ.get("PILOTDECK_ANALYSIS_FONTS", "").split(os.pathsep):
        if part:
            dirs.append(Path(part))
    skill = Path(__file__).resolve().parent.parent
    dirs.append(skill / "assets" / "fonts")
    dirs.append(skill.parent / "pdf" / "assets" / "fonts")
    return [directory for directory in dirs if directory.is_dir()]


def register_bundled_fonts() -> list[str]:
    """把随包字体注册进 matplotlib，返回新注册到的字族名。"""
    from matplotlib import font_manager

    known = {font.name for font in font_manager.fontManager.ttflist}
    for directory in _font_dirs():
        for path in sorted(directory.glob("*.tt[fc]")):
            try:
                font_manager.fontManager.addfont(str(path))
            except Exception:  # noqa: BLE001 - 坏字体不该让整次分析失败
                continue
    return sorted({font.name for font in font_manager.fontManager.ttflist} - known)


def pick_family() -> str:
    """挑第一个可用的中文字族；一个都没有就退回 DejaVu Sans（图里请用英文标签）。"""
    from matplotlib import font_manager

    installed = {font.name for font in font_manager.fontManager.ttflist}
    for family in PREFERRED_FAMILIES:
        if family in installed:
            return family
    return "DejaVu Sans"


def apply(dpi: int = DEFAULT_DPI, family: str | None = None) -> str:
    """设好样式，返回最终使用的字族名。"""
    from matplotlib import rcParams

    register_bundled_fonts()
    chosen = family or pick_family()
    rcParams["font.sans-serif"] = [chosen, "DejaVu Sans"]
    rcParams["font.serif"] = [chosen, "DejaVu Serif"]
    rcParams["axes.unicode_minus"] = False  # 负号别变成方框
    rcParams["savefig.dpi"] = dpi
    rcParams["figure.dpi"] = 100           # 屏幕预览
    rcParams["axes.grid"] = False
    rcParams["axes.spines.top"] = False
    rcParams["axes.spines.right"] = False
    rcParams["figure.autolayout"] = True
    return chosen
