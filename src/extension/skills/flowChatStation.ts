import type { StructuredModelClient } from "../../trauma/modelClient.js";

/**
 * "从流程图创建技能"界面里对话式改图的工位：输入当前画布上的流程图
 * （节点 + 连线）与聊天记录，用一次结构化模型调用产出**修改后的完整
 * 流程图**和一句简短回复。无副作用、不落盘；画布状态始终由前端持有，
 * 这里只做"文本进、JSON 出"的纯转换（与 draftStation 同构，模型客户端
 * 由调用方注入，见 createLocalGateway 的 ProjectRuntimeRegistry）。
 *
 * 模型输出的是全量图而非增量补丁——补丁需要前端做合并与冲突处理，
 * 全量图只需按 id 保留已有节点的画布坐标即可，对模型与前端都更稳。
 */

export type FlowChatNodeKind = "step" | "decision";

export interface FlowChatNode {
  id: string;
  kind: FlowChatNodeKind;
  text: string;
}

export interface FlowChatEdge {
  source: string;
  target: string;
  /** 仅当 source 是判断节点时为 "yes" / "no"，否则为 null。 */
  sourceHandle: "yes" | "no" | null;
}

export interface FlowChatGraph {
  nodes: FlowChatNode[];
  edges: FlowChatEdge[];
}

export interface FlowChatMessage {
  role: "user" | "assistant";
  text: string;
}

export interface FlowChatInput {
  /** 用户当前画布上的流程图（可能为空图）。 */
  flow: FlowChatGraph;
  /** 完整对话历史，最后一条必须是用户的最新消息。 */
  messages: FlowChatMessage[];
}

export interface FlowChatResult {
  reply: string;
  flow: FlowChatGraph;
}

export interface SkillFlowChatStation {
  chat(input: FlowChatInput): Promise<FlowChatResult>;
}

/** 与 UI/路由共用的上限：超出即视为异常输入。 */
export const FLOW_CHAT_MAX_NODES = 100;
export const FLOW_CHAT_MAX_EDGES = 300;
export const FLOW_CHAT_MAX_NODE_TEXT_CHARS = 2000;
export const FLOW_CHAT_MAX_REPLY_CHARS = 2000;

/**
 * strict 模式：additionalProperties:false 且 required 覆盖全部字段；
 * 可选语义（步骤节点出线无分支）用可空 branch 表达，由 stripNulls 抹掉。
 * 模型侧字段名用 branch 而非 ReactFlow 的 sourceHandle——对模型而言
 * "分支"才是语义；normalize 阶段再映射回 sourceHandle。
 */
export const SKILL_FLOW_CHAT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "nodes", "edges"],
  properties: {
    reply: {
      type: "string",
      description: "给用户的简短回复（1~3 句，与用户语言一致），不要罗列整个流程图",
    },
    nodes: {
      type: "array",
      description: "修改后的全部节点（全量，不是增量）",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "kind", "text"],
        properties: {
          id: {
            type: "string",
            description: "节点唯一 id；保留的节点必须沿用原 id，新节点用 c1、c2… 等不冲突的新 id",
          },
          kind: {
            type: "string",
            enum: ["step", "decision"],
            description: "step=步骤节点；decision=判断节点（是/否分支）",
          },
          text: {
            type: "string",
            description: "节点文字，精炼的一句话；判断节点写成问句",
          },
        },
      },
    },
    edges: {
      type: "array",
      description: "修改后的全部连线（全量，不是增量）",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["source", "target", "branch"],
        properties: {
          source: { type: "string", description: "起点节点 id" },
          target: { type: "string", description: "终点节点 id" },
          branch: {
            type: ["string", "null"],
            description: "起点是判断节点时为 yes（是）或 no（否）；起点是步骤节点时必须为 null",
          },
        },
      },
    },
  },
} as const;

