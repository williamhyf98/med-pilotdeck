import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadDependencies, skillRoot } from './runtime.mjs';

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
 * Named color themes are a third axis alongside typography profile + density.
 * A theme only overrides `colors` (and optionally `canvas`) through data —
 * `assets/layout-library/layouts/*.mjs` stays untouched, as SKILL.md requires.
 *
 * Constraint worth knowing before authoring a new theme: `colors.white` doubles
 * as a light slide background AND as the title text drawn on top of
 * `colors.navy`, and a few on-navy captions in core.mjs are hardcoded light
 * blue-grey. So every theme must keep `white`/`paper` light and `navy` dark;
 * a fully dark deck is not expressible without editing the layout builders.
 */
export async function listThemes() {
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
  const themeName = options.theme ?? base.theme ?? DEFAULT_THEME;
  const theme = base.themes?.[themeName];
  if (!theme) {
    const available = Object.keys(base.themes ?? {}).join(', ') || '(none)';
    throw new Error(`Unknown color theme: ${themeName} (available: ${available})`);
  }
  return {
    ...base,
    theme: themeName,
    colors: merge(base.colors, theme.colors),
    canvas: merge(base.canvas, theme.canvas),
    typography,
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
  return {
    createDeck: themeName ? (opts = {}) => createDeck({ theme: themeName, ...opts }) : createDeck,
    resolveDesignTokens: themeName
      ? (opts = {}) => resolveDesignTokens({ theme: themeName, ...opts })
      : resolveDesignTokens,
    listThemes,
    theme: themeName ?? base.theme ?? DEFAULT_THEME,
    layouts: await layouts(),
    tokens: deckTokens,
    pptxgenjs: deps.PptxGenJS,
    imageSizingCrop,
    imageSizingContain,
  };
}
