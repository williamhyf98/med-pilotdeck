import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadDependencies, skillRoot } from './runtime.mjs';
import { listSharedThemes, resolveSharedTheme, themeFonts, themeTokens } from './themes.mjs';

let cachedTokens;
let cachedLayouts;

async function tokens() {
  if (!cachedTokens) {
    cachedTokens = JSON.parse(await fs.readFile(path.join(skillRoot(), 'assets/layout-library/design-tokens.json'), 'utf8'));
  }
  return cachedTokens;
}

function merge(base, override) {
  const result = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base?.[key] && typeof base[key] === 'object') {
      result[key] = merge(base[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export const DEFAULT_THEME = 'clinical';

/**
 * Page texture. Defaults to `grain` (approved 2026-11-09: the flat fill read as
 * "no design" in review, and a real PowerPoint PDF render was used as the
 * before/after evidence). `--texture none` restores the historical flat fill.
 * Any other name resolves to `assets/textures/<name>.png`; a missing asset is
 * an error, never a silent fallback.
 */
const TEXTURE_NONE = new Set([undefined, null, '', 'none', 'off', 'flat']);

export const DEFAULT_TEXTURE = 'grain';

export async function resolveTexture(name, { optional = false } = {}) {
  if (TEXTURE_NONE.has(name)) return null;
  const file = path.join(skillRoot(), 'assets/textures', `${name}.png`);
  try {
    await fs.access(file);
  } catch (error) {
    if (error.code === 'ENOENT') {
      // A partial copy of the skill (no textures/assets) must still generate.
      // The implicit default degrades to the flat fill and says so; an explicit
      // `--texture <name>` never silently downgrades.
      if (optional) return { name, skipped: 'missing-asset', path: null };
      throw new Error(`Unknown page texture: ${name} (expected ${file})`);
    }
    throw error;
  }
  return { name, path: file };
}

/**
 * Legacy themes select colors alongside typography profile and density.
 * Explicit Chinese themes also read the shared sans font and semantic
 * surface colors; unthemed output and the old vital palette stay unchanged.
 *
 * Constraint worth knowing before authoring a new theme: `colors.white` doubles
 * as a light slide background AND as the title text drawn on top of
 * `colors.navy`, and a few on-navy captions in core.mjs are hardcoded light
 * blue-grey on legacy output. So every theme must keep `white`/`paper` light and `navy` dark;
 * a fully dark deck is not expressible without editing the layout builders.
 */
export async function listThemes() {
  const shared = await listSharedThemes();
  if (shared) {
    return shared.themes.map(({ name, label, aliases, default: isDefault, colors }) => ({
      name, label, aliases, default: isDefault, colors,
    }));
  }
  const base = await tokens();
  return Object.entries(base.themes ?? {}).map(([name, theme]) => ({
    name,
    label: theme.label ?? name,
    description: theme.description ?? '',
    default: name === (base.theme ?? DEFAULT_THEME),
    colors: merge(base.colors, theme.colors),
  }));
}

export async function resolveDesignTokens(options = {}) {
  const base = await tokens();
  const language = options.lang ?? 'zh-CN';
  const inferredProfile = /^zh(?:-|$)/i.test(language) ? 'cross-platform-zh' : 'cross-platform-en';
  const profileName = options.profile ?? inferredProfile;
  const profile = base.typography.profiles?.[profileName];
  if (!profile) throw new Error(`Unknown typography profile: ${profileName}`);
  const densityName = options.density ?? 'presentation';
  const density = base.typography.densityProfiles?.[densityName];
  if (!density) throw new Error(`Unknown typography density: ${densityName}`);
  const typography = merge(merge(base.typography, profile), density);
  typography.profile = profileName;
  typography.density = densityName;
  typography.lang = options.lang ?? profile.lang ?? language;
  const implicitTexture = options.texture === undefined;
  const texture = await resolveTexture(implicitTexture ? DEFAULT_TEXTURE : options.texture, {
    optional: implicitTexture,
  });
  const themeName = options.theme ?? base.theme ?? DEFAULT_THEME;
  let colors = null;
  let warning = null;
  let fontFallback = null;
  let themeLabel = null;
  let themeRole = null;
  let canvas = base.canvas;
  let canonicalTheme = null;
  let chartTokens = null;
  let surfaceTokens = null;
  // D1 (2026-11-10): the default deck resolves through the shared contract
  // too, so "no --theme" and "--theme clinical" produce the same deck.
  // `clinical-legacy` / `vital-legacy` remain addressable by name for A/B and
  // rollback. Without the shared reader we keep the bundled legacy palettes so
  // decks still build.
  const sharedTheme = await resolveSharedTheme(themeName);
  if (sharedTheme) {
    const mapped = themeTokens(sharedTheme);
    colors = merge(base.colors, mapped.colors);
    warning = sharedTheme.warning ?? null;
    fontFallback = sharedTheme.fallback ?? null;
    themeLabel = sharedTheme.theme.label;
    canonicalTheme = sharedTheme.id;
    if (!mapped.legacy) {
      themeRole = sharedTheme.theme.typography.headingRole;
      if (sharedTheme.theme.chart) chartTokens = sharedTheme.theme.chart;
      // Structural tokens (masthead / sectionMarker / tableHeader / callout)
      // used to be dropped here, which is why every theme looked like a
      // recolour. Carry them through so layouts can change shape.
      if (sharedTheme.theme.surface) surfaceTokens = sharedTheme.theme.surface;
      if (profileName === 'cross-platform-zh') {
        const fonts = themeFonts(sharedTheme.tokens, sharedTheme.theme);
        typography.headFontFace = fonts.head;
        typography.bodyFontFace = fonts.body;
      }
      const scale = sharedTheme.theme.typography;
      for (const key of ['body', 'caption', 'table', 'subheading']) {
        if (typeof typography[key] === 'number' && Number.isFinite(scale.bodyScale)) {
          typography[key] = Math.round(typography[key] * scale.bodyScale * 2) / 2;
        }
      }
      if (typeof typography.lineHeight === 'number' && Number.isFinite(scale.lineHeightScale)) {
        typography.lineHeight = Math.round(typography.lineHeight * scale.lineHeightScale * 1000) / 1000;
      }
    }
  } else if (options.theme) {
    const theme = base.themes?.[themeName];
    if (!theme) {
      const available = Object.keys(base.themes ?? {}).join(', ') || '(none)';
      throw new Error(`Unknown color theme: ${themeName} (available: ${available})`);
    }
    colors = merge(base.colors, theme.colors);
    themeLabel = theme.label ?? themeName;
    canvas = merge(base.canvas, theme.canvas);
    if (profileName === 'cross-platform-zh') {
      typography.headFontFace = 'Microsoft YaHei';
      typography.bodyFontFace = 'Microsoft YaHei';
      fontFallback = 'shared theme reader is missing; using the Windows/Office Chinese font name';
    }
  }
  if (!colors) {
    const theme = base.themes?.[themeName];
    if (!theme) {
      const available = Object.keys(base.themes ?? {}).join(', ') || '(none)';
      throw new Error(`Unknown color theme: ${themeName} (available: ${available})`);
    }
    colors = merge(base.colors, theme.colors);
    themeLabel = theme.label ?? themeName;
    canvas = merge(base.canvas, theme.canvas);
  }
  return {
    ...base,
    theme: canonicalTheme ?? themeName,
    ...(themeLabel ? { themeLabel } : {}),
    ...(warning ? { themeWarning: warning } : {}),
    ...(themeRole ? { themeFontRole: themeRole } : {}),
    colors,
    canvas,
    ...(chartTokens ? { chart: chartTokens } : {}),
    ...(surfaceTokens ? { surface: surfaceTokens } : {}),
    typography,
    ...(fontFallback ? { fontFallback } : {}),
    ...(texture && !texture.skipped ? { texture } : {}),
    ...(texture?.skipped ? { textureFallback: texture.skipped } : {}),
  };
}

async function layouts() {
  if (!cachedLayouts) {
    cachedLayouts = await import(pathToFileURL(path.join(skillRoot(), 'assets/layout-library/layouts/core.mjs')).href);
  }
  return cachedLayouts;
}

export async function imageSizingCrop(imagePath, x, y, w, h) {
  const { sharp } = loadDependencies();
  const metadata = await sharp(path.resolve(imagePath)).metadata();
  if (!metadata.width || !metadata.height) throw new Error(`Unable to read image dimensions: ${imagePath}`);
  const sourceRatio = metadata.width / metadata.height;
  return {
    path: path.resolve(imagePath), x, y, w: sourceRatio, h: 1,
    sizing: { type: 'cover', w, h },
    transparency: 0,
  };
}

export async function imageSizingContain(imagePath, x, y, w, h) {
  const { sharp } = loadDependencies();
  const metadata = await sharp(path.resolve(imagePath)).metadata();
  if (!metadata.width || !metadata.height) throw new Error(`Unable to read image dimensions: ${imagePath}`);
  const sourceRatio = metadata.width / metadata.height;
  const targetRatio = w / h;
  let drawW = w;
  let drawH = h;
  if (sourceRatio > targetRatio) drawH = w / sourceRatio;
  else drawW = h * sourceRatio;
  return {
    path: path.resolve(imagePath),
    x: x + (w - drawW) / 2,
    y: y + (h - drawH) / 2,
    w: drawW,
    h: drawH,
  };
}

export async function createDeck(options = {}) {
  const { PptxGenJS } = loadDependencies();
  const deckTokens = options.tokens ?? await resolveDesignTokens({
    lang: options.lang,
    profile: options.typographyProfile,
    density: options.density,
    theme: options.theme,
  });
  const pptx = new PptxGenJS();
  pptx.layout = options.layout ?? deckTokens.canvas.layout;
  pptx.author = options.author ?? 'PilotDeck';
  pptx.company = options.company ?? 'PilotDeck';
  pptx.subject = options.subject ?? '';
  pptx.title = options.title ?? '';
  pptx.lang = options.lang ?? deckTokens.typography.lang ?? 'zh-CN';
  pptx.theme = {
    headFontFace: options.headFontFace ?? deckTokens.typography.headFontFace,
    bodyFontFace: options.bodyFontFace ?? deckTokens.typography.bodyFontFace,
    lang: options.lang ?? deckTokens.typography.lang ?? 'zh-CN',
  };
  return pptx;
}

/**
 * @param {{ theme?: string }} [options] Pin a color theme for this build. Bound
 * as the default for `resolveDesignTokens` / `createDeck` so existing builders
 * (which call `resolveDesignTokens({ lang, profile })` with no theme) follow
 * `--theme` without being rewritten; an explicit `theme` in the builder wins.
 */
export async function buildToolkit(options = {}) {
  const deps = loadDependencies();
  const base = await tokens();
  const themeName = options.theme;
  const deckTokens = themeName ? await resolveDesignTokens({ theme: themeName }) : base;
  const fontFallbacks = deckTokens.fontFallback ? [deckTokens.fontFallback] : [];
  const themedTokens = async (opts = {}) => {
    const resolved = await resolveDesignTokens({ theme: themeName, ...opts });
    if (resolved.fontFallback && !fontFallbacks.includes(resolved.fontFallback)) {
      fontFallbacks.push(resolved.fontFallback);
    }
    return resolved;
  };
  return {
    createDeck: themeName
      ? async (opts = {}) => createDeck({
        theme: themeName,
        ...opts,
        tokens: opts.tokens ?? await themedTokens({
          lang: opts.lang,
          profile: opts.typographyProfile,
          density: opts.density,
          theme: opts.theme ?? themeName,
        }),
      })
      : createDeck,
    resolveDesignTokens: themeName
      ? themedTokens
      : resolveDesignTokens,
    listThemes,
    theme: themeName ?? base.theme ?? DEFAULT_THEME,
    fontFallbacks,
    layouts: await layouts(),
    tokens: deckTokens,
    pptxgenjs: deps.PptxGenJS,
    imageSizingCrop,
    imageSizingContain,
  };
}
