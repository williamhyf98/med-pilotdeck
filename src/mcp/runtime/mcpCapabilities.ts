import type { PilotDeckMcpToolCapabilities } from "../protocol/types.js";

export const SYSTEM_REGISTERED_MCP_SERVER_IDS = [
  "med-tools",
  "mineru-ingest-tools",
] as const;

const READ_ONLY_NO_FILES: PilotDeckMcpToolCapabilities = {
  readOnly: true,
  taskReadRoots: [],
  taskWriteRoots: [],
  networkServiceIds: [],
  artifactPolicy: "none",
};

const MEDICAL_PROFILES: Readonly<Record<string, PilotDeckMcpToolCapabilities>> = {
  med_parse_medical: {
    readOnly: true,
    taskReadRoots: ["inbox"],
    taskWriteRoots: [],
    networkServiceIds: ["service.vlm"],
    artifactPolicy: "managed_derived",
  },
  med_image_route: {
    readOnly: true,
    taskReadRoots: ["inbox"],
    taskWriteRoots: [],
    networkServiceIds: [],
    artifactPolicy: "managed_derived",
  },
  med_dicom_route: {
    readOnly: true,
    taskReadRoots: ["inbox"],
    taskWriteRoots: [],
    networkServiceIds: [],
    artifactPolicy: "managed_derived",
  },
  med_tools_health: {
    readOnly: true,
    taskReadRoots: [],
    taskWriteRoots: [],
    networkServiceIds: [
      "service.rag",
      "service.radar",
      "service.deepchest",
      "service.vlm",
    ],
    artifactPolicy: "none",
  },
  med_trauma_rag_status: {
    readOnly: true,
    taskReadRoots: [],
    taskWriteRoots: [],
    networkServiceIds: ["service.rag"],
    artifactPolicy: "none",
  },
  med_trauma_rag_query: {
    readOnly: true,
    taskReadRoots: [],
    taskWriteRoots: [],
    networkServiceIds: ["service.rag"],
    artifactPolicy: "none",
  },
  med_trauma_stage_plan: {
    readOnly: true,
    taskReadRoots: ["inbox"],
    taskWriteRoots: [],
    networkServiceIds: ["service.vlm"],
    artifactPolicy: "none",
  },
  med_radar_status: {
    readOnly: true,
    taskReadRoots: [],
    taskWriteRoots: [],
    networkServiceIds: ["service.radar"],
    artifactPolicy: "none",
  },
  med_radar_analyze_ct: {
    readOnly: false,
    taskReadRoots: ["inbox"],
    taskWriteRoots: ["exports"],
    networkServiceIds: ["service.radar"],
    artifactPolicy: "final",
  },
  med_deepchest_status: {
    readOnly: true,
    taskReadRoots: [],
    taskWriteRoots: [],
    networkServiceIds: ["service.deepchest"],
    artifactPolicy: "none",
  },
  med_deepchest_submit: {
    readOnly: false,
    taskReadRoots: ["inbox"],
    taskWriteRoots: [],
    networkServiceIds: ["service.deepchest"],
    artifactPolicy: "managed_derived",
  },
  med_deepchest_job: {
    readOnly: false,
    taskReadRoots: [],
    taskWriteRoots: [],
    networkServiceIds: ["service.deepchest"],
    artifactPolicy: "managed_derived",
  },
};

const MINERU_PROFILES: Readonly<Record<string, PilotDeckMcpToolCapabilities>> = {
  mineru_ingest_health: {
    ...READ_ONLY_NO_FILES,
    networkServiceIds: ["service.mineru"],
  },
  mineru_ingest_submit: {
    readOnly: false,
    taskReadRoots: ["inbox"],
    taskWriteRoots: [],
    networkServiceIds: ["service.mineru"],
    artifactPolicy: "managed_derived",
  },
  mineru_ingest_status: {
    ...READ_ONLY_NO_FILES,
    networkServiceIds: ["service.mineru"],
    artifactPolicy: "managed_derived",
  },
  mineru_ingest_result: {
    ...READ_ONLY_NO_FILES,
    networkServiceIds: ["service.mineru"],
    artifactPolicy: "managed_derived",
  },
  mineru_ingest_validate: {
    ...READ_ONLY_NO_FILES,
    networkServiceIds: ["service.mineru"],
    artifactPolicy: "managed_derived",
  },
  mineru_ingest_batch_submit: {
    readOnly: false,
    taskReadRoots: ["inbox"],
    taskWriteRoots: [],
    networkServiceIds: ["service.mineru"],
    artifactPolicy: "managed_derived",
  },
  mineru_ingest_batch_status: {
    ...READ_ONLY_NO_FILES,
    networkServiceIds: ["service.mineru"],
    artifactPolicy: "managed_derived",
  },
  mineru_ingest_batch_result: {
    ...READ_ONLY_NO_FILES,
    networkServiceIds: ["service.mineru"],
    artifactPolicy: "managed_derived",
  },
  mineru_ingest_batch_validate: {
    ...READ_ONLY_NO_FILES,
    networkServiceIds: ["service.mineru"],
    artifactPolicy: "managed_derived",
  },
};

export function getMcpToolCapabilities(
  serverId: string,
  toolName: string,
): PilotDeckMcpToolCapabilities | undefined {
  const profile = serverId === "med-tools"
    ? MEDICAL_PROFILES[toolName]
    : serverId === "mineru-ingest-tools"
      ? MINERU_PROFILES[toolName]
      : undefined;
  if (!profile) return undefined;
  return {
    ...profile,
    taskReadRoots: [...profile.taskReadRoots],
    taskWriteRoots: [...profile.taskWriteRoots],
    networkServiceIds: [...profile.networkServiceIds],
  };
}

/**
 * Merge project/global MCP configuration with plugin-provided servers while
 * keeping system-registered server identities owned by the plugin manifest.
 * This prevents a same-named user config entry from inheriting trusted
 * medical capabilities.
 */
export function mergeMcpServerSources(
  pluginServers: Record<string, unknown>,
  configuredServers: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...pluginServers, ...configuredServers };
  for (const serverId of SYSTEM_REGISTERED_MCP_SERVER_IDS) {
    if (Object.hasOwn(pluginServers, serverId)) {
      merged[serverId] = pluginServers[serverId];
    }
  }
  return merged;
}
