#!/usr/bin/env node
/**
 * Target-platform preflight for an offline deployment.
 *
 * Run this **on the machine that will host PilotDeck** (or on the Office
 * Renderer host). It answers three questions the skills cannot answer alone:
 *
 *   1. Do the font names we write into DOCX/PPTX/XLSX resolve to a Chinese
 *      face here, or do they silently fall back to a Japanese/Korean variant?
 *   2. Are the runtimes the skills need (node, python3) present?
 *   3. Is the Office Renderer reachable, and is `pdffonts` available so a
 *      rendered PDF can be inspected afterwards?
 *
 * Usage:
 *   node scripts/platform-preflight.mjs
 *   node scripts/platform-preflight.mjs --json --renderer http://10.0.0.5:19400
 *   node scripts/platform-preflight.mjs --fonts "SimSun,Noto Serif CJK SC"
 */

import { execFile } from 'node:child_process';
import os from 'node:os';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Font families the skills actually write into OOXML, plus the renderer-side
 * families we recommend installing. `expectsSc` marks families whose correct
 * resolution must be a Simplified-Chinese face.
 */
export const REQUIRED_FONTS = [
  { name: 'Microsoft YaHei', role: 'sans (written into DOCX/PPTX/XLSX)', expectsSc: true },
  { name: 'SimSun', role: 'serif (written into DOCX/PPTX/XLSX)', expectsSc: true, expectsSerif: true },
  { name: 'Consolas', role: 'mono (numeric role)', expectsSc: false },
  { name: 'Noto Sans CJK SC', role: 'renderer sans (fontconfig alias for Microsoft YaHei)', expectsSc: true },
  { name: 'Noto Serif CJK SC', role: 'renderer serif (fontconfig alias for SimSun)', expectsSc: true, expectsSerif: true },
];

const CJK_VARIANTS = /\b(?:jp|tc|kr|hk)\b|CJK\s?(?:JP|TC|KR|HK)|Noto\s?(?:Sans|Serif)\s?CJK\s?(?:JP|TC|KR|HK)/i;
const CJK_ANY = /noto\s(?:sans|serif)\s(cjk|sc|tc|jp|kr|hk)|source han|wenquanyi|simsun|simhei|yahei|pingfang|songti/i;
const SERIF_FACE = /serif|song|sung|ming|simsun|宋/i;

const MONO_HINT = {
  linux: '安装 fonts-dejavu-core（DejaVu Sans Mono）或把 Consolas 别名指向它',
  darwin: 'macOS 用 Menlo 即可，本项只影响等宽数字对齐',
};
const CJK_HINT = {
  linux: '安装 fonts-noto-cjk 并把 LANG/LC_ALL 设为 zh_CN.UTF-8，'
    + '或用 fontconfig 别名把该名字指向 Noto Sans CJK SC / Noto Serif CJK SC',
  darwin: 'macOS 请确认目标机装有 PingFang SC / Songti SC；本机缺字体只影响本地预览',
};

function hintFor(table, platformName) {
  return table[platformName] ?? table.linux;
}

function classify(requested, resolvedFamily, resolvedFile, entry = {}, platformName = process.platform) {
  const family = String(resolvedFamily ?? '').trim();
  const file = String(resolvedFile ?? '').trim();
  if (!family) {
    return { level: 'error', code: 'font-unresolved', message: `${requested} 没有任何字体可以匹配` };
  }
  const same = family.split(',')[0].trim().toLowerCase() === requested.trim().toLowerCase();
  if (same) return { level: 'ok', code: 'font-exact', message: `${requested} → ${family}` };
  if (entry.expectsSc === false) {
    return {
      level: CJK_ANY.test(family) || /mono|courier|consol|menlo/i.test(`${family}${file}`)
        ? 'ok' : 'warning',
      code: /mono|courier|consol|menlo/i.test(`${family}${file}`) ? 'font-substituted' : 'no-mono-face',
      message: `${requested} → ${family}；${/mono|courier|consol|menlo/i.test(`${family}${file}`)
        ? '等宽角色可接受' : hintFor(MONO_HINT, platformName)}`,
    };
  }
  if (CJK_VARIANTS.test(family)) {
    return {
      level: 'warning',
      code: 'cjk-variant-mismatch',
      message: `${requested} 被解析成 ${family}（日/韩/繁体字形）；${hintFor(CJK_HINT, platformName)}`,
    };
  }
  if (!CJK_ANY.test(family) && !CJK_ANY.test(file)) {
    return {
      level: 'warning',
      code: 'no-cjk-face',
      message: `${requested} 被解析成 ${family}（不是中文字体），中文会走二次回退；${hintFor(CJK_HINT, platformName)}`,
    };
  }
  if (entry.expectsSerif && !SERIF_FACE.test(family)) {
    return {
      level: 'warning',
      code: 'serif-lost',
      message: `${requested} 需要衬线，但被解析成 ${family}（无衬线），主题里的衬线气质会丢失；`
        + `${hintFor(CJK_HINT, platformName)}`,
    };
  }
  // A简体 face of the right style is the substitution we want on Linux.
  return { level: 'ok', code: 'font-substituted', message: `${requested} → ${family}（可接受的替代）` };
}

async function run(command, args, options = {}) {
  try {
    const { stdout } = await execFileAsync(command, args, { timeout: 8000, ...options });
    return { ok: true, stdout: String(stdout ?? '') };
  } catch (error) {
    return { ok: false, stdout: String(error?.stdout ?? ''), error: error?.code ?? 'failed' };
  }
}

