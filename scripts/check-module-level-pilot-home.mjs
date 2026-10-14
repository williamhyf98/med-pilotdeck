import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PATTERN = /resolvePilotHome\s*\(|process\.env\.PILOT_HOME\b/;
// Function declaration lines (e.g. default params `pilotHome = resolvePilotHome()`) are evaluated per call.
const FUNCTION_DECL = /^\s*(export\s+)?(default\s+)?(async\s+)?function\b/;
// The path helper module itself defines resolvePilotHome and is the only allowed place.
const EXEMPT_SUFFIX = `${sep}utils${sep}pilotPaths.js`;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (['.js', '.mjs', '.ts'].includes(extname(name)) && !/\.(test|spec)\.[mc]?[jt]s$/.test(name)) yield full;
  }
}

/**
 * Blank out comments and string/template literal contents while keeping line
 * structure, so URLs like `ws://...` or braces inside strings/comments cannot
 * desync the brace-depth counter. State carries across lines.
 */
function stripCommentsAndStrings(source) {
  const out = [];
  let line = '';
  let state = 'code'; // code | block | single | double | template
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '\n') {
      out.push(line);
      line = '';
      if (state === 'single' || state === 'double') state = 'code'; // unterminated literal
      continue;
    }
    if (state === 'code') {
      if (ch === '/' && next === '/') {
        while (i < source.length && source[i + 1] !== '\n') i += 1;
      } else if (ch === '/' && next === '*') { state = 'block'; i += 1; }
      else if (ch === "'") { state = 'single'; line += ' '; }
      else if (ch === '"') { state = 'double'; line += ' '; }
      else if (ch === '`') { state = 'template'; line += ' '; }
      else line += ch;
    } else if (state === 'block') {
      if (ch === '*' && next === '/') { state = 'code'; i += 1; }
    } else {
      if (ch === '\\') { i += 1; continue; }
      const quote = state === 'single' ? "'" : state === 'double' ? '"' : '`';
      if (ch === quote) state = 'code';
    }
  }
  out.push(line);
  return out;
}

/** Returns findings for PATTERN occurring at brace depth 0 (module scope). */
export function scanForModuleLevelPilotHome(rootDir) {
  const findings = [];
  for (const file of walk(rootDir)) {
    if (file.endsWith(EXEMPT_SUFFIX)) continue;
    const source = readFileSync(file, 'utf8');
    const rawLines = source.split('\n');
    const codeLines = stripCommentsAndStrings(source);
    let depth = 0;
    codeLines.forEach((code, index) => {
      if (depth === 0 && PATTERN.test(code) && !FUNCTION_DECL.test(code)) {
        findings.push({ file, line: index + 1, text: (rawLines[index] ?? '').trim() });
      }
      for (const ch of code) {
        if (ch === '{' || ch === '(') depth += 1;
        else if (ch === '}' || ch === ')') depth = Math.max(0, depth - 1);
      }
    });
  }
  return findings;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = process.argv[2] ?? join(process.cwd(), 'ui', 'server');
  const findings = scanForModuleLevelPilotHome(target);
  if (findings.length) {
    console.error('Module-level PILOT_HOME resolution is not allowed in multi-user code:');
    for (const f of findings) console.error(`  ${f.file}:${f.line}: ${f.text}`);
    process.exit(1);
  }
  console.log(`check-module-level-pilot-home: OK (${target})`);
}
