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
  if (!accent) return tokens;
  return { ...tokens, colors: { ...tokens.colors, accent } };
}
