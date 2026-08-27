#!/usr/bin/env node
/**
 * Idempotent migration: nest projects/workspaces/memory under type keys
 * (general_med / trauma_med) and rename sys-* / legacy residual into that layout.
 *
 * Usage:
 *   node scripts/migrate-typed-projects.mjs [--pilot-home PATH] [--dry-run]
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { cp } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const META_TYPE_TO_KEY = {
  general_medicine: 'general_med',
  war_trauma: 'trauma_med',
};
const TYPE_KEYS = new Set(Object.values(META_TYPE_TO_KEY));
const DEFAULT_TYPE_KEY = 'general_med';
const DEFAULT_META_TYPE = 'general_medicine';
const LEGACY_GENERAL_ID = 'general_med-legacy-general';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const pilotHomeArg = args.find((a) => a.startsWith('--pilot-home='))?.split('=')[1]
  ?? (args.includes('--pilot-home') ? args[args.indexOf('--pilot-home') + 1] : null);

function resolvePilotHome() {
  const raw = pilotHomeArg ?? process.env.PILOT_HOME ?? join(process.cwd(), '.pilotdeck-home');
  if (raw === '~') return homedir();
  if (raw.startsWith('~/')) return resolve(homedir(), raw.slice(2));
  return resolve(raw);
}

function ensureDir(dir) {
  if (dryRun) return;
  mkdirSync(dir, { recursive: true });
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(filePath, value) {
  if (dryRun) return;
  ensureDir(dirname(filePath));
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function typeKeyFromProjectId(projectId) {
  if (projectId.startsWith('general_med-')) return 'general_med';
  if (projectId.startsWith('trauma_med-')) return 'trauma_med';
  return null;
}

function typeKeyFromMeta(meta) {
  if (meta?.type && META_TYPE_TO_KEY[meta.type]) {
    return META_TYPE_TO_KEY[meta.type];
  }
  return null;
}

function slugifyPath(projectRoot) {
  const normalized = projectRoot.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');
  return normalized.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
}

async function moveTree(src, dest, report, label) {
  if (!existsSync(src)) return false;
  if (resolve(src) === resolve(dest)) {
    report.skipped.push({ reason: 'same-path', src, dest });
    return false;
  }
  if (existsSync(dest)) {
    report.skipped.push({ reason: 'dest-exists', src, dest, label });
    return false;
  }
  report.moved.push({ from: src, to: dest, label });
  if (dryRun) return true;
  ensureDir(dirname(dest));
  try {
    renameSync(src, dest);
  } catch {
    await cp(src, dest, { recursive: true, force: false });
    rmSync(src, { recursive: true, force: true });
  }
  return true;
}

function allocateLegacyId(prefix, used) {
  for (let i = 0; i < 8; i += 1) {
    const id = `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
    if (!used.has(id)) {
      used.add(id);
      return id;
    }
  }
  throw new Error('Failed to allocate legacy project id');
}

function newIdForSys(oldId, typeKey) {
  if (oldId.startsWith('sys-')) {
    return `${typeKey}-${oldId.slice('sys-'.length)}`;
  }
  if (typeKeyFromProjectId(oldId) === typeKey) return oldId;
  return `${typeKey}-${oldId}`;
}

function collectFlatProjectIds(projectsRoot) {
  if (!existsSync(projectsRoot)) return [];
  return readdirSync(projectsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !TYPE_KEYS.has(e.name))
    .map((e) => e.name);
}

function collectTypedProjectIds(projectsRoot) {
  const ids = new Set();
  if (!existsSync(projectsRoot)) return ids;
  for (const typeKey of TYPE_KEYS) {
    const typeDir = join(projectsRoot, typeKey);
    if (!existsSync(typeDir)) continue;
    for (const entry of readdirSync(typeDir, { withFileTypes: true })) {
      if (entry.isDirectory()) ids.add(entry.name);
    }
  }
  return ids;
}

function ensureWorkspaceLayout(workspaceRoot) {
  for (const rel of ['inbox', 'exports', 'scratch/qa', 'scratch/work', 'scratch/preview', 'scratch/tool-results']) {
    ensureDir(join(workspaceRoot, ...rel.split('/')));
  }
}

async function migrateSysOrTypedFlat(pilotHome, report, usedIds) {
  const projectsRoot = join(pilotHome, 'projects');
  const workspacesRoot = join(pilotHome, 'workspaces');

  for (const oldId of collectFlatProjectIds(projectsRoot)) {
    const oldProjectDir = join(projectsRoot, oldId);
    const metaPath = join(oldProjectDir, 'meta.json');
    const meta = readJson(metaPath);
    const fromMeta = typeKeyFromMeta(meta);
    const isSys = oldId.startsWith('sys-') || meta?.kind === 'system';

    // Already-prefixed but still flat (partial migrate) → nest only.
    const existingTypeKey = typeKeyFromProjectId(oldId);
    if (existingTypeKey) {
      const destProject = join(projectsRoot, existingTypeKey, oldId);
      const destWorkspace = join(workspacesRoot, existingTypeKey, oldId);
      await moveTree(oldProjectDir, destProject, report, 'nest-typed-project');
      const oldWs = join(workspacesRoot, oldId);
      if (existsSync(oldWs)) {
        await moveTree(oldWs, destWorkspace, report, 'nest-typed-workspace');
      }
      const cwdPath = join(destProject, '.cwd');
      if (existsSync(destProject) || dryRun) {
        report.updated.push({ file: cwdPath, to: destWorkspace });
        if (!dryRun && existsSync(destProject)) {
          writeFileSync(cwdPath, destWorkspace, 'utf8');
          if (meta) {
            writeJson(join(destProject, 'meta.json'), { ...meta, id: oldId });
          }
        }
      }
      usedIds.add(oldId);
      continue;
    }

    if (!isSys && !fromMeta) {
      // Path-linked residual → general_med (handled in migratePathResiduals).
      continue;
    }

    const typeKey = fromMeta || DEFAULT_TYPE_KEY;
    const newId = newIdForSys(oldId, typeKey);
    const destProject = join(projectsRoot, typeKey, newId);
    const destWorkspace = join(workspacesRoot, typeKey, newId);
    if (existsSync(destProject) && newId !== oldId) {
      report.errors.push({ oldId, newId, error: 'target id already used' });
      continue;
    }
    usedIds.add(newId);

    const oldWs = join(workspacesRoot, oldId);

    await moveTree(oldProjectDir, destProject, report, 'sys-project');
    if (existsSync(oldWs)) {
      await moveTree(oldWs, destWorkspace, report, 'sys-workspace');
    } else {
      ensureDir(destWorkspace);
      ensureWorkspaceLayout(destWorkspace);
      report.created.push({ dir: destWorkspace, label: 'workspace-layout' });
    }

    const nextMeta = {
      ...(meta || {}),
      id: newId,
      displayName: meta?.displayName || oldId,
      type: meta?.type || DEFAULT_META_TYPE,
      kind: meta?.kind || 'system',
      status: meta?.status || 'active',
      createdAt: meta?.createdAt || new Date().toISOString(),
      migratedFrom: oldId,
    };
    report.updated.push({ file: join(destProject, 'meta.json'), id: newId });
    report.updated.push({ file: join(destProject, '.cwd'), to: destWorkspace });
    if (!dryRun) {
      writeJson(join(destProject, 'meta.json'), nextMeta);
      writeFileSync(join(destProject, '.cwd'), destWorkspace, 'utf8');
      ensureDir(join(destProject, 'chats'));
      ensureWorkspaceLayout(destWorkspace);
    }
  }
}

async function migratePathResiduals(pilotHome, report, usedIds) {
  const projectsRoot = join(pilotHome, 'projects');
  const workspacesRoot = join(pilotHome, 'workspaces');
  const homeSlug = slugifyPath(pilotHome);

  for (const oldId of collectFlatProjectIds(projectsRoot)) {
    if (TYPE_KEYS.has(oldId)) continue;
    if (typeKeyFromProjectId(oldId)) continue;
    if (oldId.startsWith('sys-')) continue;

    const oldProjectDir = join(projectsRoot, oldId);
    const meta = readJson(join(oldProjectDir, 'meta.json'));
    if (meta?.kind === 'system' || typeKeyFromMeta(meta)) {
      continue;
    }

    // Home-slug chats belong to the single legacy general project.
    if (oldId === homeSlug || oldId === `${homeSlug}`) {
      continue;
    }

    const typeKey = DEFAULT_TYPE_KEY;
    let newId = `${typeKey}-${oldId}`;
    if (usedIds.has(newId)) {
      newId = allocateLegacyId(`${typeKey}-path`, usedIds);
    } else {
      usedIds.add(newId);
    }

    const destProject = join(projectsRoot, typeKey, newId);
    const destWorkspace = join(workspacesRoot, typeKey, newId);
    const oldWs = join(workspacesRoot, oldId);
    let markerCwd = null;
    try {
      markerCwd = readFileSync(join(oldProjectDir, '.cwd'), 'utf8').trim();
    } catch {
      markerCwd = null;
    }

    await moveTree(oldProjectDir, destProject, report, 'path-project');
    if (existsSync(oldWs)) {
      await moveTree(oldWs, destWorkspace, report, 'path-workspace');
    } else {
      ensureDir(destWorkspace);
      ensureWorkspaceLayout(destWorkspace);
    }

    const nextMeta = {
      id: newId,
      displayName: meta?.displayName || basename(markerCwd || oldId),
      type: DEFAULT_META_TYPE,
      kind: 'system',
      status: 'active',
      createdAt: meta?.createdAt || new Date().toISOString(),
      migratedFrom: oldId,
      legacyLinkedPath: markerCwd || undefined,
    };
    report.updated.push({ file: join(destProject, 'meta.json'), id: newId });
    if (!dryRun) {
      writeJson(join(destProject, 'meta.json'), nextMeta);
      writeFileSync(join(destProject, '.cwd'), destWorkspace, 'utf8');
      ensureDir(join(destProject, 'chats'));
      ensureWorkspaceLayout(destWorkspace);
    }
  }
}

async function migrateLegacyGeneral(pilotHome, report, usedIds) {
  const projectsRoot = join(pilotHome, 'projects');
  const workspacesRoot = join(pilotHome, 'workspaces');
  const homeSlug = slugifyPath(pilotHome);
  const typeKey = DEFAULT_TYPE_KEY;
  // Always target the stable legacy id when present; never mint a second
  // "历史通用对话" project on re-runs.
  let newId = LEGACY_GENERAL_ID;
  if (!usedIds.has(newId)) {
    // Prefer an already-migrated legacy project if the stable id was renamed.
    for (const id of usedIds) {
      if (id.startsWith('general_med-legacy-')) {
        const meta = readJson(join(projectsRoot, typeKey, id, 'meta.json'));
        if (meta?.migratedFrom === 'general' || meta?.displayName === '历史通用对话') {
          newId = id;
          break;
        }
      }
    }
  }
  usedIds.add(newId);

  const destProject = join(projectsRoot, typeKey, newId);
  const destWorkspace = join(workspacesRoot, typeKey, newId);
  const already = existsSync(destProject) && existsSync(join(destProject, 'meta.json'));

  const sources = [];
  const homeSlugProject = join(projectsRoot, homeSlug);
  if (existsSync(homeSlugProject)) sources.push({ kind: 'chats-home', path: homeSlugProject });

  const generalWs = join(workspacesRoot, 'general');
  if (existsSync(generalWs)) sources.push({ kind: 'workspace-general', path: generalWs });

  if (already && sources.length === 0) {
    report.skipped.push({ reason: 'legacy-general-already-migrated', id: newId });
    return newId;
  }

  if (!already) {
    ensureDir(destProject);
    ensureDir(join(destProject, 'chats'));
    report.created.push({ dir: destProject, label: 'legacy-general-project' });
  }

  for (const src of sources) {
    if (src.kind === 'workspace-general') {
      if (!existsSync(destWorkspace)) {
        await moveTree(src.path, destWorkspace, report, 'legacy-general-workspace');
      } else {
        // Merge contents into existing dest.
        for (const name of readdirSync(src.path)) {
          if (name === '.DS_Store') continue;
          await moveTree(join(src.path, name), join(destWorkspace, name), report, 'legacy-general-ws-merge');
        }
        if (!dryRun && existsSync(src.path) && readdirSync(src.path).length === 0) {
          rmSync(src.path, { recursive: true, force: true });
        }
      }
      if (!existsSync(destWorkspace)) {
        ensureDir(destWorkspace);
      }
      ensureWorkspaceLayout(destWorkspace);
    }
    if (src.kind === 'chats-home') {
      const chatsSrc = join(src.path, 'chats');
      const chatsDest = join(destProject, 'chats');
      if (existsSync(chatsSrc)) {
        ensureDir(chatsDest);
        for (const name of readdirSync(chatsSrc)) {
          if (name === '.DS_Store') continue;
          await moveTree(join(chatsSrc, name), join(chatsDest, name), report, 'legacy-general-chat');
        }
      }
      // Remove emptied home-slug project dir if only chats left.
      if (!dryRun && existsSync(src.path)) {
        const leftover = readdirSync(src.path).filter((n) => n !== '.DS_Store');
        if (leftover.length === 0 || (leftover.length === 1 && leftover[0] === 'chats' && readdirSync(join(src.path, 'chats')).length === 0)) {
          rmSync(src.path, { recursive: true, force: true });
          report.removed.push(src.path);
        }
      }
    }
  }

  const meta = {
    id: newId,
    displayName: '历史通用对话',
    type: DEFAULT_META_TYPE,
    kind: 'system',
    status: 'active',
    createdAt: new Date().toISOString(),
    migratedFrom: 'general',
  };
  if (!dryRun) {
    writeFileSync(join(destProject, '.cwd'), destWorkspace, 'utf8');
    ensureWorkspaceLayout(destWorkspace);
    if (!already) {
      writeJson(join(destProject, 'meta.json'), meta);
      report.updated.push({ file: join(destProject, 'meta.json'), id: newId });
    } else {
      report.skipped.push({ reason: 'legacy-general-meta-kept', id: newId });
    }
  } else if (!already) {
    report.updated.push({ file: join(destProject, 'meta.json'), id: newId });
  }
  return newId;
}

async function migrateMemoryHashes(pilotHome, report, legacyGeneralId) {
  const memoryRoot = join(pilotHome, 'memory');
  const workspacesHashRoot = join(memoryRoot, 'workspaces');
  if (!existsSync(workspacesHashRoot)) return;

  const workspacesRoot = resolve(pilotHome, 'workspaces');
  const wsPrefix = workspacesRoot.endsWith('/') ? workspacesRoot : `${workspacesRoot}/`;

  function mapWorkspaceDirToTyped(workspaceDir) {
    if (typeof workspaceDir !== 'string' || !workspaceDir.trim()) return null;
    const resolved = resolve(workspaceDir);
    if (
      resolved === resolve(pilotHome)
      || resolved === resolve(workspacesRoot, 'general')
    ) {
      return { typeKey: DEFAULT_TYPE_KEY, projectId: legacyGeneralId };
    }
    if (resolved === workspacesRoot || resolved.startsWith(wsPrefix)) {
      const parts = resolved.slice(wsPrefix.length).split('/').filter(Boolean);
      if (parts[0] === 'general') {
        return { typeKey: DEFAULT_TYPE_KEY, projectId: legacyGeneralId };
      }
      if (parts.length >= 2 && TYPE_KEYS.has(parts[0])) {
        return { typeKey: parts[0], projectId: parts[1] };
      }
    }
    return null;
  }

  function countMemoryFiles(dir) {
    const mem = join(dir, 'memory');
    if (!existsSync(mem)) return 0;
    let n = 0;
    const walk = (d) => {
      for (const name of readdirSync(d)) {
        if (name === '.DS_Store') continue;
        const p = join(d, name);
        try {
          if (statSync(p).isDirectory()) walk(p);
          else n += 1;
        } catch { /* ignore */ }
      }
    };
    walk(mem);
    return n;
  }

  async function mergeMemoryTree(src, dest) {
    ensureDir(dest);
    for (const name of readdirSync(src)) {
      if (name === '.DS_Store') continue;
      if (name === 'control.sqlite' || name === 'control.sqlite-wal' || name === 'control.sqlite-shm') {
        continue;
      }
      const from = join(src, name);
      const to = join(dest, name);
      if (statSync(from).isDirectory()) {
        if (!existsSync(to)) {
          await moveTree(from, to, report, 'memory-merge-dir');
        } else {
          await mergeMemoryTree(from, to);
        }
      } else if (!existsSync(to)) {
        await moveTree(from, to, report, 'memory-merge-file');
      }
    }
  }

  for (const hash of readdirSync(workspacesHashRoot, { withFileTypes: true })) {
    if (!hash.isDirectory()) continue;
    const src = join(workspacesHashRoot, hash.name);
    let mapped = null;
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const dbPath = join(src, 'control.sqlite');
      if (existsSync(dbPath)) {
        const db = new DatabaseSync(dbPath);
        try {
          const row = db.prepare(
            'SELECT state_json FROM pipeline_state WHERE state_key = ?',
          ).get('workspaceDir');
          if (row && typeof row.state_json === 'string') {
            mapped = mapWorkspaceDirToTyped(JSON.parse(row.state_json));
          }
        } finally {
          db.close();
        }
      }
    } catch {
      mapped = null;
    }

    const typeKey = mapped?.typeKey || DEFAULT_TYPE_KEY;
    const projectId = mapped?.projectId || `general_med-legacy-hash-${hash.name.slice(0, 10)}`;
    const dest = join(memoryRoot, typeKey, projectId);

    if (!existsSync(dest)) {
      await moveTree(src, dest, report, 'memory-hash');
      continue;
    }

    // Dest already exists (typed project memory). Merge markdown / last_dream;
    // prefer src sqlite when dest has no memory files and src does.
    const srcFiles = countMemoryFiles(src);
    const destFiles = countMemoryFiles(dest);
    await mergeMemoryTree(src, dest);

    const destDb = join(dest, 'control.sqlite');
    const srcDb = join(src, 'control.sqlite');
    if (existsSync(srcDb) && (destFiles === 0 && srcFiles > 0)) {
      for (const suffix of ['', '-wal', '-shm']) {
        const from = `${srcDb}${suffix}`;
        const to = `${destDb}${suffix}`;
        if (!existsSync(from)) continue;
        if (!dryRun) {
          try { rmSync(to, { force: true }); } catch { /* ignore */ }
          renameSync(from, to);
        }
        report.moved.push({ from, to, label: 'memory-sqlite-replace' });
      }
    }

    if (!dryRun && existsSync(src)) {
      rmSync(src, { recursive: true, force: true });
      report.removed.push(src);
    } else if (dryRun) {
      report.removed.push(src);
    }
  }

  // Remove empty workspaces hash root if empty.
  if (!dryRun && existsSync(workspacesHashRoot) && readdirSync(workspacesHashRoot).length === 0) {
    rmSync(workspacesHashRoot, { recursive: true, force: true });
    report.removed.push(workspacesHashRoot);
  }
}

