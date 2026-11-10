const W = 13.333;
const H = 7.5;

function addBackground(pptx, slide, color, name = 'Background', texture = null) {
  slide.background = { color };
  slide.addShape(pptx.ShapeType.rect, {
    objectName: name,
    x: 0,
    y: 0,
    w: W,
    h: H,
    line: { color, transparency: 100 },
    fill: { color },
  });
  // Optional paper grain drawn over the flat fill. Alpha lives in the PNG, so
  // the same asset works on light and dark pages without knowing the theme.
  if (texture?.path) {
    slide.addImage({
      objectName: 'Background Texture',
      path: texture.path,
      x: 0,
      y: 0,
      w: W,
      h: H,
      sizing: { type: 'cover', w: W, h: H },
    });
  }
}

function addFooter(slide, tokens, footer, page, inverse = false) {
  const color = inverse ? (tokens.colors.onDarkMuted ?? 'D7E2EA') : tokens.colors.muted;
  if (footer) {
    slide.addText(footer, {
      objectName: 'Footer',
      x: 0.72,
      y: 7.05,
      w: 10.6,
      h: 0.18,
      fontFace: tokens.typography.bodyFontFace,
      fontSize: tokens.typography.caption,
      color,
      margin: 0,
      breakLine: false,
    });
  }
  if (page !== undefined && page !== null) {
    slide.addText(String(page).padStart(2, '0'), {
      objectName: 'Page Number',
      x: 11.95,
      y: 7.02,
      w: 0.65,
      h: 0.2,
      align: 'right',
      fontFace: tokens.typography.bodyFontFace,
      fontSize: tokens.typography.caption,
      bold: true,
      color,
      margin: 0,
      breakLine: false,
    });
  }
}

/** Soft outer shadow shared by every card-like surface. */
const CARD_SHADOW = { type: 'outer', color: '1C2B33', blur: 12, offset: 2, angle: 90, opacity: 0.1 };

function surfaceOf(tokens) {
  return tokens.surface ?? {};
}

function cnNumber(value) {
  const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n <= 10 ? digits[n] : String(value ?? '');
}

/**
 * Page marker driven by `surface.sectionMarker`. Themes that ask for a plain
 * header get nothing; the rest draw a visibly different object.
 */
function addSectionMarker(pptx, slide, tokens, page, banded) {
  const mode = surfaceOf(tokens).sectionMarker ?? 'number-accent';
  if (mode === 'plain' || page === undefined || page === null || page === '') return;
  const label = String(page).padStart(2, '0');
  const accent = tokens.colors.accent;
  const primary = tokens.colors.primary ?? tokens.colors.navy;
  const top = banded ? 0.3 : 0.55;
  if (mode === 'number-sidebar') {
    slide.addShape(pptx.ShapeType.rect, {
      objectName: 'Section Sidebar', x: 12.52, y: 0, w: 0.81, h: banded ? 1.06 : 0.98,
      fill: { color: accent }, line: { color: accent, transparency: 100 },
    });
    slide.addText(label, {
      objectName: 'Section Number', x: 12.52, y: banded ? 0.32 : 0.28, w: 0.81, h: 0.42, align: 'center',
      fontFace: tokens.typography.bodyFontFace, fontSize: 17, bold: true,
      color: tokens.colors.onPrimary ?? 'FFFFFF', margin: 0, breakLine: false,
    });
    return;
  }
  if (mode === 'phase-chip') {
    slide.addShape(pptx.ShapeType.roundRect ?? pptx.ShapeType.rect, {
      objectName: 'Section Chip', x: 12.0, y: banded ? 0.33 : 0.62, w: 0.74, h: 0.4,
      fill: { color: accent }, line: { color: accent, transparency: 100 }, rectRadius: 0.08,
    });
    slide.addText(label, {
      objectName: 'Section Number', x: 12.0, y: banded ? 0.4 : 0.69, w: 0.74, h: 0.26, align: 'center',
      fontFace: tokens.typography.bodyFontFace, fontSize: 13, bold: true,
      color: tokens.colors.onPrimary ?? 'FFFFFF', margin: 0, breakLine: false,
    });
    return;
  }
  if (mode === 'cn-number') {
    slide.addText(cnNumber(page), {
      objectName: 'Section Number', x: 11.86, y: banded ? 0.26 : 0.56, w: 0.95, h: 0.52, align: 'right',
      fontFace: tokens.typography.headFontFace, fontSize: 26,
      color: tokens.colors.muted, margin: 0, breakLine: false,
    });
    return;
  }
  if (mode === 'dot') {
    slide.addShape(pptx.ShapeType.ellipse, {
      objectName: 'Section Dot', x: 12.28, y: banded ? 0.44 : 0.74, w: 0.16, h: 0.16,
      fill: { color: accent }, line: { color: accent, transparency: 100 },
    });
    return;
  }
  slide.addText(label, {
    objectName: 'Section Number', x: 11.85, y: top, w: 0.9, h: 0.4, align: 'right',
    fontFace: tokens.typography.bodyFontFace, fontSize: 26, bold: true,
    color: accent, margin: 0, breakLine: false,
  });
}

/**
 * Title block. Its shape comes from `surface.masthead`, so themes differ in
 * structure and not only in colour:
 *   rule-line  short accent rule under the title (clinical, trauma)
 *   rule-grid  doubled hairline across the top, no accent rule (mono)
 *   solid-band full-width colour band with an inverted title (academic)
 *   hairline   faint hairline above the title (archive)
 *   none       no decoration at all (edu)
 */
