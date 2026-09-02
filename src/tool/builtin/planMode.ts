import { readFileSync } from "node:fs";
import type { PilotDeckElicitationAnswer, PilotDeckElicitationRequest } from "../elicitation/PilotDeckElicitationChannel.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import type { PilotDeckToolDefinition } from "../protocol/types.js";

export type ExitPlanModeInput = {
  plan_file_path: string;
};
export type ExitPlanModeOutput = {
  plan: string;
  requestedMode?: "default";
  action?: "continue_planning" | "execute_plan" | "cancelled";
  feedback?: string;
  planFilePath?: string;
  planTitle?: string;
  planSummary?: string;
};

const EXIT_PLAN_MODE_QUESTION = "下一步怎么做？";
const EXIT_PLAN_MODE_CONTINUE = "continue_planning";
const EXIT_PLAN_MODE_EXECUTE = "execute_plan";

const ENTER_PLAN_MODE_DESCRIPTION =
  "复杂的医学工作区任务先进入只读计划模式。适用于需要组合多个步骤的请求，例如：" +
  "读取多份附件、调用医学解析或战创伤 RAG、形成救治方案，再生成 HTML、PPT、PDF 或表格。" +
  "进入后先查看工作区材料与可用 skill，写出结构化 markdown 计划，用户确认前不得修改业务文件。" +
  "简单问答、单文件读取或单一明确产物不要使用。已经处于 plan mode 时不要重复调用。";

const EXIT_PLAN_MODE_DESCRIPTION =
  "提交已经写好的工作区任务计划供用户审核。" +
  "plan_file_path 必须指向当前项目 `.pilotdeck/plans` 下的 markdown 文件。" +
  "不要再用 ask_user_question 询问是否批准计划；本工具会展示计划并提供继续规划、开始执行和取消。";

function buildEnterPlanModeResult(planDirectoryPath: string | undefined): string {
  const planDirectorySection = planDirectoryPath
    ? `## 计划目录\n把计划写成 markdown 文件并保存到：${planDirectoryPath}\n文件名可自定，但必须位于这个目录中。\n`
    : "";

  return [
    "计划模式已启用。现在只查看材料并规划，用户批准前不要执行任务或修改业务文件。",
    "",
    planDirectorySection,
    "## 现在该做什么",
    "1. 用 read_file、grep、glob 查看当前工作区的附件、已有解析结果与 exports；不要探索或修改 PilotDeck 源码",
    "2. 查看系统列出的可用 skill，判断哪些步骤应使用医学 MCP、RAG 或 PDF/Word/PPT/表格/HTML skill",
    "3. 写清输入材料、执行顺序、每一步的产物路径、事实缺项与需要用户确认的选择；不要在计划里编造医学结论",
    ...(planDirectoryPath
      ? [
          "4. 在上面的计划目录中创建并完善 markdown 计划文件",
          "5. 计划完成后，用 exit_plan_mode 提交该 plan_file_path 供用户审核",
        ]
      : ["4. 计划完成后，调用 exit_plan_mode 交给用户审核"]),
    "",
    "## 规则",
    `- 禁止用 bash 写文件${planDirectoryPath ? "；write_file/edit_file 只能修改指定计划目录中的 markdown 计划" : ""}`,
    "- 可以用 ask_user_question 一次性澄清会改变计划的关键选择",
    "- 先读材料，再写计划；不要在用户批准前调用医学处理、转换或其它会产生业务结果的工具",
  ].join("\n");
}

function buildAlreadyInPlanModeResult(planDirectoryPath: string | undefined): string {
  return [
    "计划模式已经启用。",
    "",
    ...(planDirectoryPath
      ? [
          `计划目录：${planDirectoryPath}`,
          "继续完善该目录中的 markdown 计划，然后用 exit_plan_mode(plan_file_path) 明确提交其中一份。",
          "",
        ]
      : []),
    "调用 exit_plan_mode 前保持只读规划，不要执行任务。",
  ].join("\n");
}

function buildApprovedPlanResult(plan: string, planFilePath: string | undefined): string {
  const locationSection = planFilePath
    ? [
        `Submitted plan file: ${planFilePath}`,
        "You can refer back to it during implementation if needed.",
        "",
      ]
    : [];
  return [
    "用户已批准计划。现在按计划处理医学工作区任务。",
    "不要再输出“计划已批准、开始执行”之类确认语；用户已经知道。直接调用 todo_write，然后执行。",
    "调用任何非只读工具前，必须先用 todo_write 建立由批准计划导出的 markdown 清单。",
    "按计划 read_skill、调用所需的 mcp__med-tools__* 或办公工具，并只在当前工作区写业务产物。",
    "若调用 med_parse_medical 只是多步骤计划中的一步，必须传 continuation_mode=\"material\"，",
    "以便 G9 报告流式输出后继续完成病例报告、HTML 或其他未完成项；不要在解析成功后停止。",
    "每完成一个执行步骤后更新 todo_write，用 `- [x]` 标记完成项。",
    "",
    ...locationSection,
    "## Approved Plan",
    plan,
  ].join("\n");
}

function buildContinuePlanningResult(feedback: string | undefined): string {
  const feedbackSection = feedback
    ? `\n\nUser feedback:\n${feedback}`
    : "\n\nNo additional feedback was provided.";
  return [
    "用户要求继续规划，暂不执行任务。",
    "保持计划模式，根据反馈修改计划文件；更新完成后再次调用 exit_plan_mode。",
  ].join(" ") + feedbackSection;
}

