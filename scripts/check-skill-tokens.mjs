import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { themesCss } from '../skills/_shared/theme-css.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shared = path.join(repo, 'skills', '_shared');
const tokenPath = process.argv.slice(2).find((arg) => !arg.startsWith('--'))
  ?? path.join(shared, 'design-tokens.json');
const schema = JSON.parse(fs.readFileSync(path.join(shared, 'themes.schema.json'), 'utf8'));
const errors = [];
const warnings = [];
let data;
try {
  data = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
} catch (error) {
  console.error(`Invalid or missing theme file: ${tokenPath}: ${error.message}`);
  process.exit(1);
}

function shape(value, rule, location) {
  if (rule.$ref) {
    const name = rule.$ref.split('/').pop();
    shape(value, schema.$defs[name], location);
    return;
  }
  const types = Array.isArray(rule.type) ? rule.type : rule.type ? [rule.type] : [];
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array'
    : Number.isInteger(value) ? 'integer' : typeof value;
  if (types.length && !types.some((type) => type === actual || (type === 'number' && actual === 'integer'))) {
    errors.push(`${location}: expected ${types.join('|')}, got ${actual}`);
    return;
  }
  if ('const' in rule && value !== rule.const) errors.push(`${location}: expected ${rule.const}`);
  if (rule.enum && !rule.enum.includes(value)) errors.push(`${location}: invalid value ${value}`);
  if (typeof value === 'string') {
    if (rule.minLength && value.length < rule.minLength) errors.push(`${location}: too short`);
    if (rule.pattern && !new RegExp(rule.pattern).test(value)) errors.push(`${location}: invalid format ${value}`);
  }
  if (typeof value === 'number') {
    if (rule.minimum !== undefined && value < rule.minimum) errors.push(`${location}: below ${rule.minimum}`);
    if (rule.maximum !== undefined && value > rule.maximum) errors.push(`${location}: above ${rule.maximum}`);
  }
  if (Array.isArray(value)) {
    if (rule.minItems !== undefined && value.length < rule.minItems) errors.push(`${location}: too few items`);
    if (rule.maxItems !== undefined && value.length > rule.maxItems) errors.push(`${location}: too many items`);
    if (rule.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {
      errors.push(`${location}: duplicate items`);
    }
    if (rule.items) value.forEach((item, index) => shape(item, rule.items, `${location}[${index}]`));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (rule.minProperties !== undefined && Object.keys(value).length < rule.minProperties) {
      errors.push(`${location}: too few properties`);
    }
    for (const key of rule.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push(`${location}.${key}: missing`);
    }
    for (const [key, entry] of Object.entries(value)) {
      const direct = rule.properties?.[key];
      const pattern = Object.entries(rule.patternProperties ?? {})
        .find(([regex]) => new RegExp(regex).test(key))?.[1];
      const child = direct ?? pattern;
      if (child) shape(entry, child, `${location}.${key}`);
      else if (rule.additionalProperties === false) errors.push(`${location}.${key}: invalid key`);
      else warnings.push(`${location}.${key}: unknown field`);
    }
  }
}

function luminance(hex) {
  const components = [0, 2, 4].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return components[0] * 0.2126 + components[1] * 0.7152 + components[2] * 0.0722;
}

function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

function atLeast(name, actual, minimum) {
  if (actual + 0.001 < minimum) errors.push(`${name}: ${actual.toFixed(2)} < ${minimum}`);
}

shape(data, schema, '$');
if (errors.length) {
  for (const warning of warnings) console.warn(`WARN ${warning}`);
  for (const error of errors) console.error(`ERROR ${error}`);
  console.log(JSON.stringify({ status: 'failed', errors: errors.length, warnings: warnings.length }));
  process.exit(1);
}
const publicIds = ['clinical', 'academic', 'trauma', 'archive', 'edu', 'mono'];
const themes = data.themes ?? {};
const semantic = data.semantic ?? {};
const aliases = new Map();
for (const [id, theme] of Object.entries(themes)) {
  for (const name of [id, theme.label, ...(theme.aliases ?? [])]) {
    if (typeof name !== 'string') continue;
    if (aliases.has(name)) errors.push(`duplicate theme name ${name}: ${aliases.get(name)} and ${id}`);
    aliases.set(name, id);
  }
  if (['danger', 'warning', 'success', 'info'].some((key) => Object.hasOwn(theme.colors ?? {}, key))) {
    errors.push(`${id}: semantic colors must not be overridden by the theme`);
  }
  if (theme.status === 'hidden' || !theme.colors) continue;
  const c = theme.colors;
  const values = Object.values(c);
  if (!values.every((value) => typeof value === 'string' && /^[0-9A-F]{6}$/.test(value))) continue;
  atLeast(`${id}.ink/paper`, contrast(c.ink, c.paper), 7);
  atLeast(`${id}.muted/paper`, contrast(c.muted, c.paper), 4.5);
  atLeast(`${id}.primary/paper`, contrast(c.primary, c.paper), 4.5);
  for (const key of ['accent', 'support']) {
    atLeast(`${id}.${key}/paper`, contrast(c[key], c.paper), theme.textUnsafe?.includes(key) ? 3 : 4.5);
  }
  for (const key of ['onPrimary', 'onDark', 'onDarkMuted']) {
    atLeast(`${id}.${key}/primary`, contrast(c[key], c.primary), 4.5);
  }
  atLeast(`${id}.ink/soft`, contrast(c.ink, c.soft), 7);
  atLeast(`${id}.primary/surface`, contrast(c.primary, c.surface), 4.5);
  atLeast(`${id}.surface luminance`, luminance(c.surface), 0.8);
  atLeast(`${id}.paper-soft luminance gap`, Math.abs(luminance(c.paper) - luminance(c.soft)), 0.03);
  const series = theme.chart?.series ?? [];
  if (series.every((value) => typeof value === 'string' && /^[0-9A-F]{6}$/.test(value))) {
    series.forEach((value, index) => atLeast(`${id}.chart.series[${index}]/paper`, contrast(value, c.paper), 3));
    for (let index = 1; index < series.length; index += 1) {
      atLeast(`${id}.chart.series luminance gap ${index - 1}/${index}`,
        Math.abs(luminance(series[index - 1]) - luminance(series[index])), 0.05);
    }
  }
}

for (const id of publicIds) {
  if (themes[id]?.status !== 'stable') errors.push(`${id}: public theme must exist and be stable`);
}
for (const [id, theme] of Object.entries(themes)) {
  if (theme.status !== 'hidden' && !publicIds.includes(id)) errors.push(`${id}: unexpected public theme`);
}
for (const id of ['clinical-legacy', 'vital-legacy']) {
  if (themes[id]?.status !== 'hidden') errors.push(`${id}: hidden rollback theme missing`);
}
if (data.defaultTheme !== 'clinical' || themes[data.defaultTheme]?.status !== 'stable') {
  errors.push('defaultTheme must be the stable clinical theme');
}
if (!themes.clinical?.aliases?.includes('vital')) errors.push('vital must resolve to clinical');
for (const rule of data.recommend ?? []) {
  if (themes[rule.theme]?.status !== 'stable') errors.push(`recommend references unavailable theme: ${rule.theme}`);
}

const locked = {
  danger: { fg: 'B42318', bg: 'FDECEC', onFg: 'FFFFFF' },
  warning: { fg: 'B45309', bg: 'FDF3E3', onFg: 'FFFFFF' },
  success: { fg: '157F3D', bg: 'E9F5EE', onFg: 'FFFFFF' },
  info: { fg: '1F5FA9', bg: 'EAF1FA', onFg: 'FFFFFF' },
};
for (const [role, colors] of Object.entries(locked)) {
  for (const [key, value] of Object.entries(colors)) {
    if (semantic[role]?.[key] !== value) errors.push(`semantic.${role}.${key}: must remain ${value}`);
  }
  if (typeof semantic[role]?.fg === 'string' && /^[0-9A-F]{6}$/.test(semantic[role].fg)) {
    for (const id of publicIds) {
      const paper = themes[id]?.colors?.paper;
      if (typeof paper === 'string' && /^[0-9A-F]{6}$/.test(paper)) {
        atLeast(`semantic.${role}.fg/${id}.paper`, contrast(semantic[role].fg, paper), 4.5);
      }
    }
  }
}

const oldPptx = JSON.parse(fs.readFileSync(path.join(repo, 'skills/pptx/assets/layout-library/design-tokens.json'), 'utf8'));
const legacyKeys = { paper: 'paper', surface: 'white', ink: 'ink', muted: 'muted',
  primary: 'navy', accent: 'accent', support: 'cyan', rule: 'rule' };
for (const [name, oldName] of [['clinical-legacy', 'clinical'], ['vital-legacy', 'vital']]) {
  const old = { ...oldPptx.colors, ...oldPptx.themes[oldName]?.colors };
  for (const [newKey, oldKey] of Object.entries(legacyKeys)) {
    if (themes[name]?.colors?.[newKey] !== old[oldKey]) {
      errors.push(`${name}.${newKey}: differs from the current PPTX ${oldName} color`);
    }
  }
}

if (process.argv.includes('--check-package')) {
  for (const file of ['design-tokens.json', 'themes.schema.json', 'tokens.mjs', 'tokens.py']) {
    if (!fs.existsSync(path.join(shared, file))) errors.push(`package missing skills/_shared/${file}`);
  }
  const themeCssFile = path.join(repo, 'skills/frontend-slides/assets/themes/pd-themes.css');
  for (const relative of [
    'skills/frontend-slides/scripts/html.sh',
    'skills/frontend-slides/scripts/html_audit.py',
    'skills/frontend-slides/scripts/html_package.py',
    'skills/frontend-slides/references/themes.md',
    'skills/_shared/qa/qa_protocol.py',
    'skills/_shared/qa/qa-protocol.schema.json',
    'skills/_shared/qa/README.md',
    'skills/_shared/qa/samples/acceptance.docx.example.json',
    'skills/_shared/qa/samples/review.example.json',
    'skills/_shared/qa/samples/report.example.json',
  ]) {
    if (!fs.existsSync(path.join(repo, relative))) errors.push(`package missing ${relative}`);
  }
  if (!fs.existsSync(themeCssFile)) {
    errors.push('package missing skills/frontend-slides/assets/themes/pd-themes.css');
  } else if (fs.readFileSync(themeCssFile, 'utf8') !== themesCss(data)) {
    errors.push('pd-themes.css is out of date; run node skills/frontend-slides/scripts/build-theme-css.mjs');
  }
  const fonts = path.join(repo, 'skills/pdf/assets/fonts');
  for (const role of ['sans', 'serif']) {
    const file = data.fontRoles?.[role]?.pdfFile;
    if (file && (path.basename(file) !== file || !fs.existsSync(path.join(fonts, file)))) {
      errors.push(`package missing or invalid PDF font ${file}`);
    }
    for (const bundleFile of data.fontRoles?.[role]?.htmlBundle ?? []) {
      if (path.basename(bundleFile) !== bundleFile
          || !fs.existsSync(path.join(shared, 'assets/fonts', bundleFile))) {
        errors.push(`package missing or invalid HTML font ${bundleFile}`);
      }
    }
  }
}

for (const warning of warnings) console.warn(`WARN ${warning}`);
for (const error of errors) console.error(`ERROR ${error}`);
console.log(JSON.stringify({ status: errors.length ? 'failed' : 'ok', themes: Object.keys(themes).length,
  errors: errors.length, warnings: warnings.length }));
if (errors.length) process.exitCode = 1;
