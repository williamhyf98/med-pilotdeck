import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sharedRoot = path.dirname(fileURLToPath(import.meta.url));
const fallback = {
  schemaVersion: 2,
  defaultTheme: 'clinical',
  semantic: {
    danger: { fg: 'B42318', bg: 'FDECEC', onFg: 'FFFFFF' },
    warning: { fg: 'B45309', bg: 'FDF3E3', onFg: 'FFFFFF' },
    success: { fg: '157F3D', bg: 'E9F5EE', onFg: 'FFFFFF' },
    info: { fg: '1F5FA9', bg: 'EAF1FA', onFg: 'FFFFFF' },
  },
  fontRoles: {
    sans: { officeWindows: 'Microsoft YaHei', officeMac: 'PingFang SC', libreOffice: 'Noto Sans CJK SC',
      pdfFile: 'NotoSansSC-VF.ttf', htmlStack: 'system-ui,sans-serif', htmlBundle: [] },
    serif: { officeWindows: 'SimSun', officeMac: 'Songti SC', libreOffice: 'Noto Serif CJK SC',
      pdfFile: 'NotoSerifSC-Regular.ttf', htmlStack: 'serif', htmlBundle: [] },
    mono: { officeWindows: 'Consolas', officeMac: 'Menlo', libreOffice: 'DejaVu Sans Mono',
      pdfFile: null, htmlStack: 'monospace', htmlBundle: [] },
  },
  themes: {
    clinical: {
      label: '临床晨光', aliases: ['临床'], status: 'stable',
      colors: {
        paper: 'FFFFFF', surface: 'FFFFFF', ink: '172033', muted: '5F6B7A',
        primary: '12404F', accent: 'B4552D', support: '2F7183', rule: 'D8E0EA',
        soft: 'F3F4F6', onPrimary: 'FFFFFF', onDark: 'FFFFFF', onDarkMuted: 'D8E0EA',
      },
    },
  },
  recommend: [],
};

function candidates(options) {
  const roots = [
    options.bundledSkillsRoot ?? process.env.PILOTDECK_BUNDLED_SKILLS_DIR,
    path.dirname(sharedRoot),
    options.skillRoot && path.dirname(path.resolve(options.skillRoot)),
  ].filter(Boolean);
  return [...new Set(roots.map((root) => path.resolve(root)))].map((root) =>
    path.join(root, '_shared', 'design-tokens.json'));
}

function validateUsable(tokens, file) {
  if (!tokens || typeof tokens !== 'object' || tokens.schemaVersion !== 2) {
    throw new Error(`Unsupported theme schemaVersion at ${file}: ${tokens?.schemaVersion}`);
  }
  if (!tokens.semantic || !tokens.fontRoles || !Array.isArray(tokens.recommend)
      || !tokens.themes || !tokens.themes[tokens.defaultTheme]) {
    throw new Error(`Incomplete theme data at ${file}: required top-level data is missing`);
  }
  const colorKeys = ['paper', 'surface', 'ink', 'muted', 'primary', 'accent', 'support',
    'rule', 'soft', 'onPrimary', 'onDark', 'onDarkMuted'];
  for (const [id, theme] of Object.entries(tokens.themes)) {
    if (!theme || typeof theme.label !== 'string' || !Array.isArray(theme.aliases)
        || !colorKeys.every((key) => typeof theme.colors?.[key] === 'string')) {
      throw new Error(`Incomplete theme data at ${file}: ${id} is missing required fields`);
    }
  }
}

export async function loadTokens(options = {}) {
  for (const file of candidates(options)) {
    let raw;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    let tokens;
    try {
      tokens = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Invalid theme JSON at ${file}: ${error.message}`, { cause: error });
    }
    validateUsable(tokens, file);
    return { tokens, source: await realpath(file), reason: null };
  }
  return {
    tokens: fallback,
    source: 'builtin-fallback',
    reason: 'design-tokens.json is missing from the configured skill roots',
  };
}

function pick(tokens, input) {
  const name = input ?? tokens.defaultTheme;
  const matches = Object.entries(tokens.themes).filter(([id, theme]) =>
    [id, theme.label, ...(theme.aliases ?? [])].includes(name));
  if (matches.length !== 1) {
    const available = Object.entries(tokens.themes)
      .filter(([, theme]) => theme.status !== 'hidden')
      .map(([id, theme]) => `${theme.label} (${id})`).join(', ');
    throw new Error(`Unknown or ambiguous design theme: ${name}; available: ${available}`);
  }
  const [id, theme] = matches[0];
  return {
    id, theme,
    warning: name === 'vital'
      ? 'vital 现映射至 clinical，视觉效果将变化；旧版 PPTX 配色请使用 vital-legacy'
      : null,
  };
}

export async function resolveTheme(name, options = {}) {
  const loaded = await loadTokens(options);
  return { ...pick(loaded.tokens, name), source: loaded.source, reason: loaded.reason };
}

export async function listThemes(options = {}) {
  const loaded = await loadTokens(options);
  return {
    themes: Object.entries(loaded.tokens.themes)
      .filter(([, theme]) => theme.status !== 'hidden')
      .map(([id, theme]) => ({
        id, label: theme.label, aliases: theme.aliases, status: theme.status,
        default: id === loaded.tokens.defaultTheme,
      })),
    source: loaded.source,
    reason: loaded.reason,
  };
}

export async function recommendTheme(features, options = {}) {
  const loaded = await loadTokens(options);
  const tags = new Set((Array.isArray(features) ? features : [features]).filter(Boolean));
  const rule = loaded.tokens.recommend.find(({ match }) => match.some((tag) => tags.has(tag)));
  const selected = pick(loaded.tokens, rule?.theme);
  return { ...selected, recommended: Boolean(rule), source: loaded.source, reason: loaded.reason };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, value] = process.argv.slice(2);
  const result = command === '--list' ? await listThemes()
    : command === '--theme' ? await resolveTheme(value)
      : command === '--recommend' ? await recommendTheme((value ?? '').split(','))
        : null;
  if (!result) {
    console.error('Usage: tokens.mjs <--list|--theme NAME|--recommend tag,tag>');
    process.exitCode = 2;
  } else {
    console.log(JSON.stringify(result));
  }
}
