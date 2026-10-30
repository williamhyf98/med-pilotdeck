#!/usr/bin/env python3
"""Internal ReportLab template. Agents must not copy or edit this file."""

from __future__ import annotations

import argparse
import os
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    KeepTogether,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


INK = colors.HexColor("#172033")
MUTED = colors.HexColor("#5F6B7A")
ACCENT = colors.HexColor("#2563EB")
PALE = colors.HexColor("#EEF4FF")
RULE = colors.HexColor("#D8E0EA")


def skill_root() -> Path:
    env = os.environ.get("PDF_SKILL_ROOT")
    if env:
        return Path(env)
    return Path(__file__).resolve().parents[1]


def register_document_font() -> str:
    fonts_dir = skill_root() / "assets" / "fonts"
    candidates = [
        fonts_dir / "NotoSansSC-VF.ttf",
        fonts_dir / "NotoSansSC-Regular.ttf",
        fonts_dir / "NotoSansSC-Regular.otf",
    ]
    last_error: Exception | None = None
    for path in candidates:
        if not path.is_file():
            continue
        try:
            pdfmetrics.registerFont(TTFont("PilotDeckCJK", str(path)))
            return "PilotDeckCJK"
        except Exception as exc:
            last_error = exc
    extra = f" ({last_error})" if last_error else ""
    raise SystemExit(f"bundled CJK font is missing under {fonts_dir}{extra}")


def header_footer(canvas, doc) -> None:
    canvas.saveState()
    canvas.setStrokeColor(RULE)
    canvas.setLineWidth(0.5)
    canvas.line(doc.leftMargin, 18 * mm, A4[0] - doc.rightMargin, 18 * mm)
    canvas.setFillColor(MUTED)
    canvas.setFont(doc.body_font, 8)
    canvas.drawString(doc.leftMargin, 11 * mm, "PilotDeck PDF starter")
    canvas.drawRightString(A4[0] - doc.rightMargin, 11 * mm, f"Page {doc.page}")
    canvas.restoreState()


def build_pdf(output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    font_name = register_document_font()
    doc = SimpleDocTemplate(
        str(output),
        pagesize=A4,
        rightMargin=20 * mm,
        leftMargin=20 * mm,
        topMargin=20 * mm,
        bottomMargin=25 * mm,
        title="PilotDeck PDF starter",
        author="PilotDeck",
    )
    doc.body_font = font_name

    base = getSampleStyleSheet()
    title = ParagraphStyle(
        "DocumentTitle",
        parent=base["Title"],
        fontName=font_name,
        fontSize=25,
        leading=31,
        textColor=INK,
        alignment=TA_LEFT,
        spaceAfter=7 * mm,
    )
    heading = ParagraphStyle(
        "SectionHeading",
        parent=base["Heading2"],
        fontName=font_name,
        fontSize=13,
        leading=18,
        textColor=INK,
        spaceBefore=4 * mm,
        spaceAfter=2.5 * mm,
    )
    body = ParagraphStyle(
        "Body",
        parent=base["BodyText"],
        fontName=font_name,
        fontSize=10,
        leading=15,
        textColor=INK,
        spaceAfter=3 * mm,
    )
    small = ParagraphStyle(
        "Small",
        parent=body,
        fontSize=8.5,
        leading=12,
        textColor=MUTED,
        spaceAfter=0,
    )

    story = [
        Paragraph("A clear PDF starts with a repeatable builder", title),
        Paragraph("已使用技能内捆绑中文字体，不要搜索系统字体。", body),
        Spacer(1, 3 * mm),
        KeepTogether(
            [
                Paragraph("Build contract", heading),
                Table(
                    [
                        [Paragraph("Stage", small), Paragraph("Required result", small)],
                        [Paragraph("Make", small), Paragraph("pdf.sh make with title/body/spec", small)],
                        [Paragraph("Audit", small), Paragraph("No structural hard failures", small)],
                        [Paragraph("Render", small), Paragraph("Every page inspected as PNG", small)],
                    ],
                    colWidths=[38 * mm, 112 * mm],
                    repeatRows=1,
                    style=TableStyle(
                        [
                            ("BACKGROUND", (0, 0), (-1, 0), PALE),
                            ("TEXTCOLOR", (0, 0), (-1, 0), ACCENT),
                            ("FONTNAME", (0, 0), (-1, -1), font_name),
                            ("VALIGN", (0, 0), (-1, -1), "TOP"),
                            ("GRID", (0, 0), (-1, -1), 0.5, RULE),
                            ("LEFTPADDING", (0, 0), (-1, -1), 7),
                            ("RIGHTPADDING", (0, 0), (-1, -1), 7),
                            ("TOPPADDING", (0, 0), (-1, -1), 7),
                            ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
                        ]
                    ),
                ),
            ]
        ),
    ]

    doc.build(story, onFirstPage=header_footer, onLaterPages=header_footer)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, type=Path, help="Output PDF path")
    args = parser.parse_args()
    build_pdf(args.out.expanduser().resolve())


if __name__ == "__main__":
    main()