async function checkFont(entry, runtime) {
  const probe = await runtime.run('fc-match', ['-f', '%{family}|%{file}', entry.name]);
  if (!probe.ok) {
    return {
      ...entry,
      status: 'unknown',
      resolved: null,
      code: 'fontconfig-missing',
      message: '本机没有 fc-match，无法判断字体解析结果；请在有 fontconfig 的机器上复跑，或人工核对',
    };
  }
  const [family, file] = probe.stdout.split('|');
  const verdict = classify(entry.name, family, file, entry, runtime.platform ?? process.platform);
  return {
    ...entry,
    status: verdict.level,
    resolved: { family: (family ?? '').trim(), file: (file ?? '').trim() },
    code: verdict.code,
    message: verdict.message,
  };
}

async function checkRenderer(url, runtime) {
  if (!url) {
    return { configured: false, status: 'skipped', message: '未配置 Office Renderer；渲染、跨页与字体实测都会被跳过' };
  }
  const probe = await runtime.fetch(url, { method: 'GET', signal: AbortSignal.timeout(5000) });
  if (probe.ok) {
    return { configured: true, status: 'ok', url, message: `Office Renderer 可达（HTTP ${probe.status}）` };
  }
  return {
    configured: true,
    status: 'error',
    url,
    code: 'renderer-unreachable',
    message: `Office Renderer 不可达：${probe.error ?? 'no response'}；渲染类验收会被跳过，不能当作通过`,
  };
}

function parseArgs(argv) {
  const options = { json: false, renderer: process.env.PILOTDECK_OFFICE_RENDERER_URL ?? '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--renderer') options.renderer = argv[++index] ?? '';
    else if (arg.startsWith('--renderer=')) options.renderer = arg.slice('--renderer='.length);
    else if (arg === '--fonts') options.fonts = String(argv[++index] ?? '').split(',').map((v) => v.trim()).filter(Boolean);
    else if (arg.startsWith('--fonts=')) options.fonts = arg.slice('--fonts='.length).split(',').map((v) => v.trim()).filter(Boolean);
  }
  return options;
}

export async function preflight(options = {}) {
  const runtime = options.runtime ?? {
    run,
    fetch: (url, init) => globalThis.fetch(url, init).then(
      (response) => ({ ok: true, status: response.status }),
      (error) => ({ ok: false, error: error?.message ?? String(error) }),
    ),
  };
  const fonts = (options.fonts?.length ? options.fonts : REQUIRED_FONTS.map((item) => item.name))
    .map((name) => REQUIRED_FONTS.find((item) => item.name === name) ?? { name, role: 'custom' });

  const [nodeProbe, pythonProbe, pdffontsProbe] = await Promise.all([
    runtime.run('node', ['--version']),
    runtime.run('python3', ['--version']),
    runtime.run('pdffonts', ['-v']),
  ]);
  const fontResults = [];
  for (const entry of fonts) fontResults.push(await checkFont(entry, runtime));
  const renderer = await checkRenderer(options.renderer, runtime);

  const issues = [];
  if (!pythonProbe.ok) {
    issues.push({ level: 'error', code: 'python-missing', message: '缺少 python3：DOCX/XLSX/PDF/图示/HTML 审计都无法运行' });
  }
  if (!nodeProbe.ok) {
    issues.push({ level: 'error', code: 'node-missing', message: '缺少 node：PPTX/XLSX 生成与技能运行时无法启动' });
  }
  for (const item of fontResults) {
    if (item.status === 'error' || item.status === 'warning') {
      issues.push({ level: item.status, code: item.code, message: item.message });
    } else if (item.status === 'unknown') {
      issues.push({ level: 'warning', code: item.code, message: item.message });
    }
  }
  if (renderer.status === 'error') issues.push({ level: 'error', code: renderer.code, message: renderer.message });

  const errors = issues.filter((item) => item.level === 'error').length;
  const warnings = issues.filter((item) => item.level === 'warning').length;
  return {
    status: errors ? 'error' : (warnings ? 'warning' : 'ok'),
    platform: {
      os: process.platform,
      arch: process.arch,
      release: os.release(),
      lang: process.env.LANG ?? process.env.LC_ALL ?? null,
    },
    tools: {
      node: nodeProbe.ok ? nodeProbe.stdout.trim().replace(/^v/, '') : null,
      python3: pythonProbe.ok ? pythonProbe.stdout.trim() : null,
      pdffonts: pdffontsProbe.ok,
    },
    fonts: fontResults,
    renderer,
    issues,
    counts: { errors, warnings },
    visual_acceptance: 'not_performed',
  };
}

function printHuman(report) {
  const lines = [];
  lines.push(`平台：${report.platform.os}/${report.platform.arch}  LANG=${report.platform.lang ?? '(未设置)'}`);
  lines.push(`运行时：node=${report.tools.node ?? '缺失'}  python3=${report.tools.python3 ?? '缺失'}  pdffonts=${report.tools.pdffonts ? 'ok' : '缺失'}`);
  lines.push('字体：');
  for (const font of report.fonts) {
    const mark = font.status === 'ok' ? '✓' : font.status === 'warning' ? '!' : font.status === 'unknown' ? '?' : '×';
    lines.push(`  ${mark} ${font.name} → ${font.resolved?.family ?? '(未解析)'}   ${font.message ?? ''}`);
  }
  lines.push(`Renderer：${report.renderer.message}`);
  lines.push(`结论：${report.status}（error ${report.counts.errors} / warning ${report.counts.warnings}）`);
  return lines.join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await preflight(options);
  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(`${printHuman(report)}\n`);
  process.exitCode = report.counts.errors ? 2 : 0;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
