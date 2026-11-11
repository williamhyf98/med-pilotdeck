import fs from 'node:fs/promises';
import path from 'node:path';
import { auditPptx } from './audit.mjs';
import { inspectPptx } from './ooxml.mjs';
import { renderPptx, renderingAvailability } from './render.mjs';
import { SLIDE_ACCENT_ROLES, SLIDE_TONES, tokensForSlide } from './slide-style.mjs';
import { buildToolkit } from './toolkit.mjs';

const HEADING = /^(#{1,3})\s+(.+?)\s*$/u;
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$/u;
const LAYOUTS = new Set([
  'title', 'section', 'statement', 'content', 'split', 'two-column',
  'metric', 'metrics', 'comparison', 'timeline', 'chart', 'table', 'quote', 'closing',
  'case', 'evidence', 'imaging',
]);

function nonEmpty(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

async function readText(file) {
  return fs.readFile(path.resolve(file), 'utf8');
}

function paragraphs(text) {
  return String(text ?? '').split(/\n\s*\n/u).map((item) => item.trim()).filter(Boolean);
}

const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/u;

function splitTableRow(line) {
  const text = String(line).trim().replace(/^\|/u, '').replace(/\|$/u, '');
  return text.split('|').map((cell) => cell.trim());
}

function parseMarkdown(markdown, explicitTitle) {
  let title = nonEmpty(explicitTitle);
  const slides = [];
  let current = null;
  let paragraph = [];
  const lines = String(markdown ?? '').split(/\r?\n/u);

  const ensureSlide = () => {
    if (!current) current = { type: 'content', title: title || '内容', items: [] };
    return current;
  };
  const flushParagraph = () => {
    const value = paragraph.join(' ').trim();
    paragraph = [];
    if (value) ensureSlide().items.push(value);
  };
  const flushSlide = () => {
    flushParagraph();
    if (!current) return;
    current.items = current.items.filter(Boolean);
    if (current.type === 'section' && current.items.length) {
      // A section divider only draws its heading, so body text under a level-1
      // heading used to disappear without a trace. Keep the heading as the
      // content slide title instead of dropping what the user wrote.
      current.type = 'content';
    }
    slides.push(current);
    current = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) {
      flushParagraph();
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2].trim();
      if (level === 1 && !title && slides.length === 0 && !current) {
        title = text;
      } else {
        flushSlide();
        current = {
          type: level === 1 ? 'section' : 'content',
          title: text,
          items: [],
        };
      }
      continue;
    }
    // GitHub-style pipe table → a real table slide.
    if (line.includes('|') && index + 1 < lines.length && TABLE_SEPARATOR.test(lines[index + 1].trim())) {
      const header = splitTableRow(line);
      const delimiter = splitTableRow(lines[index + 1]);
      if (header.length >= 2 && header.length === delimiter.length) {
        const rows = [header];
        let cursor = index + 2;
        while (cursor < lines.length && lines[cursor].trim() && lines[cursor].includes('|')) {
          const cells = splitTableRow(lines[cursor]);
          if (cells.length !== header.length) break;
          rows.push(cells);
          cursor += 1;
        }
        if (rows.length >= 2) {
          flushParagraph();
          const tableTitle = current?.title || title || '表格';
          if (current && (current.items ?? []).filter(Boolean).length === 0) {
            // The heading directly above the table becomes the table slide.
            current.type = 'table';
            current.rows = rows;
            slides.push(current);
            current = null;
          } else {
            flushSlide();
            slides.push({ type: 'table', title: tableTitle, rows });
          }
          index = cursor - 1;
          continue;
        }
      }
    }
    const bullet = line.match(BULLET);
    if (bullet) {
      flushParagraph();
      ensureSlide().items.push(bullet[1].trim());
      continue;
    }
    paragraph.push(line);
  }
  flushSlide();
  return { title, slides };
}

function bodySlides(body, title) {
  const items = paragraphs(body);
  return items.length ? [{ type: 'content', title: title ? '核心内容' : '内容', items }] : [];
}

function normalizeSpec(value, titleOverride, themeOverride) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('PPTX make spec must be a JSON object');
  }
  const title = nonEmpty(titleOverride) || nonEmpty(value.title);
  const slides = Array.isArray(value.slides) ? value.slides : [];
  return {
    title,
    subtitle: nonEmpty(value.subtitle),
    footer: nonEmpty(value.footer),
    locale: nonEmpty(value.locale) || 'zh-CN',
    author: nonEmpty(value.author) || 'PilotDeck',
    // null → resolveDesignTokens falls back to the default theme in design-tokens.json.
    theme: nonEmpty(themeOverride) || nonEmpty(value.theme) || undefined,
    texture: nonEmpty(value.texture) || undefined,
    slides,
  };
}

