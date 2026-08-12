/**
 * Prefer a writable local temp directory when TMPDIR/TEMP/TMP point at a
 * broken NFS/shared path (errno 116 Stale file handle). Used by the
 * PilotDeck Docker-less local `npm run dev` launcher.
 */
import { accessSync, constants, mkdirSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

function usableDir(dir) {
  if (!dir) return false;
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.R_OK | constants.W_OK);
    // Catch stale NFS / EIO early — many Shared FS paths pass access() then fail on readdir.
    readdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

export function ensureWritableTmpDir() {
  const cwdRuntimeTmp = join(process.cwd(), '.runtime', 'cache', 'tmp');
  const candidates = [
    process.env.PILOTDECK_TMPDIR,
    cwdRuntimeTmp,
    '/tmp',
    join(homedir(), '.cache', 'pilotdeck-tmp'),
    tmpdir(),
    process.env.TMPDIR,
    process.env.TMP,
    process.env.TEMP,
  ].filter(Boolean);

  let chosen = null;
  for (const dir of candidates) {
    if (usableDir(dir)) {
      chosen = dir;
      break;
    }
  }
  if (!chosen) {
    chosen = join(homedir(), '.cache', 'pilotdeck-tmp');
    mkdirSync(chosen, { recursive: true });
  }

  const previous = process.env.TMPDIR || process.env.TMP || process.env.TEMP || '';
  process.env.TMPDIR = chosen;
  process.env.TMP = chosen;
  process.env.TEMP = chosen;

  if (previous && previous !== chosen) {
    console.log(`[pilotdeck] Using local temp dir ${chosen} (was ${previous})`);
  }
  return chosen;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ensureWritableTmpDir();
}