export const SKILL_FLOW_CHAT_SYSTEM_PROMPT = `你是 PilotDeck（医疗 AI 工作台）"从流程图创建技能"界面里的流程图协作助手。画布上用"步骤"和"判断"两种节点描述一个工作流程，用户既可以手动编辑画布，也可以在旁边的对话框里让你代为修改。你的任务是：根据用户的最新消息和当前画布上的流程图，输出**修改后的完整流程图**（全量节点与连线）和一句简短回复。

## 节点与连线模型
- 节点两种：step（步骤，做一件事）和 decision（判断，提出一个是/否问题）。
- 节点字段：id（唯一标识）、kind（step 或 decision）、text（节点文字）。
- 连线字段：source（起点 id）、target（终点 id）、branch（仅当起点是 decision 时为 "yes" 或 "no"，表示判断为是/否各走哪条线；起点是 step 时必须为 null）。
- 一个 decision 节点最多一条 yes 出线和一条 no 出线；step 节点通常只有一条出线。

## 修改规则
- 输出全量流程图（修改后的所有节点和所有连线），不是增量补丁。
- 尽量保留用户已有的节点并沿用原 id——前端靠 id 保留节点在画布上的位置；只有用户明确要求删除或替换时才移除。
- 修改某个节点的文字时沿用它的原 id；新增节点使用不与现有 id 冲突的新 id（建议 c1、c2… 依次递增）。
- 文字为空的节点是画布上的占位节点：往流程里添加内容时优先复用它的 id 填入文字，多余的占位节点可以删除。
- 用户只是提问或闲聊、没有要求修改时，原样返回当前流程图（节点与连线一律不动），仅在 reply 中回答。
- 节点文字保持精炼（一句话以内），判断节点写成问句；不得超过 2000 字。
- 不要虚构用户没有提到的业务规则、数值或标准；可以按常识补全流程结构（如分支的汇合点）。

## reply 要求
- 与用户语言一致，1~3 句话，说明你改了什么或回答用户的问题；不要在 reply 里罗列整个流程图。

## 严格要求
- 仅输出符合给定 JSON Schema 的对象，不要输出任何多余文字或解释。`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 画布为空（或只剩占位节点）时也给出明确提示，避免模型误以为输入缺失。 */
export function serializeFlowForChat(flow: FlowChatGraph): string {
  if (flow.nodes.length === 0) {
    return "（画布为空，还没有任何节点）";
  }
  const lines: string[] = ["节点（id ｜ 类型 ｜ 文字）："];
  for (const node of flow.nodes) {
    const kindLabel = node.kind === "decision" ? "判断" : "步骤";
    const text = node.text.trim() ? node.text.trim() : "（空）";
    lines.push(`- ${node.id} ｜ ${kindLabel} ｜ ${text}`);
  }
  if (flow.edges.length > 0) {
    lines.push("连线：");
    for (const edge of flow.edges) {
      const branch = edge.sourceHandle === "yes"
        ? " →（是）"
        : edge.sourceHandle === "no"
          ? " →（否）"
          : " →";
      lines.push(`- ${edge.source}${branch}→ ${edge.target}`);
    }
  } else {
    lines.push("连线：（无）");
  }
  return lines.join("\n");
}

export function buildFlowChatUserMessage(input: FlowChatInput): string {
  const history = input.messages.slice(0, -1);
  const latest = input.messages[input.messages.length - 1];
  const lines: string[] = [
    "以下是当前画布上的流程图、此前的对话历史和用户的最新消息。请据此输出修改后的完整流程图和简短回复。",
    "",
    "<当前流程图>",
    serializeFlowForChat(input.flow),
    "</当前流程图>",
  ];
  if (history.length > 0) {
    lines.push("", "<对话历史>");
    for (const message of history) {
      lines.push(`${message.role === "user" ? "用户" : "助手"}：${message.text}`);
    }
    lines.push("</对话历史>");
  }
  lines.push(
    "",
    "<用户最新消息>",
    latest?.text ?? "",
    "</用户最新消息>",
    "",
    "请仅输出 JSON。",
  );
  return lines.join("\n");
}

function isValidNode(value: unknown): value is FlowChatNode {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || value.id.trim() === "") return false;
  if (value.kind !== "step" && value.kind !== "decision") return false;
  if (typeof value.text !== "string") return false;
  return true;
}

