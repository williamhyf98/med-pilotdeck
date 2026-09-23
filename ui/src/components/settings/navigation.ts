import type { SettingsMenuKey } from "./types";

// Menu keys non-admin users may open. Everything else is admin-only: hidden
// from the settings sidebar and clamped away when arriving via deep-links
// (window.openSettings('config:...') etc.). The server enforces the real
// permission checks — this only keeps the UI honest.
export const NON_ADMIN_MENU_KEYS: readonly SettingsMenuKey[] = ["general", "about"];

export function clampMenuKeyForRole(
  key: SettingsMenuKey,
  isAdmin: boolean,
): SettingsMenuKey {
  if (isAdmin) return key;
  return NON_ADMIN_MENU_KEYS.includes(key) ? key : "general";
}

export function mapInitialTabToMenuKey(
  tab: string | undefined,
): SettingsMenuKey {
  const normalized = String(tab || "");
  const configSections: Record<string, SettingsMenuKey> = {
    models: "modelPool",
    agents: "agentModel",
    memory: "agentMemory",
    tools: "general",
    webSearch: "general",
    router: "agentRoute",
    gateway: "general",
    officePreview: "officePreview",
    customEnv: "advanced",
    alwaysOn: "agentResident",
    cron: "agentSchedule",
    advanced: "advanced",
  };

  const [base, section] = normalized.split(":", 2);
  switch (base) {
    case "permissions":
      return "privacy";
    case "mcp":
      return "mcpServers";
    case "gateway":
      return "general";
    case "config":
      return section ? (configSections[section] ?? "modelPool") : "modelPool";
    default:
      return "general";
  }
}
