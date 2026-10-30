/**
 * Feature flags for the `pilotdeck server` command.
 *
 * `PILOTDECK_DISABLE_ALWAYS_ON` is set by the UI server's per-user Gateway pool
 * (`ui/server/services/gatewayPool.js`). A pooled gateway is one of N processes
 * sharing a single `pilotdeck.yaml`, so every background subsystem that reads
 * that shared config would otherwise run N times: N always-on loops, N cron
 * daemons and N IM bots logged into the same Feishu/WeChat/QQ/WeCom account.
 * A standalone/free-login gateway never sees the variable and is unaffected.
 */
export function isAlwaysOnDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.PILOTDECK_DISABLE_ALWAYS_ON;
  if (typeof raw !== "string") return false;
  const value = raw.trim().toLowerCase();
  return value === "1" || value === "true";
}