async function main() {
  const pilotHome = resolvePilotHome();
  const report = {
    pilotHome,
    dryRun,
    moved: [],
    created: [],
    updated: [],
    skipped: [],
    removed: [],
    errors: [],
  };

  if (!existsSync(pilotHome)) {
    console.error(`PILOT_HOME does not exist: ${pilotHome}`);
    process.exit(1);
  }

  console.log(`${dryRun ? '[dry-run] ' : ''}Migrating typed projects under ${pilotHome}`);

  const usedIds = collectTypedProjectIds(join(pilotHome, 'projects'));

  await migrateSysOrTypedFlat(pilotHome, report, usedIds);
  const legacyGeneralId = await migrateLegacyGeneral(pilotHome, report, usedIds);
  await migratePathResiduals(pilotHome, report, usedIds);
  await migrateMemoryHashes(pilotHome, report, legacyGeneralId);

  // Ensure type bucket dirs exist.
  for (const typeKey of TYPE_KEYS) {
    ensureDir(join(pilotHome, 'projects', typeKey));
    ensureDir(join(pilotHome, 'workspaces', typeKey));
    ensureDir(join(pilotHome, 'memory', typeKey));
  }
  ensureDir(join(pilotHome, 'memory', 'global'));

  console.log(JSON.stringify({
    dryRun,
    moved: report.moved.length,
    created: report.created.length,
    updated: report.updated.length,
    skipped: report.skipped.length,
    removed: report.removed.length,
    errors: report.errors,
    sampleMoved: report.moved.slice(0, 12),
  }, null, 2));

  if (report.errors.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
