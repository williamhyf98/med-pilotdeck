/**
 * Deterministic CSS custom-property emitter for HTML delivery.
 *
 * Single source of truth: design-tokens.json. The generated file
 * `skills/frontend-slides/assets/themes/pd-themes.css` is checked into the
 * package so HTML generation never needs Node at runtime.
 */

export const PUBLIC_THEME_ORDER = [
  'clinical',
  'academic',
  'trauma',
  'archive',
  'edu',
  'mono',
];

export const COLOR_KEYS = [
  'paper',
  'surface',
  'ink',
  'muted',
  'primary',
  'accent',
  'support',
  'rule',
  'soft',
  'onPrimary',
  'onDark',
  'onDarkMuted',
];

export const SEMANTIC_KEYS = ['danger', 'warning', 'success', 'info'];

/** REQUIRED_VARS is what html_audit.py enforces when a theme is declared. */
export const REQUIRED_VARS = [
  ...COLOR_KEYS.map((key) => `--pd-${kebab(key)}`),
  ...SEMANTIC_KEYS.flatMap((name) => [`--pd-${name}`, `--pd-${name}-bg`]),
  '--pd-font-body',
  '--pd-font-heading',
  '--pd-font-mono',
];

function kebab(value) {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function fontStack(tokens, role) {
  const entry = tokens.fontRoles?.[role] ?? tokens.fontRoles?.sans;
  return entry?.htmlStack ?? 'system-ui,sans-serif';
}

export function themeBlock(tokens, id) {
  const theme = tokens.themes[id];
  if (!theme) throw new Error(`Unknown theme: ${id}`);
  const colors = theme.colors;
  const typography = theme.typography ?? {};
  const lines = [`html[data-pd-theme="${id}"] {`];
  for (const key of COLOR_KEYS) {
    lines.push(`  --pd-${kebab(key)}: #${colors[key].toUpperCase()};`);
  }
  for (const name of SEMANTIC_KEYS) {
    const semantic = tokens.semantic[name];
    lines.push(`  --pd-${name}: #${semantic.fg.toUpperCase()};`);
    lines.push(`  --pd-${name}-bg: #${semantic.bg.toUpperCase()};`);
  }
  lines.push(`  --pd-font-body: ${fontStack(tokens, typography.bodyRole ?? 'sans')};`);
  lines.push(`  --pd-font-heading: ${fontStack(tokens, typography.headingRole ?? 'sans')};`);
  lines.push(`  --pd-font-mono: ${fontStack(tokens, typography.numericRole ?? 'mono')};`);
  if (typography.headingWeight) lines.push(`  --pd-heading-weight: ${typography.headingWeight};`);
  if (typography.letterSpacing) lines.push(`  --pd-letter-spacing: ${typography.letterSpacing}em;`);
  if (typography.lineHeightScale) lines.push(`  --pd-line-height-scale: ${typography.lineHeightScale};`);
  lines.push('}');
  return lines.join('\n');
}

const BRIDGE = `/* Optional bridge: makes pages that already use the A/B/C density
   variables pick up the chosen theme. Keep the theme block first; later
   page-level overrides still win. */
html[data-pd-theme] {
  --bg: var(--pd-paper);
  --surface: var(--pd-surface);
  --text: var(--pd-ink);
  --muted: var(--pd-muted);
  --border: var(--pd-rule);
  --accent: var(--pd-primary);
  --accent-soft: var(--pd-soft);
  --danger: var(--pd-danger);
  --warning: var(--pd-warning);
}`;

/**
 * Signature components. Each theme's `surface` block picks one treatment per
 * slot, so the same class renders as a hairline masthead for `archive` and a
 * solid band for `academic`. Classes stay opt-in: pages that never use
 * `.pd-masthead` are unaffected.
 */

const MASTHEAD = {
  'rule-line': 'border-top: 3px solid var(--pd-primary); padding-top: 10px;',
  'rule-grid': 'border-top: 1px solid var(--pd-rule); border-bottom: 1px solid var(--pd-rule); padding: 8px 0;',
  'solid-band': 'background: var(--pd-primary); color: var(--pd-on-primary); padding: 10px 14px;',
  hairline: 'border-top: 1px solid var(--pd-rule); padding-top: 8px;',
  none: '',
};

const SECTION_MARKER = {
  'number-accent': 'border-left: 4px solid var(--pd-accent); padding-left: 10px;',
  'number-sidebar': 'border-left: 2px solid var(--pd-primary); padding-left: 12px;',
  'phase-chip': 'display: inline-block; background: var(--pd-soft); border-radius: 999px; padding: 2px 10px;',
  'cn-number': 'font-family: var(--pd-font-heading); letter-spacing: .08em;',
  dot: 'display: flex; align-items: baseline; gap: 8px;',
  plain: '',
};

const TABLE_HEADER = {
  'primary-fill': 'background: var(--pd-primary); color: var(--pd-on-primary);',
  'ink-rule': 'border-bottom: 2px solid var(--pd-ink);',
  'soft-fill': 'background: var(--pd-soft);',
  'ink-fill': 'background: var(--pd-ink); color: var(--pd-on-dark);',
};

const CALLOUT = {
  'left-rule-soft': 'background: var(--pd-soft); border-left: 4px solid var(--pd-accent); padding: 12px 14px;',
  'hairline-box': 'border: 1px solid var(--pd-rule); padding: 12px 14px;',
  'rounded-card': 'background: var(--pd-soft); border-radius: 12px; padding: 14px 16px;',
};

const IMAGING_PANEL = {
  'dark-panel': 'background: var(--pd-primary); color: var(--pd-on-dark); padding: 10px; border-radius: 6px;',
  none: '',
};

const FOOTER = {
  hairline: 'border-top: 1px solid var(--pd-rule); padding-top: 8px; color: var(--pd-muted);',
  none: '',
};

const DOT_MARKER = 'html[data-pd-theme] .pd-section-marker.pd-dot::before{content:"";width:8px;height:8px;'
  + 'border-radius:50%;background:var(--pd-accent);flex:0 0 auto;}';

const STAMP = '.pd-stamp{display:inline-block;border:2px solid var(--pd-accent);color:var(--pd-accent);'
  + 'border-radius:4px;padding:4px 8px;font-family:var(--pd-font-heading);letter-spacing:.12em;}';

function componentRules(tokens, id) {
  const surface = tokens.themes[id]?.surface ?? {};
  const rules = [];
  const push = (selector, body) => {
    if (body) rules.push(`html[data-pd-theme="${id}"] ${selector} { ${body} }`);
  };
  push('.pd-masthead', MASTHEAD[surface.masthead] ?? '');
  push('.pd-section-marker', SECTION_MARKER[surface.sectionMarker] ?? '');
  push('.pd-table thead th', TABLE_HEADER[surface.tableHeader] ?? '');
  push('.pd-callout', CALLOUT[surface.callout] ?? '');
  push('.pd-imaging', IMAGING_PANEL[surface.imagingPanel] ?? '');
  push('.pd-footer', FOOTER[surface.footer] ?? '');
  if (surface.sectionMarker === 'dot') rules.push(DOT_MARKER);
  return rules;
}

export function componentCss(tokens) {
  return [
    '/* Signature components (opt-in classes, driven by the surface tokens). */',
    STAMP,
    ...PUBLIC_THEME_ORDER.flatMap((id) => componentRules(tokens, id)),
  ].join('\n');
}

export function themesCss(tokens) {
  const blocks = PUBLIC_THEME_ORDER.map((id) => themeBlock(tokens, id));
  return [
    '/* GENERATED from skills/_shared/design-tokens.json — do not edit by hand.',
    '   Regenerate with: node skills/frontend-slides/scripts/build-theme-css.mjs',
    '   Use: <html data-pd-theme="clinical"> and inline this file into <style>.',
    '   Single-file delivery: system font stacks only, no external requests. */',
    '',
    blocks.join('\n\n'),
    '',
    BRIDGE,
    '',
    componentCss(tokens),
    '',
  ].join('\n');
}
