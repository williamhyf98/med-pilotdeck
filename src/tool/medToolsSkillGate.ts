export type MedToolsSkillRequirement = {
  /** Skill injected when none of the accepted skills has been loaded. */
  loadSkill: string;
  /** Any one of these skills is sufficient to execute the MCP tool. */
  acceptedSkills: readonly string[];
};

const ANY_MEDICAL_SKILL = [
  "med-medical",
  "med-trauma-assist",
  "med-trauma-stage-plan",
  "med-case-report",
] as const;

const DEFAULT_MED_TOOLS_REQUIREMENT: MedToolsSkillRequirement = {
  loadSkill: "med-medical",
  acceptedSkills: ANY_MEDICAL_SKILL,
};

const MED_TOOLS_SKILL_REQUIREMENTS: Readonly<
  Record<string, MedToolsSkillRequirement>
> = {
  "mcp__med-tools__med_parse_medical": {
    loadSkill: "med-medical",
    acceptedSkills: ["med-medical", "med-trauma-stage-plan", "med-case-report"],
  },
  "mcp__med-tools__med_trauma_rag_query": {
    loadSkill: "med-trauma-assist",
    acceptedSkills: ["med-trauma-assist"],
  },
  "mcp__med-tools__med_trauma_rag_status": {
    loadSkill: "med-trauma-assist",
    acceptedSkills: ["med-trauma-assist"],
  },
  "mcp__med-tools__med_trauma_stage_plan": {
    loadSkill: "med-trauma-stage-plan",
    acceptedSkills: ["med-trauma-stage-plan"],
  },
  "mcp__med-tools__med_tools_health": {
    loadSkill: "med-medical",
    acceptedSkills: ANY_MEDICAL_SKILL,
  },
};

export function normalizeLoadedSkillName(name: string): string {
  const normalized = name.trim().toLowerCase();
  const separator = normalized.lastIndexOf(":");
  return separator >= 0 ? normalized.slice(separator + 1) : normalized;
}

export function getMedToolsSkillRequirement(
  toolName: string,
): MedToolsSkillRequirement | undefined {
  return MED_TOOLS_SKILL_REQUIREMENTS[toolName]
    ?? (toolName.startsWith("mcp__med-tools__")
      ? DEFAULT_MED_TOOLS_REQUIREMENT
      : undefined);
}

export function isRequiredMedToolsSkillLoaded(
  requirement: MedToolsSkillRequirement,
  loadedSkills: ReadonlySet<string>,
): boolean {
  return requirement.acceptedSkills.some((skill) =>
    loadedSkills.has(normalizeLoadedSkillName(skill)),
  );
}

export function buildMedToolsSkillGateMessage(
  toolName: string,
  skillName: string,
): string {
  return [
    "<med-tools-skill-gate>",
    `The proposed tool ${toolName} was NOT executed.`,
    `The required skill ${skillName} has now been loaded below.`,
    "Read and follow the complete skill instructions, then re-plan from the user's request.",
    "Issue a NEW tool call only after applying every required step. Do not answer as if the blocked tool already ran.",
    "</med-tools-skill-gate>",
  ].join("\n");
}
