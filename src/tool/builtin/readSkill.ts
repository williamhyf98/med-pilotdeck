import type { PilotDeckToolDefinition, PilotDeckToolRuntimeContext } from "../protocol/types.js";

export type ReadSkillInput = {
  skillName: string;
};

export type ReadSkillDeps = {
  loader: (name: string, context: PilotDeckToolRuntimeContext) => Promise<string | undefined>;
  lister: (context: PilotDeckToolRuntimeContext) => {
    name: string;
    description?: string;
    path: string;
    namespace?: string;
  }[];
};

export function createReadSkillTool(deps: ReadSkillDeps): PilotDeckToolDefinition<ReadSkillInput> {
  return {
    name: "read_skill",
    aliases: ["ReadSkill"],
    description:
      "Load a skill recipe by name and return its resolved SKILL.md path with the full content. " +
      "Use this when the system prompt lists an available skill relevant to the current task.",
    kind: "session",
    inputSchema: {
      type: "object",
      required: ["skillName"],
      additionalProperties: false,
      properties: {
        skillName: {
          type: "string",
          description: "The skill name as listed in <available-skills>.",
        },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(input, context) {
      const available = deps.lister(context);
      const requestedName = shortSkillName(input.skillName);
      const selected = available.find((entry) => shortSkillName(entry.name) === requestedName);
      const content = selected ? await deps.loader(selected.name, context) : undefined;
      if (selected && content) {
        const text = [
          "<skill>",
          `<name>${escapeXmlText(selected.name)}</name>`,
          `<path>${escapeXmlText(selected.path)}</path>`,
          content,
          "</skill>",
        ].join("\n");
        return { content: [{ type: "text", text }] };
      }
      if (available.length === 0) {
        return {
          content: [{ type: "text", text: `Skill '${input.skillName}' not found. No skills are currently loaded.` }],
        };
      }
      const names = available.map((s) => s.name).join(", ");
      return {
        content: [{ type: "text", text: `Skill '${input.skillName}' not found. Available skills: ${names}` }],
      };
    },
  };
}

function shortSkillName(value: string): string {
  const separator = value.lastIndexOf(":");
  return separator >= 0 ? value.slice(separator + 1) : value;
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