function isValidEdge(value: unknown): value is FlowChatEdge {
  if (!isRecord(value)) return false;
  if (typeof value.source !== "string" || typeof value.target !== "string") return false;
  if (value.sourceHandle !== "yes" && value.sourceHandle !== "no" && value.sourceHandle !== null) {
    return false;
  }
  return true;
}

export function validateFlowChatResult(value: unknown): value is FlowChatResult {
  if (!isRecord(value)) return false;
  if (typeof value.reply !== "string" || value.reply.trim() === "") return false;
  if (!isRecord(value.flow)) return false;
  const flow = value.flow;
  if (!Array.isArray(flow.nodes) || !flow.nodes.every(isValidNode)) return false;
  if (!Array.isArray(flow.edges) || !flow.edges.every(isValidEdge)) return false;
  return true;
}

/**
 * 把模型输出（flat 的 {reply, nodes, edges}，branch 字段）修复成
 * FlowChatResult：重排字段、保证 id 唯一、裁剪超长文本、丢弃悬空连线、
 * 修正分支标记。轻微越界（重复 id、step 节点带 branch）在这里修复而
 * 不是判为 schema 失败，减少无谓的整次重试。
 */
export function normalizeFlowChatResult(value: unknown): unknown {
  if (!isRecord(value)) return value;

  const reply = typeof value.reply === "string" && value.reply.trim()
    ? value.reply.trim().slice(0, FLOW_CHAT_MAX_REPLY_CHARS)
    : "流程图已更新。";

  const nodes: FlowChatNode[] = [];
  const takenIds = new Set<string>();
  const rawNodes = Array.isArray(value.nodes) ? value.nodes : [];
  let reassignSeq = 1;
  for (const raw of rawNodes) {
    if (nodes.length >= FLOW_CHAT_MAX_NODES) break;
    if (!isRecord(raw)) continue;
    let id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!id || takenIds.has(id)) {
      // 丢失/重复 id 的节点换一个不冲突的新 id；引用原 id 的连线会落到
      // 第一个（被保留的）节点上，这是对重复 id 最自然的解读。
      do {
        id = `x${reassignSeq}`;
        reassignSeq += 1;
      } while (takenIds.has(id));
    }
    takenIds.add(id);
    const kind: FlowChatNodeKind = raw.kind === "decision" ? "decision" : "step";
    const text = typeof raw.text === "string"
      ? raw.text.trim().slice(0, FLOW_CHAT_MAX_NODE_TEXT_CHARS)
      : "";
    nodes.push({ id, kind, text });
  }

  const kindById = new Map(nodes.map((node) => [node.id, node.kind]));
  const edges: FlowChatEdge[] = [];
  const seenEdges = new Set<string>();
  const rawEdges = Array.isArray(value.edges) ? value.edges : [];
  for (const raw of rawEdges) {
    if (edges.length >= FLOW_CHAT_MAX_EDGES) break;
    if (!isRecord(raw)) continue;
    const source = typeof raw.source === "string" ? raw.source.trim() : "";
    const target = typeof raw.target === "string" ? raw.target.trim() : "";
    if (!kindById.has(source) || !kindById.has(target) || source === target) continue;
    // 容错：branch（schema 字段）为主，也接受模型照搬输入里的 sourceHandle。
    const branchRaw = raw.branch ?? raw.sourceHandle;
    const sourceHandle: FlowChatEdge["sourceHandle"] =
      kindById.get(source) === "decision" && (branchRaw === "yes" || branchRaw === "no")
        ? branchRaw
        : null;
    const key = JSON.stringify([source, target, sourceHandle]);
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    edges.push({ source, target, sourceHandle });
  }

  return { reply, flow: { nodes, edges } };
}

export function createSkillFlowChatStation(model: StructuredModelClient): SkillFlowChatStation {
  return {
    async chat(input: FlowChatInput): Promise<FlowChatResult> {
      return model.completeJson<FlowChatResult>({
        name: "skill_flow_chat",
        system: SKILL_FLOW_CHAT_SYSTEM_PROMPT,
        user: buildFlowChatUserMessage(input),
        schema: SKILL_FLOW_CHAT_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
        validate: validateFlowChatResult,
        normalize: normalizeFlowChatResult,
      });
    },
  };
}
