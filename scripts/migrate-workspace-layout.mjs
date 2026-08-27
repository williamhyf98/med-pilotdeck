#!/usr/bin/env node
/**
 * One-time idempotent migration: move general-chat runtime files from
 * PILOT_HOME root into PILOT_HOME/workspaces/general/.
 *
 * Usage:
 *   node scripts/migrate-workspace-layout.mjs [--pilot-home PATH] [--dry-run]
 */
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { cp } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

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

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function ensureDir(dir) {
  if (dryRun) return;
  mkdirSync(dir, { recursive: true });
}

async function copyTree(src, dest, report) {
  if (!existsSync(src)) return;
  ensureDir(dest);
  await cp(src, dest, {
    recursive: true,
    force: false,
    errorOnExist: false,
    filter: (srcPath) => {
      const name = basename(srcPath);
      if (name === '.DS_Store') return false;
      return true;
    },
  });
  report.copied.push({ from: src, to: dest });
}

function migrateFile(src, dest, report) {
  if (!existsSync(src)) return;
  ensureDir(join(dest, '..'));
  if (existsSync(dest)) {
    try {
      if (sha256(src) === sha256(dest)) {
        report.skipped.push(dest);
        return;
      }
    } catch {
      // fall through to collision name
    }
    const collision = `${dest}.collision-${Date.now()}`;
    if (!dryRun) copyFileSync(src, collision);
    report.collisions.push({ src, dest, collision });
    return;
  }
  if (dryRun) {
    report.copied.push({ from: src, to: dest });
    return;
  }
  copyFileSync(src, dest);
  report.copied.push({ from: src, to: dest });
}

function symlinkIfMissing(linkPath, targetPath, report) {
  if (existsSync(linkPath)) {
    const stat = lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      report.skipped.push(linkPath);
      return;
    }
    replaceDirWithSymlink(linkPath, targetPath, report);
    return;
  }
  if (dryRun) {
    report.symlinks.push({ linkPath, targetPath });
    return;
  }
  ensureDir(join(linkPath, '..'));
  symlinkSync(targetPath, linkPath, 'dir');
  report.symlinks.push({ linkPath, targetPath });
}

function replaceDirWithSymlink(linkPath, targetPath, report) {
  if (!existsSync(targetPath)) {
    report.skipped.push(linkPath);
    return;
  }
  if (dryRun) {
    report.symlinks.push({ linkPath, targetPath, replaced: true });
    return;
  }
  const backupPath = `${linkPath}.pre-symlink-${Date.now()}`;
  renameSync(linkPath, backupPath);
  try {
    symlinkSync(targetPath, linkPath, 'dir');
    rmSync(backupPath, { recursive: true, force: true });
    report.symlinks.push({ linkPath, targetPath, replaced: true });
  } catch (error) {
    renameSync(backupPath, linkPath);
    throw error;
  }
}

async function main() {
  const pilotHome = resolvePilotHome();
  const wsRoot = join(pilotHome, 'workspaces', 'general');
  const inboxRoot = join(wsRoot, 'inbox');
  const exportsRoot = join(wsRoot, 'exports');
  const scratchQa = join(wsRoot, 'scratch', 'qa');
  const scratchPreview = join(wsRoot, 'scratch', 'preview');
  const scratchWork = join(wsRoot, 'scratch', 'work');
  const markerPath = join(pilotHome, '.workspace-migration-v1.json');

  const report = {
    pilotHome,
    workspaceRoot: wsRoot,
    dryRun,
    copied: [],
    skipped: [],
    collisions: [],
    symlinks: [],
  };

  for (const dir of [inboxRoot, exportsRoot, scratchQa, scratchPreview, scratchWork]) {
    ensureDir(dir);
  }

  const legacyAttachments = join(pilotHome, '.tmp', 'chat-attachments');
  if (existsSync(legacyAttachments)) {
    for (const batch of readdirSync(legacyAttachments)) {
      const srcBatch = join(legacyAttachments, batch);
      if (!statSync(srcBatch).isDirectory()) continue;
      const destBatch = join(inboxRoot, batch);
      await copyTree(srcBatch, destBatch, report);
      const derivedSrc = join(srcBatch, '.med-tools-derived');
      const derivedDest = join(destBatch, 'derived');
      if (existsSync(derivedSrc)) {
        await copyTree(derivedSrc, derivedDest, report);
      }
      symlinkIfMissing(join(legacyAttachments, batch), destBatch, report);
    }
  }

  const legacyExports = join(pilotHome, 'exports');
  if (existsSync(legacyExports)) {
    for (const entry of readdirSync(legacyExports)) {
      const src = join(legacyExports, entry);
      const st = statSync(src);
      if (entry === 'qa' && st.isDirectory()) {
        await copyTree(src, scratchQa, report);
        continue;
      }
      if (entry === '.pdf-qa' && st.isDirectory()) {
        await copyTree(src, scratchPreview, report);
        continue;
      }
      if (st.isDirectory()) {
        await copyTree(src, join(exportsRoot, entry), report);
        continue;
      }
      migrateFile(src, join(exportsRoot, entry), report);
    }
  }

  const legacyWork = join(pilotHome, '.pilotdeck', 'work');
  if (existsSync(legacyWork)) {
    await copyTree(legacyWork, scratchWork, report);
  }

  const legacyExportsLink = join(pilotHome, 'exports');
  const legacyExportsTarget = exportsRoot;
  if (existsSync(legacyExportsTarget)) {
    symlinkIfMissing(legacyExportsLink, legacyExportsTarget, report);
  }

  const legacyInboxLink = join(pilotHome, '.tmp', 'chat-attachments');
  if (existsSync(inboxRoot)) {
    symlinkIfMissing(legacyInboxLink, inboxRoot, report);
  }

  const junkFiles = [
    join(pilotHome, 'build_bingli_report.py'),
    join(pilotHome, 'build_bingli_report_pil.py'),
    join(pilotHome, 'exports', 'extract_med_reports.py'),
  ];
  for (const junk of junkFiles) {
    if (existsSync(junk)) {
      report.removedJunk = report.removedJunk ?? [];
      if (!dryRun) {
        try {
          renameSync(junk, `${junk}.removed-${Date.now()}`);
        } catch {
          // ignore
        }
      }
      report.removedJunk.push(junk);
    }
  }

  if (!dryRun) {
    writeFileSync(markerPath, JSON.stringify({ ...report, completedAt: new Date().toISOString() }, null, 2));
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
