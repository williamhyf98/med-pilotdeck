import type { SettingsMenuKey } from "./types";

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
