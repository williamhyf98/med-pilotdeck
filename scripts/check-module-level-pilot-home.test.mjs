import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { scanForModuleLevelPilotHome, scanFile } from './check-module-level-pilot-home.mjs';

test('flags top-level resolvePilotHome and process.env.PILOT_HOME, ignores in-function use', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scan-'));
  mkdirSync(join(dir, 'ok'));
  writeFileSync(join(dir, 'bad.js'), "import { resolvePilotHome } from './x.js';\nconst HOME = resolvePilotHome(process.env);\nconst M = process.env.PILOT_HOME || '/x';\nexport function f() { return resolvePilotHome(); }\n");
  writeFileSync(join(dir, 'ok', 'good.js'), "export function f() {\n  const home = resolvePilotHome(process.env);\n  return home;\n}\n");
  writeFileSync(join(dir, 'ok', 'good.test.js'), "const HOME = resolvePilotHome(process.env);\n");
  const findings = scanForModuleLevelPilotHome(dir);
  assert.deepEqual(findings.map((f) => `${f.file.replace(dir + '/', '')}:${f.line}`), ['bad.js:2', 'bad.js:3']);
  rmSync(dir, { recursive: true, force: true });
});

test('does not flag function declaration lines with resolvePilotHome default params', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scan-'));
  writeFileSync(join(dir, 'decl.js'), "export function f(a, pilotHome = resolvePilotHome()) {\n  return pilotHome;\n}\nexport async function g(pilotHome = resolvePilotHome()) {}\nfunction h(pilotHome = resolvePilotHome()) {}\nconst BAD = resolvePilotHome();\n");
  const findings = scanForModuleLevelPilotHome(dir);
  assert.deepEqual(findings.map((f) => `${f.file.replace(dir + '/', '')}:${f.line}`), ['decl.js:6']);
  rmSync(dir, { recursive: true, force: true });
});

test('skips utils/pilotPaths.js entirely', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scan-'));
  mkdirSync(join(dir, 'utils'));
  writeFileSync(join(dir, 'utils', 'pilotPaths.js'), "const X = resolvePilotHome();\n");
  assert.deepEqual(scanForModuleLevelPilotHome(dir), []);
  rmSync(dir, { recursive: true, force: true });
});

test('block comments, URLs in comments and strings do not desync brace depth', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scan-'));
  writeFileSync(join(dir, 'tricky.js'), [
    '/**',
    ' * connects to the gateway (default ws://127.0.0.1:18789/ws) and',
    ' * mentions { an unbalanced brace',
    ' */',
    "const URL = 'ws://x (not code {';",
    'const HOME = resolvePilotHome(process.env);',
    "const msg = 'resolvePilotHome( in a string is fine';",
    '',
  ].join('\n'));
  const findings = scanForModuleLevelPilotHome(dir);
  assert.deepEqual(findings.map((f) => `${f.file.replace(dir + '/', '')}:${f.line}`), ['tricky.js:6']);
  rmSync(dir, { recursive: true, force: true });
});

test('regex literals, division and // inside strings do not desync brace depth', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scan-'));
  writeFileSync(join(dir, 'regex.js'), [
    'export function clean(filename) {',
    '  const a = String(filename)',
    '    .replace(/[\\\\/:*?"<>|\\x00-\\x1f]/g, "_")',
    "    .replace(/^\\.+$/, 'download');",
    '  const ratio = a.length / 2 / 3;',
    "  const url = 'http://x/y (';",
    '  if (/^[(]+$/.test(a)) return ratio;',
    '  return typeof a === "string" ? /\\//.test(a) : url;',
    '}',
    'const HOME = resolvePilotHome(process.env);',
    '',
  ].join('\n'));
  const result = scanFile(join(dir, 'regex.js'));
  assert.equal(result.finalDepth, 0);
  assert.equal(result.clamped, false);
  assert.deepEqual(result.findings.map((f) => f.line), [10]);
  rmSync(dir, { recursive: true, force: true });
});

test('reports a file whose brace depth cannot be verified', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scan-'));
  writeFileSync(join(dir, 'open.js'), 'function f() {\n  const x = 1;\n');
  const findings = scanForModuleLevelPilotHome(dir);
  assert.equal(findings.length, 1);
  assert.match(findings[0].text, /scanner lost brace depth \(ended at 1\)/);
  rmSync(dir, { recursive: true, force: true });
});

test('the real ui/server tree is fully verifiable and clean', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  assert.deepEqual(scanForModuleLevelPilotHome(join(repoRoot, 'ui', 'server')), []);
});
