import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolvePilotHome, PILOT_CONFIG_FILE_NAME } from "../pilot/paths.js";

export type HomeGuardResult =
  | { kind: "user-home"; pilotHome: string }
  | { kind: "redirected"; pilotHome: string; configPath: string; from: string }
  | { kind: "system-root-without-admin"; pilotHome: string };

/**
 * The web server's PILOT_HOME is a multi-user "system root" (system/auth.db,
 * users/<id>/); each user's data lives in users/<id>. A CLI/TUI run with
 * PILOT_HOME pointing at that root must use the administrator's home instead,
 * which the web server records in system/admin-home. Never guesses: a root
 * without a usable pointer is reported, not redirected.
 */
export function resolveCliHome(env: NodeJS.ProcessEnv): HomeGuardResult {
  const pilotHome = resolvePilotHome(env);
  if (!existsSync(resolve(pilotHome, "system", "auth.db"))) return { kind: "user-home", pilotHome };
  const pointer = resolve(pilotHome, "system", "admin-home");
  if (!existsSync(pointer)) return { kind: "system-root-without-admin", pilotHome };
  const adminHome = readFileSync(pointer, "utf8").trim();
  if (!adminHome || !existsSync(adminHome)) return { kind: "system-root-without-admin", pilotHome };
  return { kind: "redirected", pilotHome: adminHome, configPath: resolve(pilotHome, PILOT_CONFIG_FILE_NAME), from: pilotHome };
}

export function applyCliHome(env: NodeJS.ProcessEnv, log: (m: string) => void): void {
  const r = resolveCliHome(env);
  if (r.kind === "redirected") {
    env.PILOT_HOME = r.pilotHome;
    if (!env.PILOTDECK_CONFIG_PATH?.trim()) env.PILOTDECK_CONFIG_PATH = r.configPath;
    log(`[pilotdeck] PILOT_HOME is a multi-user root; using the administrator home ${r.pilotHome}`);
    return;
  }
  if (r.kind === "system-root-without-admin") {
    log(`[pilotdeck] PILOT_HOME ${r.pilotHome} is a multi-user root but system/admin-home is missing; start the web server once to create it, or point PILOT_HOME at a user directory.`);
  }
}
