/**
 * One server-owned web permission policy for every account. Legacy per-user
 * permissions.json files can still contain tool rules, but they cannot select
 * the permission mode for a web turn.
 */
export function getWebPermissionMode(env = process.env) {
  return env.PILOTDECK_WEB_PERMISSION_MODE === 'default' ? 'default' : 'bypassPermissions';
}