function getExitPlanFeedback(answer: PilotDeckElicitationAnswer): string | undefined {
  if (answer.type !== "answered" || !answer.annotations) {
    return undefined;
  }
  for (const annotation of Object.values(answer.annotations)) {
    if (annotation?.notes?.trim()) {
      return annotation.notes.trim();
    }
  }
  return undefined;
}

function getExitPlanAction(answer: PilotDeckElicitationAnswer): "continue_planning" | "execute_plan" | undefined {
  if (answer.type !== "answered") {
    return undefined;
  }
  for (const value of Object.values(answer.answers)) {
    if (Array.isArray(value)) {
      const action = value.find((entry) => entry === EXIT_PLAN_MODE_CONTINUE || entry === EXIT_PLAN_MODE_EXECUTE);
      if (action) return action;
      continue;
    }
    if (value === EXIT_PLAN_MODE_CONTINUE || value === EXIT_PLAN_MODE_EXECUTE) {
      return value;
    }
  }
  return undefined;
}

export function createEnterPlanModeTool(): PilotDeckToolDefinition<Record<string, never>> {
  return {
    name: "enter_plan_mode",
    aliases: ["EnterPlanMode"],
    description: ENTER_PLAN_MODE_DESCRIPTION,
    kind: "session",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async (_input, context) => {
      if (context?.permissionMode === "plan") {
        throw new PilotDeckToolRuntimeError(
          "tool_execution_failed",
          buildAlreadyInPlanModeResult(context?.planDirectory?.path),
        );
      }
      const text = buildEnterPlanModeResult(context?.planDirectory?.path);
      return {
        content: [{ type: "text", text }],
        data: { requestedMode: "plan" },
      };
    },
  };
}

export function createExitPlanModeTool(): PilotDeckToolDefinition<ExitPlanModeInput, ExitPlanModeOutput> {
  return {
    name: "exit_plan_mode",
    aliases: ["ExitPlanMode"],
    description: EXIT_PLAN_MODE_DESCRIPTION,
    kind: "session",
    inputSchema: {
      type: "object",
      required: ["plan_file_path"],
      additionalProperties: false,
      properties: {
        plan_file_path: {
          type: "string",
          description: "Path to the markdown plan file to submit from the current project's `.pilotdeck/plans` directory.",
        },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    requiresUserInteraction: () => true,
    execute: async (input, context) => {
      if (context?.permissionMode !== "plan") {
        throw new PilotDeckToolRuntimeError(
          "tool_execution_failed",
          "exit_plan_mode can only be used while plan mode is active.",
        );
      }
      const channel = context?.elicitation;
      if (!channel) {
        throw new PilotDeckToolRuntimeError(
          "unsupported_tool",
          "exit_plan_mode requires a connected user interaction channel.",
        );
      }
      const resolvedPlanFilePath = context?.planDirectory?.resolve(input.plan_file_path);
      if (!resolvedPlanFilePath) {
        throw new PilotDeckToolRuntimeError(
          "invalid_tool_input",
          "plan_file_path must point to a markdown file under the current project's .pilotdeck/plans directory.",
        );
      }
      let plan: string;
      try {
        plan = readFileSync(resolvedPlanFilePath, "utf8").trim();
      } catch {
        throw new PilotDeckToolRuntimeError(
          "invalid_tool_input",
          `Plan file does not exist or could not be read: ${resolvedPlanFilePath}`,
        );
      }
      if (!plan) {
        throw new PilotDeckToolRuntimeError(
          "invalid_tool_input",
          "Plan file is empty. Write your plan first before calling exit_plan_mode.",
        );
      }
      const request: PilotDeckElicitationRequest = {
        toolCallId: context.turnId,
        toolName: "exit_plan_mode",
        previewFormat: "markdown",
        questions: [
          {
            question: EXIT_PLAN_MODE_QUESTION,
            header: "Plan",
            options: [
              {
                label: EXIT_PLAN_MODE_CONTINUE,
                description: "Keep planning and update the plan before any implementation starts.",
              },
              {
                label: EXIT_PLAN_MODE_EXECUTE,
                description: "Leave plan mode and let the agent execute this plan.",
              },
            ],
          },
        ],
        metadata: {
          source: "exit_plan_mode",
          plan,
          planFilePath: resolvedPlanFilePath,
        },
        ...(context.abortSignal ? { signal: context.abortSignal } : {}),
      };
      const answer = await channel.askUser(request);
      const action = getExitPlanAction(answer);
      const feedback = getExitPlanFeedback(answer);

      if (answer.type === "cancelled" || !action) {
        return {
          content: [{
            type: "text",
            text: "Exit plan mode was cancelled. Stay in plan mode and continue refining the plan file.",
          }],
          data: { plan, action: "cancelled" },
        };
      }

      if (action === EXIT_PLAN_MODE_EXECUTE) {
        context.planTodo?.markPlanApproved(plan);
        const titleMatch = plan.match(/^#\s+(.+)$/m);
        const planTitle = titleMatch?.[1];
        const summaryLines = plan.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
        const planSummary = summaryLines.slice(0, 2).join("\n").slice(0, 200) || undefined;
        return {
          content: [{
            type: "text",
            text: buildApprovedPlanResult(plan, resolvedPlanFilePath),
          }],
          data: { plan, action, requestedMode: "default", planFilePath: resolvedPlanFilePath, planTitle, planSummary },
        };
      }

      return {
        content: [{
          type: "text",
          text: buildContinuePlanningResult(feedback),
        }],
        data: { plan, action, ...(feedback ? { feedback } : {}) },
      };
    },
  };
}