function addTitle(pptx, slide, tokens, title, kicker, page) {
  const masthead = surfaceOf(tokens).masthead ?? 'rule-line';
  const banded = masthead === 'solid-band';
  const primary = tokens.colors.primary ?? tokens.colors.navy;
  if (banded) {
    slide.addShape(pptx.ShapeType.rect, {
      objectName: 'Masthead Band', x: 0, y: 0, w: W, h: 1.06,
      fill: { color: primary }, line: { color: primary, transparency: 100 },
    });
  } else if (masthead === 'rule-grid') {
    // mono: a doubled hairline above the kicker reads as a spec-sheet header
    slide.addShape(pptx.ShapeType.line, {
      objectName: 'Masthead Rule 1', x: 0.72, y: 0.2, w: 11.85, h: 0,
      line: { color: tokens.colors.rule, width: 1 },
    });
    slide.addShape(pptx.ShapeType.line, {
      objectName: 'Masthead Rule 2', x: 0.72, y: 0.28, w: 11.85, h: 0,
      line: { color: tokens.colors.rule, width: 0.5 },
    });
  } else if (masthead === 'hairline') {
    slide.addShape(pptx.ShapeType.line, {
      objectName: 'Masthead Hairline', x: 0.72, y: 0.5, w: 11.85, h: 0,
      line: { color: tokens.colors.rule, width: 0.75 },
    });
  }
  if (kicker) {
    slide.addText(String(kicker).toUpperCase(), {
      objectName: 'Kicker',
      x: 0.72,
      y: banded ? 0.19 : 0.55,
      w: 4.4,
      h: 0.24,
      fontFace: tokens.typography.bodyFontFace,
      fontSize: 12,
      bold: true,
      charSpacing: 1.4,
      color: banded ? (tokens.colors.onDarkMuted ?? 'BFD2D6') : tokens.colors.accent,
      margin: 0,
      breakLine: false,
    });
  }
  const titleY = banded ? 0.5 : (kicker ? 0.88 : 0.64);
  slide.addText(title, {
    objectName: 'Slide Title',
    x: 0.72,
    y: titleY,
    w: 10.95,
    h: 0.55,
    fontFace: tokens.typography.headFontFace,
    fontSize: tokens.typography.slideTitle,
    bold: true,
    color: banded ? (tokens.colors.onPrimary ?? 'FFFFFF') : tokens.colors.ink,
    margin: 0,
    breakLine: false,
    fit: 'shrink',
  });
  if (!banded && (masthead === 'hairline' || masthead === 'rule-line')) {
    slide.addShape(pptx.ShapeType.line, {
      objectName: 'Title Rule', x: 0.74, y: titleY + 0.62, w: 1.15, h: 0,
      line: { color: tokens.colors.accent, width: 2.5 },
    });
  }
  addSectionMarker(pptx, slide, tokens, page, banded);
}

