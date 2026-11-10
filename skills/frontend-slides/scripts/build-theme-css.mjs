#!/usr/bin/env node
/**
 * Generate or verify skills/frontend-slides/assets/themes/pd-themes.css
 * from skills/_shared/design-tokens.json.
 *
 * Usage:
 *   node build-theme-css.mjs          # write the file
 *   node build-theme-css.mjs --check  # exit 1 if the file is out of date
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { themesCss } from '../../_shared/theme-css.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const skill = path.resolve(here, '..');
const tokensFile = path.resolve(skill, '../_shared/design-tokens.json');
const outputFile = path.join(skill, 'assets/themes/pd-themes.css');

const tokens = JSON.parse(await readFile(tokensFile, 'utf8'));
const expected = themesCss(tokens);

if (process.argv.includes('--check')) {
  let actual;
  try {
    actual = await readFile(outputFile, 'utf8');
  } catch (error) {
    console.error(`missing ${path.relative(process.cwd(), outputFile)}: ${error.message}`);
    process.exit(1);
  }
  if (actual !== expected) {
    console.error('pd-themes.css is out of date; run node skills/frontend-slides/scripts/build-theme-css.mjs');
    process.exit(1);
  }
  console.log(JSON.stringify({ status: 'ok', file: outputFile, bytes: Buffer.byteLength(expected) }));
} else {
  await writeFile(outputFile, expected);
  console.log(JSON.stringify({ status: 'ok', written: outputFile, bytes: Buffer.byteLength(expected) }));
}
