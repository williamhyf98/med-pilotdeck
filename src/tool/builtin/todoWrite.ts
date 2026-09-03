import type {
  PilotDeckTodoDiagnostics,
  PilotDeckTodoItem,
  PilotDeckTodoUpdate,
  PilotDeckToolDefinition,
  PilotDeckToolExecutionOutput,
} from "../protocol/types.js";

export type TodoWriteInput = {
  markdown?: string;
  todos?: PilotDeckTodoUpdate[];
  merge?: boolean;
  reason?: string;
};

export type TodoWriteOutput = {
  markdown?: string;
  todos: PilotDeckTodoItem[];
  mode: "read" | "markdown" | "structured";
  merge: boolean;
  reason?: string;
  diagnostics?: PilotDeckTodoDiagnostics;
};

const TODO_LINE_PATTERN = /^\s*[-*]\s+\[( |x|X)\]\s+(.*?)\s*$/u;

function normalizeTodoUpdatesForFallback(todos: PilotDeckTodoUpdate[]): PilotDeckTodoItem[] {
  return todos.map((todo, index) => ({
    id: todo.id?.trim() || `todo-${index + 1}`,
    content: todo.content?.trim() || "(no description)",
    status: todo.status ?? "pending",
    ...(todo.priority?.trim() ? { priority: todo.priority.trim() } : {}),
  }));
}

export function parseTodoMarkdown(markdown: string): PilotDeckTodoItem[] {
  const lines = markdown.split(/\r?\n/u);
  const parsed: Array<{ checked: boolean; content: string }> = [];
  for (const line of lines) {
    const match = TODO_LINE_PATTERN.exec(line);
    if (!match) continue;
    const content = match[2]?.trim();
    if (!content) continue;
    parsed.push({
      checked: match[1].toLowerCase() === "x",
      content,
    });
  }

  let assignedInProgress = false;
  return parsed.map((item, index) => {
    let status: PilotDeckTodoItem["status"];
    if (item.checked) {
      status = "completed";
    } else if (!assignedInProgress) {
      status = "in_progress";
      assignedInProgress = true;
    } else {
      status = "pending";
    }
    return {
      id: `todo-${index + 1}`,
      content: item.content,
      status,
    };
  });
}

export function createTodoWriteTool(): PilotDeckToolDefinition<TodoWriteInput, TodoWriteOutput> {
  return {
    name: "todo_write",
    aliases: ["TodoWrite"],
    description:
      [
        "读取或更新本会话的轻量待办清单，用于较复杂的工作。",
        "不带任何参数调用即可读取当前待办清单。",
        "更新可编辑待办时，传入带稳定 id 的 `todos`；可选 `merge=true`，按 id 更新已有条目或追加新条目。",
        "沿用旧版清单格式时，传入 `markdown`，已完成项写作 `- [x]`，未完成项写作 `- [ ]`。",
        "适用于 3 步以上的复杂任务、多份交付物的工作、资料梳理、批量处理、信息收集或内容生成。",
        "先做少量探查再写详细清单；把待办当作可勾选的检查点，而不是锁死的计划。",
        "状态取值为 pending、in_progress、completed 或 cancelled。尽量同时只保留一项 in_progress。",
        "只有在核对过相关证据之后才把条目标记为 completed。若某个做法失败或前提发生变化，应把旧条目标记为 cancelled 并新增修订后的条目，而不是悄悄改写成已完成。",
        "任务进行中调整待办结构时，请附上 `reason`，使这次变更在工具结果中可追溯。",
        "在适用时，建议保留一个最终校验检查点，用于核对产出内容、格式、数量、额外产物和关键约束。",
        "本工具只更新清单，不写文件、不提交，也不能替代最终计划。",
        "在计划模式下，不要用 todo_write 来撰写计划本身，也不要把待办清单当成最终计划。",
        "在计划模式下，todo_write 只能用于组织规划工作，例如探查、分析，以及在 `.pilotdeck/plans/` 下撰写 markdown 计划。计划就绪后，向用户展示并等待其退出计划模式。",
      ].join(" "),
    kind: "session",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        markdown: {
          type: "string",
          description: "旧版 markdown 清单内容，使用 `- [ ]` 和 `- [x]` 条目，会替换当前清单。",
        },
        todos: {
          type: "array",
          description: "可编辑的待办条目。省略该字段即读取当前清单。配合 merge=true 时，条目可只包含 id 和需要更新的字段。",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: {
                type: "string",
                description: "稳定的待办标识。要可靠地按 id 合并更新已有条目，必须提供。",
              },
              content: {
                type: "string",
                description: "待办条目的描述。",
              },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed", "cancelled"],
                description: "当前待办状态。",
              },
              priority: {
                type: "string",
                description: "可选的优先级标签，例如 high、medium 或 low。",
              },
            },
          },
        },
        merge: {
          type: "boolean",
          description: "传入 todos 时：true 表示按 id 更新已有条目并追加新条目；false 表示整体替换清单。",
          default: false,
        },
        reason: {
          type: "string",
          description: "可选，说明待办结构变更的原因，尤其是新增、取消或重排条目时。",
        },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async (input, context): Promise<PilotDeckToolExecutionOutput<TodoWriteOutput>> => {
      let mode: TodoWriteOutput["mode"] = "read";
      let snapshot = context.planTodo?.getSnapshot();
      let todos = snapshot?.todos ?? [];
      const merge = Boolean(input.merge);
      const reason = input.reason?.trim();

      if (Array.isArray(input.todos)) {
        mode = "structured";
        todos = context.planTodo?.writeTodos(input.todos, { merge, reason }) ?? normalizeTodoUpdatesForFallback(input.todos);
      } else if (typeof input.markdown === "string") {
        mode = "markdown";
        todos = parseTodoMarkdown(input.markdown);
        todos = context.planTodo?.recordTodoWrite(input.markdown, todos, { reason }) ?? todos;
      }
      snapshot = context.planTodo?.getSnapshot();
      const diagnostics = snapshot?.todoDiagnostics;

      return {
        content: [{ type: "text", text: formatTodoWriteResult(mode, todos, { merge, reason, diagnostics }) }],
        data: {
          ...(typeof input.markdown === "string" ? { markdown: input.markdown } : {}),
          todos,
          mode,
          merge,
          ...(reason ? { reason } : {}),
          ...(diagnostics ? { diagnostics } : {}),
        },
        metadata: {
          todoCount: todos.length,
          mode,
          ...(diagnostics ? { diagnostics } : {}),
        },
      };
    },
  };
}

function formatTodoWriteResult(
  mode: TodoWriteOutput["mode"],
  todos: PilotDeckTodoItem[],
  options: {
    merge: boolean;
    reason?: string;
    diagnostics?: PilotDeckTodoDiagnostics;
  },
): string {
  const lines = [mode === "read" ? "Todo list read:" : "Todo list updated:"];
  lines.push(`mode=${mode} merge=${options.merge} count=${todos.length}`);
  if (options.reason) {
    lines.push(`reason: ${options.reason}`);
  }
  if (todos.length === 0) {
    lines.push("No todos are currently recorded.");
  } else {
    for (const todo of todos) {
      const priority = todo.priority ? ` priority=${todo.priority}` : "";
      lines.push(`- [${todo.status}] id=${todo.id}${priority} ${todo.content}`);
    }
  }
  if (options.diagnostics) {
    lines.push("", "Diagnostics:", JSON.stringify(options.diagnostics));
  }
  return lines.join("\n");
}
