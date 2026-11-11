import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sharedRoot = path.dirname(fileURLToPath(import.meta.url));

// --- 自定义强调色（设计档 A）的对比度门禁 -------------------------------
// 调色板之外只允许"自定义强调色"：用户/模型给一个 hex，系统负责保证它看得清。
// 语义四色（success/warning/danger/info）永远取自 design-tokens.json，不参与自定义。
export const MIN_TEXT_CONTRAST = 4.5; // 正文文字 / 表格文字与其底色
export const MIN_UI_CONTRAST = 3.0; // 色条、实底、大字号、非文字图形
export const MIN_LINE_CONTRAST = 1.5; // 表格边框 / 分隔线（只要求"看得见"）

const HEX6 = /^#?([0-9A-Fa-f]{6})$/;

/** `#1F5FA9` / `1f5fa9` → `1F5FA9`；角色名、3 位缩写、非法值 → null。 */
export function normalizeHex(value) {
  if (typeof value !== 'string') return null;
  const match = HEX6.exec(value.trim());
  return match ? match[1].toUpperCase() : null;
}

function channels(hexValue) {
  return [0, 2, 4].map((index) => Number.parseInt(hexValue.slice(index, index + 2), 16));
}

function linear(channel) {
  const srgb = channel / 255;
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hexValue) {
  const [red, green, blue] = channels(normalizeHex(hexValue) ?? hexValue).map(linear);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** WCAG 2.1 对比度（1.0–21.0）。两侧都必须是 6 位 hex。 */
export function contrastRatio(foreground, background) {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  const [high, low] = first >= second ? [first, second] : [second, first];
  return (high + 0.05) / (low + 0.05);
}

/** 把 `hexValue` 按 `weight` 的比例保留，其余换成 `toward`（与 pdf 的 0.12 口径一致）。 */
export function mixHex(hexValue, toward = 'FFFFFF', weight = 0.12) {
  const front = channels(normalizeHex(hexValue) ?? '000000');
  const back = channels(normalizeHex(toward) ?? 'FFFFFF');
  return front
    .map((value, index) => Math.round(value * weight + back[index] * (1 - weight)))
    .map((value) => value.toString(16).toUpperCase().padStart(2, '0'))
    .join('');
}

/** 在该底色上，黑字和白字哪个更清楚就给哪个。 */
export function onColor(background, dark = '000000', light = 'FFFFFF') {
  const ground = normalizeHex(background) ?? background;
  return contrastRatio(light, ground) >= contrastRatio(dark, ground) ? light : dark;
}

/** 朝黑/白两个方向分档微调，返回第一个达标的颜色；找不到返回 null。 */
export function suggestContrast(value, background, minimum) {
  const color = normalizeHex(value) ?? value;
  const ground = normalizeHex(background) ?? background;
  for (const toward of ['FFFFFF', '000000']) {
    for (let step = 1; step <= 20; step += 1) {
      const candidate = mixHex(color, toward, Math.max(0, 1 - step * 0.05));
      if (contrastRatio(candidate, ground) >= minimum) return candidate;
    }
  }
  return null;
}

/** 校验自定义色；返回规范化 hex，不达标抛错（并给出最近的可通过色）。 */
export function ensureContrast(value, background, minimum, field = '颜色') {
  const color = normalizeHex(value);
  if (!color) throw new Error(`${field} 必须是 6 位 hex（如 #1F5FA9）或角色名，收到 ${JSON.stringify(value)}`);
  const ground = normalizeHex(background);
  if (!ground) throw new Error(`${field} 缺少可比较的底色：${JSON.stringify(background)}`);
  const ratio = contrastRatio(color, ground);
  if (ratio + 1e-9 >= minimum) return color;
  const hint = suggestContrast(color, ground, minimum);
  throw new Error(
    `${field} #${color} 与底色 #${ground} 的对比度只有 ${ratio.toFixed(2)}:1，`
    + `低于要求的 ${minimum}:1${hint ? `；可改用 #${hint}` : ''}`,
  );
}

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
