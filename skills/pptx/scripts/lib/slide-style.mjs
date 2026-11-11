/**
 * Per-slide style hooks.
 *
 * The layout library reads every colour from `tokens.colors`, so a per-slide
 * emphasis colour can be expressed as a derived token object instead of
 * patching 16 layout functions.
 */

/** 语义角色 → 版式库实际读取的颜色键。 */
const ROLE_KEYS = {
  accent: 'accent',
  support: 'cyan',
  primary: 'navy',
  success: 'positive',
  danger: 'negative',
};

export const SLIDE_ACCENT_ROLES = Object.keys(ROLE_KEYS);

/** 这些版式本身就是深底（封面/章节/结尾），不需要也不能再"变深"。 */
const ALREADY_DARK = new Set(['title', 'section', 'closing']);

export const SLIDE_TONES = ['light', 'dark'];

function parseHex(value) {
  const text = String(value ?? '').replace('#', '').trim();
  if (!/^[0-9A-Fa-f]{6}$/u.test(text)) return null;
  return [0, 2, 4].map((index) => parseInt(text.slice(index, index + 2), 16));
}

function toHex(rgb) {
  return rgb.map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** `weight` 是 foreground 的占比：1 = 全 foreground，0 = 全 background。 */
export function mixColor(foreground, background, weight) {
  const front = parseHex(foreground);
  const back = parseHex(background);
  if (!front || !back) return foreground;
  return toHex([0, 1, 2].map((index) => front[index] * weight + back[index] * (1 - weight)));
}

function luminance(hex) {
  const rgb = parseHex(hex);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map((value) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a, b) {
  const first = luminance(a);
  const second = luminance(b);
  const [light, dark] = first >= second ? [first, second] : [second, first];
  return (light + 0.05) / (dark + 0.05);
}

function rgbToHsl([r, g, b]) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const delta = max - min;
  if (!delta) return [0, 0, l];
  const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let h;
  if (max === r) h = (g - b) / delta + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / delta + 2;
  else h = (r - g) / delta + 4;
  return [h / 6, s, l];
}

function hslToRgb([h, s, l]) {
  if (!s) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t) => {
    let value = (t + 1) % 1;
    if (value < 1 / 6) return p + (q - p) * 6 * value;
    if (value < 1 / 2) return q;
    if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
    return p;
  };
  return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)];
}

/**
 * 深底上太暗的前景色：**保住色相和饱和度**、只抬亮度，直到达标。
 * 不用「混白」，否则"风险红"会被冲成粉灰，语义就丢了。
 */
function ensureContrast(color, background, minimum) {
  const rgb = parseHex(color);
  if (!rgb) return color;
  if (contrastRatio(color, background) >= minimum) return color;
  const [h, s, start] = rgbToHsl(rgb.map((value) => value / 255));
  let lightness = start;
  let current = color;
  while (lightness < 0.88) {
    lightness += 0.05;
    current = toHex(hslToRgb([h, s, lightness]).map((value) => value * 255));
    if (contrastRatio(current, background) >= minimum) return current;
  }
  return current;
}

function darkTokens(tokens, accentOverride) {
  const colors = tokens.colors ?? {};
  const background = colors.navy ?? colors.primary ?? '12404F';
  const text = colors.onDark ?? 'FFFFFF';
  const textMuted = colors.onDarkMuted ?? mixColor(text, background, 0.22);
  const accent = ensureContrast(accentOverride ?? colors.accent ?? text, background, 3.5);
  const surface = mixColor(text, background, 0.07);
  return {
    ...tokens,
    colors: {
      ...colors,
      // 背景 / 表面
      paper: background,
      white: background,
      surface,
      // 文字
      ink: text,
      muted: textMuted,
      // 线
      rule: mixColor(text, background, 0.3),
      soft: mixColor(text, background, 0.18),
      // 强调：深底上太暗的色会被提亮，保证可读
      navy: text,
      accent,
      cyan: ensureContrast(colors.cyan ?? accent, background, 3.5),
      positive: ensureContrast(colors.positive ?? accent, background, 3.5),
      negative: ensureContrast(colors.negative ?? accent, background, 3.5),
    },
  };
}

export function resolveSlideAccent(tokens, value) {
  if (value === undefined || value === null || value === '') return null;
  const role = String(value).trim().toLowerCase();
  const key = ROLE_KEYS[role];
  if (!key) {
    throw new Error(
      `Unsupported slide accent ${JSON.stringify(value)}; use ${SLIDE_ACCENT_ROLES.join(', ')}`,
    );
  }
  const color = tokens?.colors?.[key];
  if (!color) {
    throw new Error(`Slide accent ${JSON.stringify(value)} is unavailable for this theme`);
  }
  return color;
}

/**
 * 返回该页生效的 token：只在 `slide.accent` 存在时替换强调色，
 * 其余颜色与版式完全继承主题，保证"局部强调、整体不变"。
 */
export function tokensForSlide(tokens, slide = {}) {
  const accent = resolveSlideAccent(tokens, slide.accent);
  const tone = slide.tone === undefined || slide.tone === null
    ? 'light'
    : String(slide.tone).trim().toLowerCase();
  if (!SLIDE_TONES.includes(tone)) {
    throw new Error(`Unsupported slide tone ${JSON.stringify(slide.tone)}; use ${SLIDE_TONES.join(', ')}`);
  }
  if (tone === 'dark') {
    if (ALREADY_DARK.has(String(slide.type ?? ''))) {
      throw new Error(
        `tone 'dark' is not applicable to ${slide.type} slides; they are already dark`,
      );
    }
    return darkTokens(tokens, accent);
  }
  if (!accent) return tokens;
  return { ...tokens, colors: { ...tokens.colors, accent } };
}