function assertLocalResources(value, parentKey = '') {
  if (Array.isArray(value)) {
    value.forEach((item) => assertLocalResources(item, parentKey));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (
      typeof child === 'string'
      && /^(?:path|src|image)$/iu.test(key)
      && /^https?:\/\//iu.test(child.trim())
    ) {
      throw new Error(`Remote PPTX resources are not allowed (${key}); use a local workspace file`);
    }
    assertLocalResources(child, key);
  }
}

function resolveLocalResources(value, baseDir) {
  if (Array.isArray(value)) {
    value.forEach((item) => resolveLocalResources(item, baseDir));
    return value;
  }
  if (!value || typeof value !== 'object') return value;
  for (const [key, child] of Object.entries(value)) {
    if (
      typeof child === 'string'
      && /^(?:path|src)$/iu.test(key)
      && !/^https?:\/\//iu.test(child.trim())
      && !path.isAbsolute(child)
    ) {
      value[key] = path.resolve(baseDir, child);
    } else {
      resolveLocalResources(child, baseDir);
    }
  }
  return value;
}

function normalizeSlides(spec) {
  const slides = [];
  if (spec.title) {
    slides.push({
      type: 'title',
      title: spec.title,
      subtitle: spec.subtitle,
      meta: spec.footer,
    });
  }
  for (const [index, raw] of spec.slides.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`slides[${index}] must be an object`);
    }
    const type = nonEmpty(raw.type) || 'content';
    if (!LAYOUTS.has(type)) {
      throw new Error(`Unsupported slide type ${JSON.stringify(type)} at slides[${index}]`);
    }
    if (raw.accent !== undefined && raw.accent !== null) {
      const accent = String(raw.accent).trim();
      const role = accent.toLowerCase();
      // 设计档 A：六位 hex 也允许，可读性由 slide-style 的对比度门禁负责。
      if (!SLIDE_ACCENT_ROLES.includes(role) && !/^#?[0-9A-Fa-f]{6}$/u.test(accent)) {
        throw new Error(
          `Unsupported slides[${index}].accent ${JSON.stringify(raw.accent)}; `
          + `use ${SLIDE_ACCENT_ROLES.join(', ')} or a 6-digit hex such as #1F5FA9`,
        );
      }
    }
    if (raw.tone !== undefined && raw.tone !== null) {
      const tone = String(raw.tone).trim().toLowerCase();
      if (!SLIDE_TONES.includes(tone)) {
        throw new Error(
          `Unsupported slides[${index}].tone ${JSON.stringify(raw.tone)}; `
          + `use ${SLIDE_TONES.join(', ')}`,
        );
      }
    }
    if (type === 'title' && spec.title && index === 0) {
      slides[0] = { ...slides[0], ...raw, type };
      continue;
    }
    slides.push({ ...raw, type });
  }
  if (!slides.length) throw new Error('PPTX make requires a title or at least one slide');
  return slides;
}

function addSlide(layouts, pptx, tokens, slide, page, footer) {
  const content = { ...slide, page: slide.page ?? page, footer: slide.footer ?? footer };
  const handlers = {
    title: layouts.titleSlide,
    section: layouts.sectionSlide,
    statement: layouts.statementSlide,
    content: layouts.contentSlide,
    split: layouts.splitSlide,
    'two-column': layouts.twoColumnSlide,
    metric: layouts.metricSlide,
    metrics: layouts.metricSlide,
    comparison: layouts.comparisonSlide,
    timeline: layouts.timelineSlide,
    chart: layouts.chartSlide,
    table: layouts.tableSlide,
    quote: layouts.quoteSlide,
    closing: layouts.closingSlide,
    case: layouts.caseSlide,
    evidence: layouts.evidenceSlide,
    imaging: layouts.imagingSlide,
  };
  // 单页强调色：只替换该页的 accent，其它颜色与版式继承主题。
  handlers[slide.type](pptx, tokensForSlide(tokens, content), content);
}

async function outputExists(file) {
  return fs.stat(file).then((stat) => stat.isFile()).catch(() => false);
}

function qaRootFor(output) {
  const workDir = nonEmpty(process.env.PILOTDECK_WORK_DIR);
  if (workDir) {
    return path.join(path.resolve(workDir), 'pptx', 'make', `${Date.now()}-${process.pid}`);
  }
  return path.join(path.dirname(output), '.pptx-qa', path.basename(output, '.pptx'));
}

