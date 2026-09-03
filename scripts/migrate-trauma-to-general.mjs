#!/usr/bin/env node

import { existsSync } from 'node:fs';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SOURCE_TYPE_KEY = 'trauma_med';
const TARGET_TYPE_KEY = 'general_med';
const SOURCE_ID_PREFIX = `${SOURCE_TYPE_KEY}-`;
const TARGET_ID_PREFIX = `${TARGET_TYPE_KEY}-`;
const PROJECT_ROOTS = ['projects', 'workspaces', 'memory'];
const TEXT_EXTENSIONS = new Set([
  '.csv', '.html', '.json', '.jsonl', '.log', '.md', '.svg',
  '.toml', '.txt', '.xml', '.yaml', '.yml',
]);

function resolveHome(raw) {
  if (raw === '~') return homedir();
  if (raw.startsWith('~/')) return resolve(homedir(), raw.slice(2));
  return resolve(raw);
}

async function listProjectIds(pilotHome) {
  const ids = new Set();
  for (const root of PROJECT_ROOTS) {
    const typeDir = join(pilotHome, root, SOURCE_TYPE_KEY);
    let entries = [];
    try {
      entries = await readdir(typeDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith(SOURCE_ID_PREFIX)) {
        ids.add(entry.name);
      }
    }
  }
  return [...ids].sort();
}

async function collectTextFiles(root) {
  const files = [];
  if (!existsSync(root)) return files;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      files.push(...await collectTextFiles(path));
    } else if (
      entry.name === '.cwd'
      || TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())
    ) {
      files.push(path);
    }
  }
  return files;
}

function replaceProjectReferences(content, mappings) {
  let next = content;
  for (const mapping of mappings) {
    for (const root of PROJECT_ROOTS) {
      next = next.replaceAll(
        join(mapping.pilotHome, root, SOURCE_TYPE_KEY, mapping.oldId),
        join(mapping.pilotHome, root, TARGET_TYPE_KEY, mapping.newId),
      );
    }
    next = next.replaceAll(mapping.oldId, mapping.newId);
  }
  return next;
}