function mixColor(foreground, background, weight) {
  const parse = (hex) => [0, 2, 4].map((index) => parseInt(String(hex).slice(index, index + 2), 16));
  const [fr, fg, fb] = parse(foreground);
  const [br, bg, bb] = parse(background);
  const blend = (front, back) => Math.round(front * weight + back * (1 - weight));
  return [blend(fr, br), blend(fg, bg), blend(fb, bb)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

/**
 * Table body with zebra striping, a bold first column and a header style taken
 * from `surface.tableHeader`:
 *   primary-fill  solid brand header (clinical, academic, trauma)
 *   ink-fill      solid ink header (mono)
 *   soft-fill     light tinted header (edu)
 *   ink-rule      paper header closed by a heavy rule (archive)
 */
function styledTableRows(rows, tokens) {
  const mode = surfaceOf(tokens).tableHeader ?? 'primary-fill';
  const primary = tokens.colors.primary ?? tokens.colors.navy;
  const headerFill = {
    'primary-fill': primary,
    'ink-fill': tokens.colors.ink,
    'ink-rule': tokens.colors.white,
    'soft-fill': tokens.colors.soft ?? 'EEF2F6',
  }[mode] ?? primary;
  const headerInk = mode === 'ink-rule' || mode === 'soft-fill'
    ? tokens.colors.ink
    : (tokens.colors.onPrimary ?? 'FFFFFF');
  const head = (rows[0] ?? []).map((cell) => ({
    text: String(cell ?? ''),
    options: { fill: { color: headerFill }, color: headerInk, bold: true },
  }));
  const body = rows.slice(1).map((row, index) => row.map((cell, column) => ({
    text: String(cell ?? ''),
    options: {
      fill: { color: index % 2 === 1 ? (tokens.colors.soft ?? 'F3EAE3') : tokens.colors.white },
      color: tokens.colors.ink,
      bold: column === 0,
    },
  })));
  return [head, ...body];
}

function toRuns(items, tokens) {
  return items.flatMap((item, index) => [
    { text: item, options: { bullet: { indent: 18 }, hanging: 4, breakLine: index < items.length - 1 } },
  ]).map((run) => ({
    ...run,
    options: { ...run.options, fontFace: tokens.typography.bodyFontFace, fontSize: tokens.typography.body, color: tokens.colors.ink },
  }));
}

export function titleSlide(pptx, tokens, content = {}) {
  const slide = pptx.addSlide();
  const masthead = surfaceOf(tokens).masthead ?? 'rule-line';
  const primary = tokens.colors.primary ?? tokens.colors.navy;
  const accent = tokens.colors.accent;
  const title = content.title ?? 'A clear presentation title';
  const eyebrow = content.eyebrow ? String(content.eyebrow).toUpperCase() : '';

  // Four distinct cover structures, one per masthead family. The theme decides
  // which one you get, so two decks from different themes never open the same.
  if (masthead === 'solid-band') {
    // academic: paper page, heavy colour band carrying an inverted title
    addBackground(pptx, slide, tokens.colors.paper ?? 'F7F8FA', 'Background', tokens.texture);
    slide.addShape(pptx.ShapeType.rect, {
      objectName: 'Cover Band', x: 0, y: 0, w: W, h: 2.9,
      fill: { color: primary }, line: { color: primary, transparency: 100 },
    });
    slide.addShape(pptx.ShapeType.rect, {
      objectName: 'Title Accent', x: 0, y: 2.9, w: W, h: 0.07,
      fill: { color: accent }, line: { color: accent, transparency: 100 },
    });
    if (eyebrow) {
      slide.addText(eyebrow, {
        objectName: 'Eyebrow', x: 0.76, y: 0.62, w: 6.4, h: 0.28,
        fontFace: tokens.typography.bodyFontFace, fontSize: 12, bold: true,
        charSpacing: 1.6, color: tokens.colors.onDarkMuted ?? 'BFD2D6', margin: 0, breakLine: false,
      });
    }
    slide.addText(title, {
      objectName: 'Deck Title', x: 0.76, y: 1.02, w: 11.2, h: 1.5,
      fontFace: tokens.typography.headFontFace, fontSize: tokens.typography.deckTitle,
      bold: true, color: tokens.colors.onPrimary ?? 'FFFFFF', margin: 0, breakLine: false, fit: 'shrink',
    });
    if (content.subtitle) {
      slide.addText(content.subtitle, {
        objectName: 'Deck Subtitle', x: 0.78, y: 3.42, w: 9.6, h: 0.8,
        fontFace: tokens.typography.bodyFontFace, fontSize: tokens.typography.subheading,
        color: tokens.colors.ink, margin: 0, breakLine: false, fit: 'shrink',
      });
    }
    if (content.meta) {
      slide.addText(content.meta, {
        objectName: 'Deck Meta', x: 0.78, y: 6.44, w: 8.4, h: 0.26,
        fontFace: tokens.typography.bodyFontFace, fontSize: 12,
        color: tokens.colors.muted, margin: 0, breakLine: false,
      });
    }
    return slide;
  }

  if (masthead === 'hairline') {
    // archive: framed paper page, serif title, seal-like accent block
    addBackground(pptx, slide, tokens.colors.paper ?? 'FAF6EC', 'Background', tokens.texture);
    slide.addShape(pptx.ShapeType.rect, {
      objectName: 'Cover Frame', x: 0.52, y: 0.46, w: 12.29, h: 6.58,
      fill: { type: 'none' }, line: { color: tokens.colors.rule, width: 1 },
    });
    slide.addShape(pptx.ShapeType.rect, {
      objectName: 'Title Accent', x: 1.02, y: 1.72, w: 0.42, h: 0.42,
      fill: { color: accent }, line: { color: accent, transparency: 100 },
    });
    if (eyebrow) {
      slide.addText(eyebrow, {
        objectName: 'Eyebrow', x: 1.62, y: 1.78, w: 6.2, h: 0.3,
        fontFace: tokens.typography.bodyFontFace, fontSize: 12, bold: true,
        charSpacing: 1.6, color: tokens.colors.muted, margin: 0, breakLine: false,
      });
    }
    slide.addText(title, {
      objectName: 'Deck Title', x: 1.02, y: 2.42, w: 10.6, h: 1.7,
      fontFace: tokens.typography.headFontFace, fontSize: tokens.typography.deckTitle,
      bold: true, color: tokens.colors.ink, margin: 0, breakLine: false, fit: 'shrink',
    });
    slide.addShape(pptx.ShapeType.line, {
      objectName: 'Cover Rule', x: 1.04, y: 4.34, w: 2.4, h: 0,
      line: { color: tokens.colors.rule, width: 1 },
    });
    if (content.subtitle) {
      slide.addText(content.subtitle, {
        objectName: 'Deck Subtitle', x: 1.04, y: 4.58, w: 9.4, h: 0.8,
        fontFace: tokens.typography.bodyFontFace, fontSize: tokens.typography.subheading,
        color: tokens.colors.muted, margin: 0, breakLine: false, fit: 'shrink',
      });
    }
    if (content.meta) {
      slide.addText(content.meta, {
        objectName: 'Deck Meta', x: 1.04, y: 6.34, w: 8.4, h: 0.26,
        fontFace: tokens.typography.bodyFontFace, fontSize: 12,
        color: tokens.colors.muted, margin: 0, breakLine: false,
      });
    }
    return slide;
  }

  if (masthead === 'none') {
    // edu: soft page, one large rounded card holding the title
    addBackground(pptx, slide, tokens.colors.soft ?? 'F1F3E7', 'Background', tokens.texture);
    slide.addShape(pptx.ShapeType.roundRect ?? pptx.ShapeType.rect, {
      objectName: 'Cover Card', x: 0.94, y: 1.18, w: 11.46, h: 5.0,
      fill: { color: tokens.colors.white }, line: { color: tokens.colors.white, transparency: 100 },
      rectRadius: 0.26, shadow: CARD_SHADOW,
    });
    slide.addShape(pptx.ShapeType.ellipse, {
      objectName: 'Title Accent', x: 1.42, y: 1.76, w: 0.24, h: 0.24,
      fill: { color: accent }, line: { color: accent, transparency: 100 },
    });
    if (eyebrow) {
      slide.addText(eyebrow, {
        objectName: 'Eyebrow', x: 1.82, y: 1.72, w: 6.2, h: 0.3,
        fontFace: tokens.typography.bodyFontFace, fontSize: 12, bold: true,
        charSpacing: 1.4, color: tokens.colors.muted, margin: 0, breakLine: false,
      });
    }
    slide.addText(title, {
      objectName: 'Deck Title', x: 1.42, y: 2.34, w: 10.2, h: 1.5,
      fontFace: tokens.typography.headFontFace, fontSize: tokens.typography.deckTitle,
      bold: true, color: tokens.colors.ink, margin: 0, breakLine: false, fit: 'shrink',
    });
    if (content.subtitle) {
      slide.addText(content.subtitle, {
        objectName: 'Deck Subtitle', x: 1.44, y: 4.02, w: 9.9, h: 0.8,
        fontFace: tokens.typography.bodyFontFace, fontSize: tokens.typography.subheading,
        color: tokens.colors.muted, margin: 0, breakLine: false, fit: 'shrink',
      });
    }
    if (content.meta) {
      slide.addText(content.meta, {
        objectName: 'Deck Meta', x: 1.44, y: 6.5, w: 8.4, h: 0.26,
        fontFace: tokens.typography.bodyFontFace, fontSize: 12,
        color: tokens.colors.muted, margin: 0, breakLine: false,
      });
    }
    return slide;
  }

  // rule-line family (clinical / trauma / mono): full-bleed colour field
  addBackground(pptx, slide, tokens.colors.navy, 'Background', tokens.texture);
  const marker = surfaceOf(tokens).sectionMarker;
  if (marker === 'phase-chip') {
    // trauma: a hard edge bar reads as "emergency", unlike the calm clinical cover
    slide.addShape(pptx.ShapeType.rect, {
      objectName: 'Cover Edge Bar', x: 0, y: 0, w: 0.22, h: H,
      fill: { color: accent }, line: { color: accent, transparency: 100 },
    });
  }
  if (masthead === 'rule-grid') {
    // mono: a full-width ticked ruler instead of the single accent dash, so the
    // technical theme never opens with the same geometry as clinical
    const ruler = tokens.colors.onDarkMuted ?? 'C2C8CD';
    slide.addShape(pptx.ShapeType.line, {
      objectName: 'Cover Ruler', x: 0.74, y: 1.32, w: W - 1.48, h: 0,
      line: { color: ruler, width: 0.75 },
    });
    [0.74, 3.62, 6.5, 9.38, 12.27].forEach((tickX, index) => {
      slide.addShape(pptx.ShapeType.line, {
        objectName: `Cover Tick ${index + 1}`, x: tickX, y: 1.32, w: 0, h: 0.15,
        line: { color: ruler, width: 0.75 },
      });
    });
  } else {
    slide.addShape(pptx.ShapeType.line, {
      objectName: 'Title Accent',
      x: 0.74,
      y: 1.32,
      w: 1.25,
      h: 0,
      line: { color: tokens.colors.accent, width: 4 },
    });
  }
  if (eyebrow) {
    slide.addText(eyebrow, {
      objectName: 'Eyebrow', x: 0.74, y: 0.72, w: 4.8, h: 0.25,
      fontFace: tokens.typography.bodyFontFace, fontSize: 12, bold: true,
      charSpacing: 1.5, color: tokens.colors.onDarkMuted ?? 'C7D8E5', margin: 0, breakLine: false,
    });
  }
  slide.addText(title, {
    objectName: 'Deck Title', x: 0.74, y: 1.62, w: 10.8, h: 1.35,
    fontFace: tokens.typography.headFontFace, fontSize: tokens.typography.deckTitle,
    bold: true, color: tokens.colors.white, margin: 0, breakLine: false, fit: 'shrink',
  });
  if (content.subtitle) {
    slide.addText(content.subtitle, {
      objectName: 'Deck Subtitle', x: 0.76, y: 3.28, w: 8.8, h: 0.78,
      fontFace: tokens.typography.bodyFontFace, fontSize: tokens.typography.subheading,
      color: tokens.colors.onDark ?? 'D7E2EA', margin: 0, breakLine: false, fit: 'shrink',
    });
  }
  if (content.meta) {
    slide.addText(content.meta, {
      objectName: 'Deck Meta', x: 0.76, y: 6.48, w: 7.6, h: 0.24,
      fontFace: tokens.typography.bodyFontFace, fontSize: 12,
      color: tokens.colors.onDarkMuted ?? 'A9BECC', margin: 0, breakLine: false,
    });
  }
  return slide;
}

export function sectionSlide(pptx, tokens, content = {}) {
  const slide = pptx.addSlide();
  addBackground(pptx, slide, tokens.colors.paper, 'Background', tokens.texture);
  slide.addText(String(content.number ?? '01').padStart(2, '0'), {
    objectName: 'Section Number', x: 0.72, y: 0.72, w: 1.1, h: 0.65,
    fontFace: tokens.typography.headFontFace, fontSize: 42, bold: true,
    color: tokens.colors.accent, margin: 0, breakLine: false,
  });
  slide.addShape(pptx.ShapeType.line, {
    objectName: 'Section Rule', x: 0.76, y: 1.55, w: 11.82, h: 0,
    line: { color: tokens.colors.rule, width: 1.3 },
  });
  slide.addText(content.title ?? 'Section title', {
    objectName: 'Section Title', x: 2.12, y: 2.25, w: 9.6, h: 0.9,
    fontFace: tokens.typography.headFontFace, fontSize: 44, bold: true,
    color: tokens.colors.ink, margin: 0, breakLine: false, fit: 'shrink',
  });
  if (content.subtitle) {
    slide.addText(content.subtitle, {
      objectName: 'Section Subtitle', x: 2.14, y: 3.42, w: 8.5, h: 0.65,
      fontFace: tokens.typography.bodyFontFace, fontSize: 21,
      color: tokens.colors.muted, margin: 0, breakLine: false, fit: 'shrink',
    });
  }
  addFooter(slide, tokens, content.footer, content.page);
  return slide;
}

export function statementSlide(pptx, tokens, content = {}) {
  const slide = pptx.addSlide();
  addBackground(pptx, slide, tokens.colors.white, 'Background', tokens.texture);
  slide.addShape(pptx.ShapeType.line, {
    objectName: 'Statement Accent', x: 0.74, y: 1.0, w: 0, h: 4.9,
    line: { color: tokens.colors.accent, width: 5 },
  });
  if (content.kicker) {
    slide.addText(content.kicker.toUpperCase(), {
      objectName: 'Statement Kicker', x: 1.18, y: 0.98, w: 4.5, h: 0.25,
      fontFace: tokens.typography.bodyFontFace, fontSize: 12, bold: true,
      charSpacing: 1.3, color: tokens.colors.accent, margin: 0, breakLine: false,
    });
  }
  slide.addText(content.statement ?? 'One memorable conclusion belongs here.', {
    objectName: 'Statement', x: 1.16, y: 1.55, w: 10.45, h: 2.35,
    fontFace: tokens.typography.headFontFace, fontSize: tokens.typography.statement,
    bold: true, color: tokens.colors.ink, margin: 0, valign: 'mid', fit: 'shrink',
  });
  if (content.support) {
    slide.addText(content.support, {
      objectName: 'Statement Support', x: 1.2, y: 4.5, w: 8.8, h: 0.75,
      fontFace: tokens.typography.bodyFontFace, fontSize: 20,
      color: tokens.colors.muted, margin: 0, fit: 'shrink',
    });
  }
  addFooter(slide, tokens, content.footer, content.page);
  return slide;
}

export function contentSlide(pptx, tokens, content = {}) {
  const slide = pptx.addSlide();
  addBackground(pptx, slide, tokens.colors.white, 'Background', tokens.texture);
  addTitle(pptx, slide, tokens, content.title ?? 'Slide title', content.kicker, content.page);
  const items = (content.items ?? []).map((item) => String(item).trim()).filter(Boolean);
  if (items.length) {
    slide.addText(toRuns(items.slice(0, 8), tokens), {
      objectName: 'Content Points',
      x: 0.92,
      y: 1.62,
      w: 11.25,
      h: 4.92,
      fontFace: tokens.typography.bodyFontFace,
      fontSize: tokens.typography.body,
      color: tokens.colors.ink,
      margin: 0.05,
      paraSpaceAfterPt: 15,
      breakLine: false,
      fit: 'shrink',
    });
  } else {
    slide.addText(content.body ?? '', {
      objectName: 'Content Body',
      x: 0.92,
      y: 1.72,
      w: 11.1,
      h: 4.65,
      fontFace: tokens.typography.bodyFontFace,
      fontSize: tokens.typography.body,
      color: tokens.colors.ink,
      margin: 0,
      breakLine: false,
      valign: 'top',
      fit: 'shrink',
    });
  }
  addFooter(slide, tokens, content.footer, content.page);
  return slide;
}

export function splitSlide(pptx, tokens, content = {}) {
  const slide = pptx.addSlide();
  addBackground(pptx, slide, tokens.colors.paper, 'Background', tokens.texture);
  addTitle(pptx, slide, tokens, content.title ?? 'One argument, one visual', content.kicker, content.page);
  slide.addText(content.body ?? '', {
    objectName: 'Split Body', x: 0.74, y: 1.75, w: 4.65, h: 4.55,
    fontFace: tokens.typography.bodyFontFace, fontSize: tokens.typography.body,
    color: tokens.colors.ink, margin: 0, breakLine: false, valign: 'mid', fit: 'shrink',
  });
  if (content.image) {
    slide.addImage({ objectName: 'Split Image', x: 5.82, y: 1.62, w: 6.76, h: 4.8, ...content.image });
  } else {
    slide.addShape(pptx.ShapeType.rect, {
      objectName: 'Media Placeholder', x: 5.82, y: 1.62, w: 6.76, h: 4.8,
      fill: { color: tokens.colors.soft ?? 'E5EAF0' }, line: { color: tokens.colors.rule ?? 'CAD2DC', dash: 'dash' },
    });
  }
  addFooter(slide, tokens, content.footer, content.page);
  return slide;
}

export function twoColumnSlide(pptx, tokens, content = {}) {
  const slide = pptx.addSlide();
  addBackground(pptx, slide, tokens.colors.white, 'Background', tokens.texture);
  addTitle(pptx, slide, tokens, content.title ?? 'Two dimensions', content.kicker, content.page);
  slide.addShape(pptx.ShapeType.line, {
    objectName: 'Column Divider', x: 6.66, y: 1.72, w: 0, h: 4.65,
    line: { color: tokens.colors.rule, width: 1.2 },
  });
  for (const [side, x] of [['left', 0.74], ['right', 7.02]]) {
    const column = content[side] ?? {};
    slide.addText(column.heading ?? '', {
      objectName: `${side} heading`, x, y: 1.75, w: 5.55, h: 0.38,
      fontFace: tokens.typography.headFontFace, fontSize: 24, bold: true,
      color: side === 'left' ? tokens.colors.navy : tokens.colors.accent,
      margin: 0, breakLine: false, fit: 'shrink',
    });
    slide.addText(toRuns(column.items ?? [], tokens), {
      objectName: `${side} body`, x, y: 2.42, w: 5.35, h: 3.72,
      fontFace: tokens.typography.bodyFontFace, fontSize: tokens.typography.body,
      color: tokens.colors.ink, margin: 0.04, paraSpaceAfterPt: 14, breakLine: false, fit: 'shrink',
    });
  }
  addFooter(slide, tokens, content.footer, content.page);
  return slide;
}

export function metricSlide(pptx, tokens, content = {}) {
  const slide = pptx.addSlide();
  addBackground(pptx, slide, tokens.colors.paper, 'Background', tokens.texture);
  addTitle(pptx, slide, tokens, content.title ?? 'The numbers that matter', content.kicker, content.page);
  const metrics = (content.metrics ?? []).slice(0, 4);
  const count = Math.max(1, metrics.length);
  const available = 11.84;
  const width = available / count;
  metrics.forEach((metric, index) => {
    const x = 0.74 + index * width;
    if (index > 0) {
      slide.addShape(pptx.ShapeType.line, {
        objectName: `Metric Divider ${index}`, x, y: 2.06, w: 0, h: 3.2,
        line: { color: tokens.colors.rule, width: 1 },
      });
    }
    slide.addText(metric.value, {
      objectName: `Metric ${index + 1} Value`, x: x + 0.22, y: 2.22, w: width - 0.44, h: 0.85,
      fontFace: tokens.typography.headFontFace, fontSize: tokens.typography.metric,
      bold: true, color: index === 0 ? tokens.colors.accent : tokens.colors.navy,
      margin: 0, align: 'center', breakLine: false, fit: 'shrink',
    });
    slide.addText(metric.label, {
      objectName: `Metric ${index + 1} Label`, x: x + 0.22, y: 3.28, w: width - 0.44, h: 0.72,
      fontFace: tokens.typography.bodyFontFace, fontSize: 19, bold: true,
      color: tokens.colors.ink, margin: 0, align: 'center', fit: 'shrink',
    });
    if (metric.detail) {
      slide.addText(metric.detail, {
        objectName: `Metric ${index + 1} Detail`, x: x + 0.24, y: 4.28, w: width - 0.48, h: 0.65,
        fontFace: tokens.typography.bodyFontFace, fontSize: 14,
        color: tokens.colors.muted, margin: 0, align: 'center', fit: 'shrink',
      });
    }
  });
  addFooter(slide, tokens, content.source || content.footer, content.page);
  return slide;
}

export function comparisonSlide(pptx, tokens, content = {}) {
  const slide = pptx.addSlide();
  addBackground(pptx, slide, tokens.colors.white, 'Background', tokens.texture);
  addTitle(pptx, slide, tokens, content.title ?? 'A useful comparison', content.kicker, content.page);
  // Themes get their own tints; the legacy/untitled output keeps the fixed fills
  // so existing decks stay byte-identical.
  const themedFill = tokens.colors.soft ?? null;
  const sides = [
    { key: 'left', x: 0.74, color: tokens.colors.navy, fill: themedFill ?? 'EEF2F6' },
    {
      key: 'right',
      x: 6.76,
      color: tokens.colors.accent,
      fill: themedFill ? mixColor(tokens.colors.accent, tokens.colors.paper, 0.12) : 'FFF0E9',
    },
  ];
  for (const side of sides) {
    const data = content[side.key] ?? {};
    slide.addShape(pptx.ShapeType.rect, {
      objectName: `${side.key} field`, x: side.x, y: 1.72, w: 5.82, h: 4.5,
      fill: { color: side.fill }, line: { color: side.fill }, radius: 0.08,
    });
    slide.addText(data.heading ?? '', {
      objectName: `${side.key} heading`, x: side.x + 0.38, y: 2.08, w: 5.05, h: 0.45,
      fontFace: tokens.typography.headFontFace, fontSize: 25, bold: true,
      color: side.color, margin: 0, breakLine: false, fit: 'shrink',
    });
    slide.addText(toRuns(data.items ?? [], tokens), {
      objectName: `${side.key} points`, x: side.x + 0.38, y: 2.82, w: 4.98, h: 2.75,
      fontFace: tokens.typography.bodyFontFace, fontSize: 17,
      color: tokens.colors.ink, margin: 0.03, paraSpaceAfterPt: 11, fit: 'shrink',
    });
  }
  if (content.takeaway) {
    slide.addText(content.takeaway, {
      objectName: 'Comparison Takeaway', x: 1.58, y: 6.43, w: 10.2, h: 0.34,
      fontFace: tokens.typography.bodyFontFace, fontSize: 15, bold: true,
      color: tokens.colors.ink, align: 'center', margin: 0, breakLine: false, fit: 'shrink',
    });
  }
  addFooter(slide, tokens, content.footer, content.page);
  return slide;
}

export function timelineSlide(pptx, tokens, content = {}) {
  const slide = pptx.addSlide();
  addBackground(pptx, slide, tokens.colors.paper, 'Background', tokens.texture);
  addTitle(pptx, slide, tokens, content.title ?? 'A sequence with momentum', content.kicker, content.page);
  const steps = (content.steps ?? []).slice(0, 5);
  const startX = 1.18;
  const endX = 12.15;
  const y = 3.22;
  if (steps.length > 1) {
    slide.addShape(pptx.ShapeType.line, {
      objectName: 'Timeline Connector', x: startX, y, w: endX - startX, h: 0,
      line: { color: 'AAB7C4', width: 2.2 },
    });
  }
  steps.forEach((step, index) => {
    const x = steps.length === 1 ? (startX + endX) / 2 : startX + ((endX - startX) * index) / (steps.length - 1);
    slide.addShape(pptx.ShapeType.ellipse, {
      objectName: `Step ${index + 1} Node`, x: x - 0.18, y: y - 0.18, w: 0.36, h: 0.36,
      fill: { color: index === steps.length - 1 ? tokens.colors.accent : tokens.colors.navy },
      line: { color: tokens.colors.white, width: 1.5 },
    });
    slide.addText(step.label, {
      objectName: `Step ${index + 1} Label`, x: x - 0.92, y: 2.2, w: 1.84, h: 0.55,
      fontFace: tokens.typography.headFontFace, fontSize: 18, bold: true,
      color: tokens.colors.ink, margin: 0, align: 'center', valign: 'bottom', fit: 'shrink',
    });
    if (step.detail) {
      slide.addText(step.detail, {
        objectName: `Step ${index + 1} Detail`, x: x - 0.9, y: 3.72, w: 1.8, h: 1.2,
        fontFace: tokens.typography.bodyFontFace, fontSize: 13,
        color: tokens.colors.muted, margin: 0, align: 'center', fit: 'shrink',
      });
    }
  });
  addFooter(slide, tokens, content.footer, content.page);
  return slide;
}

export function chartSlide(pptx, tokens, content = {}) {
  const slide = pptx.addSlide();
  addBackground(pptx, slide, tokens.colors.white, 'Background', tokens.texture);
  addTitle(pptx, slide, tokens, content.title ?? 'One quantitative comparison', content.kicker, content.page);
  const themed = tokens.chart ?? null;
  const CHART_KINDS = new Set(['area', 'bar', 'bar3D', 'bubble', 'doughnut', 'line', 'pie', 'radar', 'scatter']);
  const requestedKind = String(content.chartType ?? 'bar');
  let chartKind = requestedKind;
  let barDir = content.barDir;
  if (requestedKind === 'column' || requestedKind === 'columns') {
    chartKind = 'bar';
    barDir = 'col';
  } else if (requestedKind === 'hbar' || requestedKind === 'horizontal-bar') {
    chartKind = 'bar';
    barDir = 'bar';
  }
  if (!CHART_KINDS.has(chartKind)) {
    throw new Error(
      `Unsupported chartType ${JSON.stringify(requestedKind)}; use one of ${[...CHART_KINDS].join(', ')}, `
      + 'or the aliases column / horizontal-bar',
    );
  }
  if (!Array.isArray(content.series) || content.series.length === 0) {
    throw new Error('A chart slide needs at least one series: [{ name, labels, values }]');
  }
  const chartOptions = {
    objectName: 'Primary Chart', x: 0.76, y: 1.66, w: 8.55, h: 4.9,
    catAxisLabelFontFace: tokens.typography.bodyFontFace,
    catAxisLabelFontSize: Math.max(10, tokens.typography.caption + 1),
    valAxisLabelFontFace: tokens.typography.bodyFontFace,
    valAxisLabelFontSize: tokens.typography.caption,
    showLegend: (content.series ?? []).length > 1,
    showTitle: false,
    showValue: content.showValue ?? (['bar', 'pie', 'doughnut'].includes(chartKind) && (content.series ?? []).length === 1),
    dataLabelColor: tokens.colors.ink,
    dataLabelFontFace: tokens.typography.bodyFontFace,
    dataLabelFontSize: 11,
    chartColors: content.colors
      ?? (themed?.series?.length ? themed.series : [tokens.colors.navy, tokens.colors.accent, tokens.colors.cyan]),
    showCatName: false,
    showValAxisTitle: false,
    showCatAxisTitle: false,
    showBorder: false,
  };
  if (barDir) chartOptions.barDir = barDir;
  if (themed) {
    if (themed.grid) chartOptions.valGridLine = { color: themed.grid, style: 'solid', size: 0.75 };
    if (themed.axis) {
      chartOptions.catAxisLabelColor = themed.axis;
      chartOptions.valAxisLabelColor = themed.axis;
    }
  }
  // `type` is the layout name ('chart'), so the chart kind needs its own key;
  // pptxgenjs 4.x also dropped the instance-level ChartType enum.
  slide.addChart(chartKind, content.series, chartOptions);
  if (content.takeaway) {
    slide.addText(content.takeaway, {
      objectName: 'Chart Takeaway', x: 9.78, y: 2.15, w: 2.6, h: 2.8,
      fontFace: tokens.typography.headFontFace, fontSize: 23, bold: true,
      color: tokens.colors.ink, margin: 0, valign: 'mid', fit: 'shrink',
    });
  }
  addFooter(slide, tokens, content.source || content.footer, content.page);
  return slide;
}

export function tableSlide(pptx, tokens, content = {}) {
  const slide = pptx.addSlide();
  addBackground(pptx, slide, tokens.colors.paper, 'Background', tokens.texture);
  addTitle(pptx, slide, tokens, content.title ?? 'Exact values', content.kicker, content.page);
  const headerMode = surfaceOf(tokens).tableHeader ?? 'primary-fill';
  const rowCount = Math.max(1, (content.rows ?? []).length);
  const rowHeight = rowCount <= 3 ? 0.8 : rowCount <= 5 ? 0.72 : 0.54;
  const tableTop = 1.62 + Math.max(0, (4.95 - rowCount * rowHeight) / 2);
  slide.addTable(styledTableRows(content.rows ?? [], tokens), {
    objectName: 'Primary Table', x: 0.76, y: tableTop, w: 11.82, h: rowCount * rowHeight,
    border: { type: 'solid', color: tokens.colors.rule, pt: 1 },
    fontFace: tokens.typography.bodyFontFace,
    fontSize: tokens.typography.table ?? 15,
    margin: 0.08,
    rowH: rowHeight,
    breakLine: false,
    autoFit: false,
  });
  if (headerMode === 'ink-rule') {
    // `ink-rule` header keeps the paper colour and separates with a heavy rule
    // instead of a filled band.
    slide.addShape(pptx.ShapeType.line, {
      objectName: 'Table Header Rule', x: 0.76, y: tableTop + rowHeight, w: 11.82, h: 0,
      line: { color: tokens.colors.ink, width: 2 },
    });
  }
  addFooter(slide, tokens, content.source || content.footer, content.page);
  return slide;
}

export function quoteSlide(pptx, tokens, content = {}) {
  const slide = pptx.addSlide();
  addBackground(pptx, slide, tokens.colors.navy, 'Background', tokens.texture);
  slide.addText('“', {
    objectName: 'Quote Mark', x: 0.76, y: 0.66, w: 1.0, h: 1.1,
    fontFace: 'Georgia', fontSize: 72, bold: true, color: tokens.colors.accent,
    margin: 0, breakLine: false,
  });
  slide.addText(content.quote ?? 'A short, useful quotation belongs here.', {
    objectName: 'Quote', x: 1.58, y: 1.38, w: 10.22, h: 2.55,
    fontFace: tokens.typography.headFontFace, fontSize: 34, bold: true,
    color: tokens.colors.white, margin: 0, valign: 'mid', fit: 'shrink',
  });
  slide.addShape(pptx.ShapeType.line, {
    objectName: 'Quote Rule', x: 1.6, y: 4.45, w: 1.1, h: 0,
    line: { color: tokens.colors.accent, width: 3 },
  });
  slide.addText(content.attribution ?? '', {
    objectName: 'Attribution', x: 1.6, y: 4.82, w: 6.2, h: 0.42,
    fontFace: tokens.typography.bodyFontFace, fontSize: 18, bold: true,
    color: tokens.colors.onDark ?? 'D7E2EA', margin: 0, breakLine: false, fit: 'shrink',
  });
  if (content.context) {
    slide.addText(content.context, {
      objectName: 'Quote Context', x: 1.6, y: 5.38, w: 7.9, h: 0.38,
      fontFace: tokens.typography.bodyFontFace, fontSize: 13,
      color: tokens.colors.onDarkMuted ?? 'A9BECC', margin: 0, breakLine: false, fit: 'shrink',
    });
  }
  addFooter(slide, tokens, content.footer, content.page, true);
  return slide;
}

export function closingSlide(pptx, tokens, content = {}) {
  const slide = pptx.addSlide();
  addBackground(pptx, slide, tokens.colors.navy, 'Background', tokens.texture);
  slide.addShape(pptx.ShapeType.line, {
    objectName: 'Closing Accent', x: 0.76, y: 1.25, w: 1.32, h: 0,
    line: { color: tokens.colors.accent, width: 4 },
  });
  slide.addText(content.title ?? 'Move the work forward.', {
    objectName: 'Closing Title', x: 0.76, y: 1.68, w: 10.85, h: 1.18,
    fontFace: tokens.typography.headFontFace, fontSize: 46, bold: true,
    color: tokens.colors.white, margin: 0, breakLine: false, fit: 'shrink',
  });
  if (content.action) {
    slide.addText(content.action, {
      objectName: 'Closing Action', x: 0.78, y: 3.34, w: 8.7, h: 0.8,
      fontFace: tokens.typography.bodyFontFace, fontSize: 23,
      color: tokens.colors.onDark ?? 'D7E2EA', margin: 0, fit: 'shrink',
    });
  }
  if (content.contact) {
    slide.addText(content.contact, {
      objectName: 'Closing Contact', x: 0.78, y: 6.45, w: 7.8, h: 0.28,
      fontFace: tokens.typography.bodyFontFace, fontSize: 13,
      color: tokens.colors.onDarkMuted ?? 'A9BECC', margin: 0, breakLine: false,
    });
  }
  return slide;
}

/**
 * Case page: four profile chips on top, two reading columns below.
 * Schema: { title, kicker, profile: [{label, value}], left: {heading, items},
 *           right: {heading, items} }
 */
export function caseSlide(pptx, tokens, content = {}) {
  const slide = pptx.addSlide();
  addBackground(pptx, slide, tokens.colors.paper, 'Background', tokens.texture);
  addTitle(pptx, slide, tokens, content.title ?? '病例概况', content.kicker, content.page);
  const profile = (content.profile ?? []).slice(0, 4);
  const chipWidth = profile.length ? (11.85 - 0.18 * (profile.length - 1)) / profile.length : 0;
  profile.forEach((item, index) => {
    const x = 0.74 + index * (chipWidth + 0.18);
    slide.addShape(pptx.ShapeType.rect, {
      objectName: `Profile Chip ${index + 1}`, x, y: 1.64, w: chipWidth, h: 0.94,
      fill: { color: tokens.colors.soft ?? 'EEF2F6' }, line: { color: tokens.colors.soft ?? 'EEF2F6' }, radius: 0.06,
    });
    slide.addText(item.label ?? '', {
      objectName: `Profile Label ${index + 1}`, x: x + 0.18, y: 1.74, w: chipWidth - 0.36, h: 0.24,
      fontFace: tokens.typography.bodyFontFace, fontSize: Math.max(10, tokens.typography.caption),
      bold: true, color: tokens.colors.muted, margin: 0, breakLine: false, fit: 'shrink',
    });
    slide.addText(item.value ?? '', {
      objectName: `Profile Value ${index + 1}`, x: x + 0.18, y: 2.02, w: chipWidth - 0.36, h: 0.44,
      fontFace: tokens.typography.headFontFace, fontSize: 20, bold: true,
      color: tokens.colors.ink, margin: 0, breakLine: false, fit: 'shrink',
    });
  });
  slide.addShape(pptx.ShapeType.line, {
    objectName: 'Case Divider', x: 6.62, y: 2.82, w: 0, h: 3.95,
    line: { color: tokens.colors.rule, width: 1.1 },
  });
  for (const [key, x, color] of [
    ['left', 0.74, tokens.colors.navy],
    ['right', 6.94, tokens.colors.accent],
  ]) {
    const column = content[key] ?? {};
    slide.addText(column.heading ?? '', {
      objectName: `${key} heading`, x, y: 2.84, w: 5.4, h: 0.4,
      fontFace: tokens.typography.headFontFace, fontSize: 20, bold: true,
      color, margin: 0, breakLine: false, fit: 'shrink',
    });
    slide.addText(toRuns(column.items ?? [], tokens), {
      objectName: `${key} body`, x, y: 3.36, w: 5.3, h: 3.35,
      fontFace: tokens.typography.bodyFontFace, fontSize: tokens.typography.body,
      color: tokens.colors.ink, margin: 0.04, paraSpaceAfterPt: 10, fit: 'shrink',
    });
  }
  addFooter(slide, tokens, content.source || content.footer, content.page);
  return slide;
}

/**
 * Evidence page: one verdict card plus evidence rows carrying a level badge.
 * Schema: { title, kicker, verdict, items: [{label, detail, level}], source }
 */
export function evidenceSlide(pptx, tokens, content = {}) {
  const slide = pptx.addSlide();
  addBackground(pptx, slide, tokens.colors.white, 'Background', tokens.texture);
  addTitle(pptx, slide, tokens, content.title ?? '证据与推荐', content.kicker, content.page);
  const callout = surfaceOf(tokens).callout ?? 'left-rule-soft';
  const calloutFill = callout === 'hairline-box'
    ? (tokens.colors.surface ?? tokens.colors.white)
    : (tokens.colors.soft ?? 'EEF2F6');
  const calloutLine = callout === 'hairline-box'
    ? { color: tokens.colors.rule, width: 1 }
    : { color: calloutFill, transparency: 100 };
  slide.addShape(pptx.ShapeType.rect, {
    objectName: 'Verdict Card', x: 0.74, y: 1.6, w: 11.85, h: 1.42,
    fill: { color: calloutFill }, line: calloutLine, radius: callout === 'rounded-card' ? 0.16 : 0.06,
    ...(callout === 'hairline-box' ? {} : { shadow: CARD_SHADOW }),
  });
  if (callout === 'left-rule-soft') {
    slide.addShape(pptx.ShapeType.rect, {
      objectName: 'Verdict Rule', x: 0.74, y: 1.6, w: 0.09, h: 1.42,
      fill: { color: tokens.colors.accent }, line: { color: tokens.colors.accent },
    });
  }
  slide.addText(content.verdict ?? '', {
    objectName: 'Verdict', x: 1.08, y: 1.72, w: 11.15, h: 1.18,
    fontFace: tokens.typography.headFontFace, fontSize: 21, bold: true,
    color: tokens.colors.ink, margin: 0, valign: 'mid', fit: 'shrink',
  });
  const items = (content.items ?? []).slice(0, 4);
  items.forEach((item, index) => {
    const y = 3.24 + index * 0.92;
    slide.addText(item.level ?? String(index + 1), {
      objectName: `Level Badge ${index + 1}`, x: 0.74, y, w: 0.78, h: 0.4,
      fontFace: tokens.typography.headFontFace, fontSize: 13, bold: true,
      color: tokens.colors.onPrimary ?? 'FFFFFF', align: 'center', valign: 'mid',
      margin: 0, fill: { color: tokens.colors.navy }, breakLine: false,
    });
    slide.addText(item.label ?? '', {
      objectName: `Evidence Label ${index + 1}`, x: 1.72, y, w: 4.5, h: 0.42,
      fontFace: tokens.typography.headFontFace, fontSize: 17, bold: true,
      color: tokens.colors.ink, margin: 0, valign: 'mid', breakLine: false, fit: 'shrink',
    });
    slide.addText(item.detail ?? '', {
      objectName: `Evidence Detail ${index + 1}`, x: 6.4, y, w: 6.1, h: 0.42,
      fontFace: tokens.typography.bodyFontFace, fontSize: Math.max(12, tokens.typography.body - 3),
      color: tokens.colors.muted, margin: 0, valign: 'mid', breakLine: false, fit: 'shrink',
    });
    if (index < items.length - 1) {
      slide.addShape(pptx.ShapeType.line, {
        objectName: `Evidence Divider ${index + 1}`, x: 0.74, y: y + 0.62, w: 11.85, h: 0,
        line: { color: tokens.colors.rule, width: 0.9 },
      });
    }
  });
  addFooter(slide, tokens, content.source || content.footer, content.page);
  return slide;
}

/**
 * Imaging page: one large local image with a caption plus a reading column.
 * Schema: { title, kicker, image: {path, caption}, findings: [], impression }
 */
export function imagingSlide(pptx, tokens, content = {}) {
  const slide = pptx.addSlide();
  addBackground(pptx, slide, tokens.colors.paper, 'Background', tokens.texture);
  addTitle(pptx, slide, tokens, content.title ?? '影像所见', content.kicker, content.page);
  const frame = { x: 0.74, y: 1.62, w: 7.1, h: 4.62 };
  slide.addShape(pptx.ShapeType.rect, {
    objectName: 'Imaging Frame', ...frame,
    fill: { color: tokens.colors.white }, line: { color: tokens.colors.rule, width: 1.1 },
  });
  if (content.image?.path) {
    slide.addImage({
      objectName: 'Imaging Panel',
      path: content.image.path,
      x: frame.x + 0.09, y: frame.y + 0.09, w: frame.w - 0.18, h: frame.h - 0.18,
      sizing: { type: 'contain', w: frame.w - 0.18, h: frame.h - 0.18 },
    });
  } else {
    slide.addShape(pptx.ShapeType.rect, {
      objectName: 'Imaging Placeholder', x: frame.x + 0.09, y: frame.y + 0.09,
      w: frame.w - 0.18, h: frame.h - 0.18,
      fill: { color: tokens.colors.soft ?? 'E5EAF0' },
      line: { color: tokens.colors.rule, dash: 'dash' },
    });
    slide.addText('影像未提供', {
      objectName: 'Imaging Placeholder Text', x: frame.x + 0.09, y: frame.y + 2.0,
      w: frame.w - 0.18, h: 0.5, fontFace: tokens.typography.bodyFontFace, fontSize: 15,
      color: tokens.colors.muted, align: 'center', margin: 0,
    });
  }
  if (content.image?.caption) {
    slide.addText(content.image.caption, {
      objectName: 'Imaging Caption', x: frame.x, y: frame.y + frame.h + 0.1, w: frame.w, h: 0.34,
      fontFace: tokens.typography.bodyFontFace, fontSize: tokens.typography.caption,
      color: tokens.colors.muted, align: 'center', margin: 0, breakLine: false, fit: 'shrink',
    });
  }
  slide.addText('影像所见', {
    objectName: 'Findings Heading', x: 8.1, y: 1.62, w: 4.5, h: 0.36,
    fontFace: tokens.typography.headFontFace, fontSize: 18, bold: true,
    color: tokens.colors.navy, margin: 0, breakLine: false,
  });
  slide.addText(toRuns(content.findings ?? [], tokens), {
    objectName: 'Findings Body', x: 8.1, y: 2.06, w: 4.45, h: 2.2,
    fontFace: tokens.typography.bodyFontFace, fontSize: 14,
    color: tokens.colors.ink, margin: 0.03, paraSpaceAfterPt: 8, fit: 'shrink',
  });
  if (content.impression) {
    slide.addShape(pptx.ShapeType.rect, {
      objectName: 'Impression Rule', x: 8.1, y: 4.44, w: 0.06, h: 1.1,
      fill: { color: tokens.colors.accent }, line: { color: tokens.colors.accent },
    });
    slide.addText('结论', {
      objectName: 'Impression Heading', x: 8.32, y: 4.4, w: 4.2, h: 0.28,
      fontFace: tokens.typography.bodyFontFace, fontSize: 12, bold: true,
      color: tokens.colors.accent, margin: 0, breakLine: false,
    });
    slide.addText(content.impression, {
      objectName: 'Impression Text', x: 8.32, y: 4.72, w: 4.2, h: 1.0,
      fontFace: tokens.typography.bodyFontFace, fontSize: 15,
      color: tokens.colors.ink, margin: 0, valign: 'top', fit: 'shrink',
    });
  }
  addFooter(slide, tokens, content.source || content.footer, content.page);
  return slide;
}
