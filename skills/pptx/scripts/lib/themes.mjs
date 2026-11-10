import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { skillRoot } from './runtime.mjs';

const LEGACY_KEYS = {
  paper: 'paper', surface: 'white', ink: 'ink', muted: 'muted',
  primary: 'navy', accent: 'accent', support: 'cyan', rule: 'rule',
};

let cachedReader;

async function sharedReader() {
  if (cachedReader !== undefined) return cachedReader;
  const roots = [
    process.env.PILOTDECK_BUNDLED_SKILLS_DIR,
    path.dirname(skillRoot()),
  ].filter(Boolean);
  for (const root of new Set(roots.map((value) => path.resolve(value)))) {
    const modulePath = path.join(root, '_shared/tokens.mjs');
    try {
      await fs.access(modulePath);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const module = await import(pathToFileURL(modulePath).href);
    const loaded = await module.loadTokens({ bundledSkillsRoot: root, skillRoot: skillRoot() });
    cachedReader = { root, module, loaded };
    return cachedReader;
  }
  cachedReader = null;
  return null;
}

/**
 * Resolve a theme name through the shared reader. Returns null when the shared
 * data is unavailable so callers can fall back to the bundled legacy palettes.
 */
export async function resolveSharedTheme(name) {
  const reader = await sharedReader();
  if (!reader) return null;
  const selected = await reader.module.resolveTheme(name, {
    bundledSkillsRoot: reader.root,
    skillRoot: skillRoot(),
  });
  return { ...selected, tokens: reader.loaded.tokens, fallback: reader.loaded.reason };
}

export async function listSharedThemes() {
  const reader = await sharedReader();
  if (!reader) return null;
  const listed = await reader.module.listThemes({
    bundledSkillsRoot: reader.root,
    skillRoot: skillRoot(),
  });
  return {
    themes: listed.themes.map(({ id, label, aliases }) => {
      const selected = {
        theme: reader.loaded.tokens.themes[id],
        tokens: reader.loaded.tokens,
      };
      return {
        name: id, label, aliases,
        default: id === reader.loaded.tokens.defaultTheme,
        colors: themeTokens(selected).colors,
      };
    }),
    source: listed.source,
  };
}

/**
 * Map the semantic theme onto the legacy PPTX palette keys the layouts read.
 * Hidden legacy themes deliberately keep the old hardcoded on-dark colors, so
 * their output stays byte-identical to the pre-theme decks.
 */
export function themeTokens(resolved) {
  const { theme, tokens } = resolved;
  const legacy = theme.status === 'hidden';
  const colors = {};
  for (const [semantic, old] of Object.entries(LEGACY_KEYS)) colors[old] = theme.colors[semantic];
  colors.positive = tokens.semantic.success.fg;
  colors.negative = tokens.semantic.danger.fg;
  if (!legacy) {
    colors.onDark = theme.colors.onDark;
    colors.onDarkMuted = theme.colors.onDarkMuted;
    colors.soft = theme.colors.soft;
    colors.rule = theme.colors.rule;
  }
  return { colors, legacy };
}

export function themeFonts(tokens, theme) {
  const { fontRoles } = tokens;
  const heading = fontRoles[theme.typography.headingRole] ?? fontRoles.sans;
  const body = fontRoles[theme.typography.bodyRole] ?? fontRoles.sans;
  // OOXML carries a font *name*, never a font file, so the name has to exist on
  // the machine that opens the deck. `officeWindows` is the only role we know is
  // present on every target: Windows ships it, and Office for Mac bundles the
  // same files (msyh.ttc / Simsun.ttc / Consola.ttf). `libreOffice` names are
  // kept for the server-side renderer, where fontconfig aliases them.
  const pick = (role) => role.officeWindows ?? role.libreOffice;
  return { head: pick(heading), body: pick(body), role: theme.typography.headingRole };
}
