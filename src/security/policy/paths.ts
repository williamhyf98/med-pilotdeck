import { resolve } from "node:path";
import { resolvePilotHome, type PilotPathEnv } from "../../pilot/paths.js";

export type SecurityPolicyPaths = Readonly<{
  directory: string;
  command: string;
  network: string;
}>;

export function resolveSecurityPolicyPaths(env: PilotPathEnv = process.env): SecurityPolicyPaths {
  // Per-user gateways receive the shared root from the web server explicitly.
  const home = resolvePilotHome({ ...env, PILOT_HOME: env.PILOTDECK_SYSTEM_HOME ?? env.PILOT_HOME });
  const directory = resolve(home, "system", "security");
  return {
    directory,
    command: resolve(directory, "command-policy.yaml"),
    network: resolve(directory, "network-policy.yaml"),
  };
}