function globalizeWarTraumaFrontmatter(content) {
  if (!content.startsWith('---\n')) return content;
  const end = content.indexOf('\n---', 4);
  if (end < 0) return content;
  const frontmatter = content.slice(0, end + 1);

  const inline = frontmatter.match(/^availability:\s*\[([^\]]*)\]\s*$/mu);
  if (inline) {
    const values = inline[1].split(',').map((value) => value.trim().replace(/^['"]|['"]$/gu, ''));
    if (values.length === 1 && values[0] === 'war_trauma') {
      return `${frontmatter.replace(inline[0], 'availability:\n  - global')}${content.slice(end + 1)}`;
    }
    return content;
  }

  const block = frontmatter.match(/^availability:\s*\n((?:[ \t]+-[^\n]*(?:\n|$))*)/mu);
  if (!block) return content;
  const values = [...block[1].matchAll(/^[ \t]+-\s*([^#\n]+?)(?:\s+#.*)?$/gmu)]
    .map((match) => match[1].trim().replace(/^['"]|['"]$/gu, ''));
  if (values.length !== 1 || values[0] !== 'war_trauma') return content;
  return `${frontmatter.replace(block[0].trimEnd(), 'availability:\n  - global')}${content.slice(end + 1)}`;
}

async function readWorkspaceState(dbPath) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    const table = db.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'pipeline_state'",
    ).get();
    if (!table) return null;
    const row = db.prepare(
      'SELECT state_json FROM pipeline_state WHERE state_key = ?',
    ).get('workspaceDir');
    return typeof row?.state_json === 'string' ? row.state_json : null;
  } finally {
    db.close();
  }
}

async function writeWorkspaceState(dbPath, stateJson) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(
      'UPDATE pipeline_state SET state_json = ? WHERE state_key = ?',
    ).run(stateJson, 'workspaceDir');
  } finally {
    db.close();
  }
}

async function buildPlan(pilotHome) {
  const projectIds = await listProjectIds(pilotHome);
  const mappings = projectIds.map((oldId) => ({
    pilotHome,
    oldId,
    newId: `${TARGET_ID_PREFIX}${oldId.slice(SOURCE_ID_PREFIX.length)}`,
    moves: [],
  }));

  for (const mapping of mappings) {
    for (const root of PROJECT_ROOTS) {
      const source = join(pilotHome, root, SOURCE_TYPE_KEY, mapping.oldId);
      const target = join(pilotHome, root, TARGET_TYPE_KEY, mapping.newId);
      if (!existsSync(source)) continue;
      if (existsSync(target)) {
        throw new Error(`Refusing migration because target already exists: ${target}`);
      }
      mapping.moves.push({ source, target });
    }
  }

  const changes = [];
  const databaseChanges = [];
  for (const mapping of mappings) {
    for (const move of mapping.moves) {
      for (const sourceFile of await collectTextFiles(move.source)) {
        const original = await readFile(sourceFile, 'utf8');
        let updated = replaceProjectReferences(original, mappings);
        if (sourceFile === join(pilotHome, 'projects', SOURCE_TYPE_KEY, mapping.oldId, 'meta.json')) {
          const meta = JSON.parse(updated);
          meta.id = mapping.newId;
          meta.type = 'general_medicine';
          updated = `${JSON.stringify(meta, null, 2)}\n`;
        } else if (sourceFile === join(pilotHome, 'projects', SOURCE_TYPE_KEY, mapping.oldId, '.cwd')) {
          updated = join(pilotHome, 'workspaces', TARGET_TYPE_KEY, mapping.newId);
        }
        if (updated !== original) {
          changes.push({
            source: sourceFile,
            target: join(move.target, relative(move.source, sourceFile)),
            original,
            updated,
          });
        }
      }
      const sourceDb = join(move.source, 'control.sqlite');
      if (existsSync(sourceDb)) {
        const original = await readWorkspaceState(sourceDb);
        const updated = original === null ? null : replaceProjectReferences(original, mappings);
        if (original !== null && updated !== original) {
          databaseChanges.push({
            source: sourceDb,
            target: join(move.target, 'control.sqlite'),
            original,
            updated,
          });
        }
      }
    }
  }

  const availabilityFile = join(pilotHome, 'skill-availability.json');
  if (existsSync(availabilityFile)) {
    const original = await readFile(availabilityFile, 'utf8');
    const parsed = JSON.parse(original);
    for (const key of Object.keys(parsed)) parsed[key] = ['global'];
    const updated = `${JSON.stringify(parsed, null, 2)}\n`;
    if (updated !== original) {
      changes.push({ source: availabilityFile, target: availabilityFile, original, updated });
    }
  }

  const userSkillsRoot = join(pilotHome, 'skills');
  for (const skillFile of (await collectTextFiles(userSkillsRoot)).filter((file) => file.endsWith('/SKILL.md'))) {
    const original = await readFile(skillFile, 'utf8');
    const updated = globalizeWarTraumaFrontmatter(original);
    if (updated !== original) {
      changes.push({ source: skillFile, target: skillFile, original, updated });
    }
  }

  return { pilotHome, mappings, changes, databaseChanges };
}

async function removeEmptySourceBuckets(pilotHome) {
  for (const root of PROJECT_ROOTS) {
    try {
      await rmdir(join(pilotHome, root, SOURCE_TYPE_KEY));
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY') throw error;
    }
  }
}

export async function runTraumaMigration({ pilotHome, dryRun = false }) {
  const resolvedHome = resolveHome(pilotHome);
  const plan = await buildPlan(resolvedHome);
  const summary = {
    pilotHome: resolvedHome,
    dryRun,
    projects: plan.mappings.map(({ oldId, newId, moves }) => ({
      oldId,
      newId,
      roots: moves.map(({ source }) => relative(resolvedHome, dirname(source)).split('/')[0]),
    })),
    rewrittenFiles: plan.changes.map(({ target }) => relative(resolvedHome, target)),
    rewrittenDatabases: plan.databaseChanges.map(({ target }) => relative(resolvedHome, target)),
  };
  if (dryRun) return summary;

  const completedMoves = [];
  const completedWrites = [];
  const completedDatabaseWrites = [];
  try {
    for (const mapping of plan.mappings) {
      for (const move of mapping.moves) {
        await mkdir(dirname(move.target), { recursive: true });
        await rename(move.source, move.target);
        completedMoves.push(move);
      }
    }
    for (const change of plan.changes) {
      await writeFile(change.target, change.updated, 'utf8');
      completedWrites.push(change);
    }
    for (const change of plan.databaseChanges) {
      await writeWorkspaceState(change.target, change.updated);
      completedDatabaseWrites.push(change);
    }
    await removeEmptySourceBuckets(resolvedHome);

    const reportDir = join(resolvedHome, 'migration-reports');
    await mkdir(reportDir, { recursive: true });
    const reportPath = join(reportDir, `trauma-to-general-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`);
    await writeFile(reportPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    return { ...summary, reportPath };
  } catch (error) {
    for (const change of completedDatabaseWrites.reverse()) {
      await writeWorkspaceState(change.target, change.original).catch(() => {});
    }
    for (const change of completedWrites.reverse()) {
      await writeFile(change.target, change.original, 'utf8').catch(() => {});
    }
    for (const move of completedMoves.reverse()) {
      await mkdir(dirname(move.source), { recursive: true }).catch(() => {});
      await rename(move.target, move.source).catch(() => {});
    }
    throw error;
  }
}

function parseArgs(argv) {
  const dryRun = argv.includes('--dry-run');
  const equalsHome = argv.find((arg) => arg.startsWith('--pilot-home='));
  const homeIndex = argv.indexOf('--pilot-home');
  const pilotHome = equalsHome?.slice('--pilot-home='.length)
    ?? (homeIndex >= 0 ? argv[homeIndex + 1] : null)
    ?? process.env.PILOT_HOME
    ?? join(process.cwd(), '.pilotdeck-home');
  if (!pilotHome || pilotHome.startsWith('--')) {
    throw new Error('--pilot-home requires a path');
  }
  return { pilotHome, dryRun };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runTraumaMigration(parseArgs(process.argv.slice(2)))
    .then((summary) => {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`Migration failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