export async function makePptx(options = {}) {
  const output = path.resolve(options.output);
  if (path.extname(output).toLowerCase() !== '.pptx') {
    throw new Error(`PPTX output must end with .pptx: ${output}`);
  }
  if (await outputExists(output) && !options.force) {
    throw new Error(`Output already exists; pass --force to replace: ${output}`);
  }

  let spec;
  if (options.specFile) {
    const specPath = path.resolve(options.specFile);
    spec = normalizeSpec(
      resolveLocalResources(JSON.parse(await readText(specPath)), path.dirname(specPath)),
      options.title,
      options.theme,
    );
  } else if (options.markdownFile) {
    const parsed = parseMarkdown(await readText(options.markdownFile), options.title);
    spec = normalizeSpec({
      title: parsed.title,
      slides: parsed.slides,
      locale: options.locale,
      footer: options.footer,
      theme: options.theme,
    });
  } else {
    let body = options.body;
    if (options.bodyFile) body = await readText(options.bodyFile);
    spec = normalizeSpec({
      title: options.title,
      slides: bodySlides(body, options.title),
      locale: options.locale,
      footer: options.footer,
      theme: options.theme,
    });
  }
  assertLocalResources(spec);
  if (!spec.texture && options.texture) spec.texture = options.texture;
  const slides = normalizeSlides(spec);

  const qaRoot = qaRootFor(output);
  const candidate = path.join(qaRoot, 'candidate.pptx');
  const auditFile = path.join(qaRoot, 'audit.json');
  const renderDir = path.join(qaRoot, 'slides');
  await fs.mkdir(qaRoot, { recursive: true });

  const toolkit = await buildToolkit();
  const baseTokens = await toolkit.resolveDesignTokens({
    lang: spec.locale,
    profile: /^zh(?:-|$)/iu.test(spec.locale) ? 'cross-platform-zh' : 'cross-platform-en',
    density: 'presentation',
    theme: spec.theme,
    texture: spec.texture,
  });
  // Themed decks already carry the target-machine font name (theme role ->
  // officeWindows). The unthemed path still resolves to Arial from the
  // cross-platform-zh profile, which has no Chinese glyphs, so it keeps an
  // explicit Chinese face — now Microsoft YaHei instead of the Noto name that
  // neither Windows nor Office for Mac ships. The legacy `build` path is left
  // untouched so old decks stay byte-identical.
  const serifTheme = baseTokens.themeFontRole === 'serif';
  const tokens = {
    ...baseTokens,
    typography: {
      ...baseTokens.typography,
      headFontFace: serifTheme ? baseTokens.typography.headFontFace : 'Microsoft YaHei',
      bodyFontFace: serifTheme ? baseTokens.typography.bodyFontFace : 'Microsoft YaHei',
    },
  };
  const pptx = await toolkit.createDeck({
    title: spec.title || '',
    author: spec.author,
    lang: spec.locale,
    tokens,
    headFontFace: tokens.typography.headFontFace,
    bodyFontFace: tokens.typography.bodyFontFace,
  });
  slides.forEach((slide, index) => addSlide(
    toolkit.layouts,
    pptx,
    tokens,
    slide,
    index + 1,
    spec.footer,
  ));
  await pptx.writeFile({ fileName: candidate });

  const audit = await auditPptx(candidate, { output: auditFile });
  if (audit.status === 'failed') {
    throw new Error(`PPTX structural audit failed: ${audit.errors.map((item) => item.message || item.code).join('; ')}`);
  }

  const availability = renderingAvailability();
  let preview = [];
  let renderWarning = null;
  if (availability.available) {
    try {
      const render = await renderPptx(candidate, renderDir, {
        dpi: 144,
        montage: path.join(qaRoot, 'montage.png'),
      });
      preview = render.images ?? render.slides ?? [];
    } catch (error) {
      renderWarning = `未完成视觉验收：${error instanceof Error ? error.message : String(error)}`;
    }
  } else {
    renderWarning = '未完成视觉验收：Office Renderer is not configured; structural validation passed';
  }

  await fs.mkdir(path.dirname(output), { recursive: true });
  const staging = path.join(path.dirname(output), `.${path.basename(output)}.tmp-${process.pid}-${Date.now()}`);
  try {
    await fs.copyFile(candidate, staging);
    if (options.force) await fs.rm(output, { force: true });
    await fs.rename(staging, output);
  } finally {
    await fs.rm(staging, { force: true }).catch(() => {});
  }
  const manifest = await inspectPptx(output);
  return {
    status: 'ok',
    output,
    slides: manifest.slideCount,
    theme: tokens.theme,
    ...(tokens.themeLabel ? { themeLabel: tokens.themeLabel } : {}),
    ...(tokens.themeWarning ? { themeWarning: tokens.themeWarning } : {}),
    ...(tokens.fontFallback ? { fontFallback: tokens.fontFallback } : {}),
    ...(tokens.texture?.name ? { texture: tokens.texture.name } : {}),
    ...(tokens.textureFallback ? { textureFallback: tokens.textureFallback } : {}),
    preview,
    audit: {
      status: audit.status,
      counts: audit.counts,
      warnings: audit.warnings,
    },
    validation: {
      status: 'ok',
      sha256: manifest.sha256,
      bytes: manifest.bytes,
      slideCount: manifest.slideCount,
    },
    ...(renderWarning ? { warning: renderWarning } : {}),
  };
}
