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

const REGEX_PRECEDERS = new Set('(,=:[!&|?{};+-*%<>~^'.split(''));
const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'delete', 'void',
  'yield', 'await', 'instanceof', 'new', 'throw',
]);
const IDENT_CHAR = /[A-Za-z0-9_$]/;

/**
 * Blank out comments, string/template literal contents and regex literals while
 * keeping line structure, so URLs like `ws://...`, quotes inside regexes or
 * braces inside strings/comments cannot desync the brace-depth counter.
 * State carries across lines. Template `${...}` interpolations are code.
 */
function stripCommentsAndStrings(source) {
  const out = [];
  let line = '';
  let state = 'code'; // code | block | single | double | template | regex
  let inClass = false; // inside [...] of a regex
  const interp = []; // brace depth per open `${` (innermost last)
  let prevSig = ''; // last significant (non-space) code char; '' = none
  let prevWord = ''; // identifier ending at prevSig, if any
  const operand = () => { prevSig = ')'; prevWord = ''; }; // literal => acts like a value
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '\n') {
      out.push(line);
      line = '';
      if (state === 'single' || state === 'double' || state === 'regex') { state = 'code'; inClass = false; operand(); }
      continue;
    }
    if (state === 'code') {
      if (ch === '/' && next === '/') {
        while (i < source.length && source[i + 1] !== '\n') i += 1;
      } else if (ch === '/' && next === '*') { state = 'block'; i += 1; }
      else if (ch === "'") { state = 'single'; line += ' '; }
      else if (ch === '"') { state = 'double'; line += ' '; }
      else if (ch === '`') { state = 'template'; line += ' '; }
      else if (ch === '/' && (prevSig === '' || REGEX_PRECEDERS.has(prevSig) || REGEX_KEYWORDS.has(prevWord))) {
        state = 'regex'; inClass = false; line += ' ';
      } else {
        if (ch === '{' && interp.length) interp[interp.length - 1] += 1;
        if (ch === '}' && interp.length) {
          if (interp[interp.length - 1] === 0) { interp.pop(); state = 'template'; line += ' '; continue; }
          interp[interp.length - 1] -= 1;
        }
        line += ch;
        if (/\s/.test(ch)) continue;
        if (IDENT_CHAR.test(ch)) prevWord = IDENT_CHAR.test(prevSig) ? prevWord + ch : ch;
        else prevWord = '';
        prevSig = ch;
      }
    } else if (state === 'block') {
      if (ch === '*' && next === '/') { state = 'code'; i += 1; }
    } else if (state === 'regex') {
      if (ch === '\\') { i += 1; continue; }
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) { state = 'code'; operand(); }
    } else if (state === 'template') {
      if (ch === '\\') { i += 1; continue; }
      if (ch === '$' && next === '{') { interp.push(0); state = 'code'; prevSig = ''; prevWord = ''; i += 1; }
      else if (ch === '`') { state = 'code'; operand(); }
    } else {
      if (ch === '\\') { i += 1; continue; }
      const quote = state === 'single' ? "'" : '"';
      if (ch === quote) { state = 'code'; operand(); }
    }
  }
  out.push(line);
  return out;
}

/**
 * Scan one file. `finalDepth` != 0 or `clamped` means the scanner lost track
 * of braces, so the file cannot be verified.
 */
export function scanFile(file) {
  const source = readFileSync(file, 'utf8');
  const rawLines = source.split('\n');
  const codeLines = stripCommentsAndStrings(source);
  const findings = [];
  let depth = 0;
  let clamped = false;
  codeLines.forEach((code, index) => {
    if (depth === 0 && PATTERN.test(code) && !FUNCTION_DECL.test(code)) {
      findings.push({ file, line: index + 1, text: (rawLines[index] ?? '').trim() });
    }
    for (const ch of code) {
      if (ch === '{' || ch === '(') depth += 1;
      else if (ch === '}' || ch === ')') {
        if (depth === 0) clamped = true;
        depth = Math.max(0, depth - 1);
      }
    }
  });
  return { findings, finalDepth: depth, clamped };
}

/** Returns findings for PATTERN at module scope, plus one per unverifiable file. */
export function scanForModuleLevelPilotHome(rootDir) {
  const findings = [];
  for (const file of walk(rootDir)) {
    if (file.endsWith(EXEMPT_SUFFIX)) continue;
    const result = scanFile(file);
    findings.push(...result.findings);
    if (result.finalDepth !== 0 || result.clamped) {
      findings.push({
        file,
        line: 0,
        text: `scanner lost brace depth (ended at ${result.finalDepth}${result.clamped ? ', clamped' : ''}) — file cannot be verified`,
      });
    }
  }
  return findings;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = process.argv[2] ?? join(process.cwd(), 'ui', 'server');
  const findings = scanForModuleLevelPilotHome(target);
  if (findings.length) {
    console.error('Module-level PILOT_HOME resolution is not allowed in multi-user code:');
    for (const f of findings) console.error(f.line ? `  ${f.file}:${f.line}: ${f.text}` : `  ${f.file}: ${f.text}`);
    process.exit(1);
  }
  console.log(`check-module-level-pilot-home: OK (${target})`);
}
