#!/usr/bin/env node
// Convert deployment metadata, never conversation/clinical content.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, writeFileSync, symlinkSync, unlinkSync, copyFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

export function migratePortablePaths({ pilotHome, repoRoot, dryRun = false }) {
  pilotHome = resolve(pilotHome);
  repoRoot = resolve(repoRoot);
  const changes = [];
  const skipped = [];
  const within = (root, target) => {
    const rel = relative(root, target);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  };
  function managedTarget(raw) {
    if (!isAbsolute(raw)) return null;
    if (within(pilotHome, raw)) return raw;
    // Old deployments used either of these data directory names.
    for (const name of new Set([basename(pilotHome), '.pilotdeck-home', '.pilotdeck'])) {
      const token = `/${name}/`;
      const offset = raw.lastIndexOf(token);
      if (offset >= 0) {
        const target = resolve(pilotHome, raw.slice(offset + token.length));
        if (within(pilotHome, target)) return target;
      }
    }
    return null;
  }
  function visitMarkers(dir, depth = 0) {
    if (!existsSync(dir) || depth > 3) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) visitMarkers(file, depth + 1);
      if (!entry.isFile() || entry.name !== '.cwd') continue;
      const raw = readFileSync(file, 'utf8').trim();
      if (!isAbsolute(raw)) continue;
      const target = managedTarget(raw);
      if (!target || !existsSync(target)) { skipped.push({ file, reason: 'external or missing target; requires explicit relocation' }); continue; }
      changes.push({ file, kind: 'file', value: relative(pilotHome, target) || '.' });
    }
  }
  visitMarkers(join(pilotHome, 'projects'));
  visitMarkers(join(pilotHome, 'cron/projects'));

  const configFile = join(pilotHome, 'pilotdeck.yaml');
  if (existsSync(configFile)) {
    const doc = parseDocument(readFileSync(configFile, 'utf8'));
    if (doc.errors.length) throw new Error('Cannot migrate invalid pilotdeck.yaml');
    let changed = false;
    for (const key of ['databasePath', 'workspacesRoot']) {
      const field = ['webui', 'runtime', key];
      const raw = doc.getIn(field);
      if (typeof raw !== 'string' || !isAbsolute(raw)) continue;
      const target = managedTarget(raw);
      const value = target ? relative(pilotHome, target) || '.'
        : key === 'workspacesRoot' && (raw === homedir() || /^\/(Users|home)\/[^/]+\/?$/.test(raw)) ? '~' : null;
      if (value !== null) { doc.setIn(field, value); changed = true; }
      else skipped.push({ file: configFile, field: key, reason: 'external configured path' });
    }
    if (changed) changes.push({ file: configFile, kind: 'file', value: doc.toString() });
  }

  // Inspect only deployment links; never recurse through symlinks or clinical files.
  const links = [join(pilotHome, 'exports'), join(pilotHome, '.tmp/chat-attachments')];
  for (const dir of [join(pilotHome, 'plugins'), join(pilotHome, 'skills')]) {
    if (existsSync(dir)) for (const name of readdirSync(dir)) links.push(join(dir, name));
  }
  for (const file of links) {
    let stat;
    try { stat = lstatSync(file); } catch { continue; }
    if (!stat.isSymbolicLink()) continue;
    const raw = readlinkSync(file);
    if (!isAbsolute(raw)) continue;
    let target = managedTarget(raw);
    for (const bucket of ['plugins', 'skills']) {
      const expected = join(pilotHome, bucket, basename(file));
      const bundled = join(repoRoot, bucket, basename(file));
      if (file === expected && raw.endsWith(`/${bucket}/${basename(file)}`) && existsSync(bundled)) target = bundled;
    }
    if (!target && within(repoRoot, raw)) target = raw;
    if (!target || !existsSync(target)) { skipped.push({ file, reason: 'external or missing link target' }); continue; }
    changes.push({ file, kind: 'symlink', value: relative(dirname(file), target) });
  }

  let backupDir = null;
  if (!dryRun && changes.length) {
    const backupRoot = join(pilotHome, 'migration-backups');
    mkdirSync(backupRoot, { recursive: true });
    backupDir = mkdtempSync(join(backupRoot, 'portable-paths-'));
    // Finish all backups before replacing any metadata.
    for (const change of changes) {
      const backup = join(backupDir, relative(pilotHome, change.file));
      mkdirSync(dirname(backup), { recursive: true });
      if (change.kind === 'symlink') writeFileSync(`${backup}.link-target`, readlinkSync(change.file));
      else copyFileSync(change.file, backup);
    }
    for (const change of changes) {
      if (change.kind === 'symlink') { unlinkSync(change.file); symlinkSync(change.value, change.file, 'dir'); }
      else writeFileSync(change.file, change.value);
    }
  }
  // Do not print configuration values: they can contain credentials.
  return { dryRun, backupDir, changes: changes.map(({ file, kind }) => ({ file, kind })), skipped };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = key => args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
  const repoRoot = option('--repo-root') || resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const rawHome = option('--pilot-home') || process.env.PILOT_HOME || join(repoRoot, '.pilotdeck-home');
  const pilotHome = rawHome === '~' ? homedir() : rawHome.startsWith('~/') ? join(homedir(), rawHome.slice(2)) : rawHome;
  console.log(JSON.stringify(migratePortablePaths({ pilotHome, repoRoot, dryRun: args.includes('--dry-run') }), null, 2));
}
