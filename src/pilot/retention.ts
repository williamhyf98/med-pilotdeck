import { promises as fsp, realpathSync, existsSync } from "node:fs";
import { join, relative, resolve, basename, dirname, isAbsolute, sep } from "node:path";
import type { RetentionConfig } from "./config/parseMultiUserConfig.js";

export type RetentionReport = { rotatedLogs: string[]; removedAttachments: number; removedArchives: string[] };
const DAY = 86_400_000;

/**
 * Resolve symlinks for a path that may not exist yet: realpath the nearest
 * existing ancestor and re-append the missing tail.
 */
function realpathLoose(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    const parent = dirname(abs);
    if (parent === abs) return abs;
    return join(realpathLoose(parent), basename(abs));
  }
}

/** Throws unless `candidate` resolves (symlinks followed) strictly inside `home`. */
export function assertInsideHome(candidate: string, home: string): void {
  const realHome = realpathSync(home);
  const probe = realpathLoose(candidate);
  const rel = relative(realHome, probe);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`retention refused: ${candidate} is outside ${home}`);
  }
}

async function rotateLogs(home: string, cfg: RetentionConfig, out: RetentionReport): Promise<void> {
  const dir = join(home, "logs");
  if (!existsSync(dir)) return;
  assertInsideHome(dir, home);
  const keep = Math.max(1, Math.floor(cfg.logKeep));
  const names = await fsp.readdir(dir);
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const file = join(dir, name);
    const stat = await fsp.lstat(file);
    if (!stat.isFile() || stat.size < cfg.logMaxBytes) continue;
    for (let i = keep; i >= 1; i -= 1) {
      const src = i === 1 ? file : `${file}.${i - 1}`;
      const dst = `${file}.${i}`;
      if (!existsSync(src)) continue;
      assertInsideHome(src, home);
      assertInsideHome(dst, home);
      if (i === keep && existsSync(dst)) await fsp.rm(dst);
      await fsp.rename(src, dst);
    }
    // Generations beyond `keep` (left over from a larger logKeep) are dropped.
    for (const other of names) {
      const m = other.startsWith(`${name}.`) ? /^\.(\d+)$/.exec(other.slice(name.length)) : null;
      if (m && Number(m[1]) > keep) {
        const stale = join(dir, other);
        assertInsideHome(stale, home);
        await fsp.rm(stale, { force: true });
      }
    }
    out.rotatedLogs.push(name);
  }
}

async function pruneAttachments(home: string, cfg: RetentionConfig, now: number, out: RetentionReport): Promise<void> {
  const root = join(home, ".tmp", "chat-attachments");
  let rootStat;
  try {
    rootStat = await fsp.lstat(root);
  } catch {
    return;
  }
  if (!rootStat.isDirectory()) return; // missing, file, or symlink: never follow
  assertInsideHome(root, home);
  const cutoff = now - cfg.attachmentMaxAgeDays * DAY;
  async function walk(dir: string): Promise<boolean> {
    let empty = true;
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        empty = false; // never follow links
        continue;
      }
      if (entry.isDirectory()) {
        if (await walk(p)) {
          assertInsideHome(p, home);
          await fsp.rmdir(p);
        } else {
          empty = false;
        }
        continue;
      }
      const st = await fsp.lstat(p);
      if (st.mtimeMs < cutoff) {
        assertInsideHome(p, home);
        await fsp.rm(p);
        out.removedAttachments += 1;
      } else {
        empty = false;
      }
    }
    return empty;
  }
  // The root itself is kept even when empty; only its children are pruned.
  await walk(root);
}

const ARCHIVE_TS = /-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;
async function pruneArchives(
  home: string,
  cfg: RetentionConfig,
  now: number,
  out: RetentionReport,
  log: (m: string) => void,
): Promise<void> {
  const dir = join(home, "archives", "projects");
  if (!existsSync(dir)) return;
  assertInsideHome(dir, home);
  const cutoff = now - cfg.archiveMaxAgeDays * DAY;
  const expired: string[] = [];
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const name = entry.name;
    if (!entry.isDirectory()) continue; // symlinks and stray files are never touched
    const m = ARCHIVE_TS.exec(name);
    if (!m) {
      log(`[retention] skip archive without timestamp: ${name}`);
      continue;
    }
    const when = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    if (new Date(when).getUTCMonth() !== +m[2] - 1) {
      log(`[retention] skip archive with invalid timestamp: ${name}`);
      continue;
    }
    if (when >= cutoff) continue;
    expired.push(name);
  }
  if (expired.length === 0) return;
  // Say what is about to go before it goes: a deletion nobody announced is the
  // one a user reports as "my archive vanished".
  const shown = expired.slice(0, 20).join(", ");
  const rest = expired.length - 20;
  log(`[retention] removing ${expired.length} expired project archive(s): ${shown}${rest > 0 ? `, +${rest} more` : ""}`);
  for (const name of expired) {
    const p = join(dir, name);
    assertInsideHome(p, home);
    await fsp.rm(p, { recursive: true, force: true });
    out.removedArchives.push(name);
  }
}

export type RunRetentionOptions = {
  pilotHome: string;
  config: RetentionConfig;
  now?: () => Date;
  log?: (m: string) => void;
};

export async function runRetention(opts: RunRetentionOptions): Promise<RetentionReport> {
  const log = opts.log ?? (() => {});
  const now = (opts.now ?? (() => new Date()))().getTime();
  const out: RetentionReport = { rotatedLogs: [], removedAttachments: 0, removedArchives: [] };
  // Each phase is isolated so one failure (or refused path) does not block the others.
  const phases: Array<[string, () => Promise<void>]> = [
    ["logs", () => rotateLogs(opts.pilotHome, opts.config, out)],
    ["attachments", () => pruneAttachments(opts.pilotHome, opts.config, now, out)],
    ["archives", () => pruneArchives(opts.pilotHome, opts.config, now, out, log)],
  ];
  for (const [label, phase] of phases) {
    try {
      await phase();
    } catch (error) {
      log(`[retention] ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (out.rotatedLogs.length || out.removedAttachments || out.removedArchives.length) {
    log(`[retention] ${JSON.stringify(out)}`);
  }
  return out;
}

export function startRetentionTimer(opts: RunRetentionOptions & { intervalMs?: number }): { stop(): void } {
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    runRetention(opts)
      .catch((e) => (opts.log ?? console.warn)(`[retention] failed: ${(e as Error).message}`))
      .finally(() => {
        running = false;
      });
  };
  // First run is deferred so server startup is never blocked by it.
  const first = setTimeout(run, 0);
  const timer = setInterval(run, opts.intervalMs ?? DAY);
  first.unref?.();
  timer.unref?.();
  return {
    stop: () => {
      clearTimeout(first);
      clearInterval(timer);
    },
  };
}
