import {
  createRegisteredDocumentMakeTool,
  type CreateRegisteredDocumentMakeToolOptions,
  type RegisteredDocumentMakeInput,
  type RegisteredDocumentMakeOutput,
} from "./registeredDocumentMake.js";
import type { PilotDeckToolDefinition } from "../protocol/types.js";

type CommonMakeInput = RegisteredDocumentMakeInput;

export type DocxMakeInput = CommonMakeInput;
export type PptxMakeInput = CommonMakeInput & {
  locale?: string;
  footer?: string;
  theme?: string;
};
export type SpreadsheetMakeInput = CommonMakeInput & {
  csv_path?: string;
  tsv_path?: string;
  input_path?: string;
  sheet?: string;
  encoding?: string;
  infer_types?: boolean;
};
export type DiagramMakeInput = CommonMakeInput & {
  theme?: string;
  direction?: string;
  format?: string;
};

export type DocumentMakeOutput = RegisteredDocumentMakeOutput;

const commonProperties = {
  title: { type: "string", description: "文档标题。" },
  body: { type: "string", description: "简短正文。" },
  body_file_path: { type: "string", description: "任务内正文文件路径。" },
  markdown_path: { type: "string", description: "任务内 Markdown 文件路径。" },
  spec_path: { type: "string", description: "任务内 JSON spec 文件路径。" },
  output_path: { type: "string", description: "最终输出路径，通常位于 exports/。" },
  force: { type: "boolean", description: "仅明确要求替换已有文件时设为 true。" },
  timeout_ms: { type: "integer", description: "可选前台超时时间，最大 600000 毫秒。" },
} as const;

const commonOutputSchema = {
  type: "object",
  required: ["status", "output"],
  additionalProperties: false,
  properties: {
    status: { type: "string" },
    output: { type: "string" },
    preview: { type: "array", items: { type: "string" } },
    audit: { type: ["object", "string"] },
    warning: { type: "string" },
  },
} as const;

export type CreateDocumentMakeToolOptions = CreateRegisteredDocumentMakeToolOptions;

export function createDocxMakeTool(
  options: CreateDocumentMakeToolOptions = {},
): PilotDeckToolDefinition<DocxMakeInput, DocumentMakeOutput> {
  return createRegisteredDocumentMakeTool<DocxMakeInput>({
    name: "docx_make",
    alias: "docx.make",
    title: "Create DOCX",
    description:
      "根据文本、Markdown 或声明式 spec 创建新的 Word 文档。后端使用已登记的 DOCX Skill，"
      + "输入和输出受当前任务目录约束；不要拼接 Bash、不要调用 Python 或自行安装依赖。",
    capability: "docx.make",
    inputSchema: {
      type: "object",
      required: ["output_path"],
      additionalProperties: false,
      properties: commonProperties,
    },
    outputSchema: commonOutputSchema,
    outputMimeTypes: {
      ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
    buildOptions: (input) => ({
      ...(input.title !== undefined ? { "--title": input.title } : {}),
      ...(input.body !== undefined ? { "--body": input.body } : {}),
      ...(input.body_file_path !== undefined ? { "--body-file": input.body_file_path } : {}),
      ...(input.markdown_path !== undefined ? { "--markdown": input.markdown_path } : {}),
      ...(input.spec_path !== undefined ? { "--spec": input.spec_path } : {}),
    }),
  }, options);
}

export function createPptxMakeTool(
  options: CreateDocumentMakeToolOptions = {},
): PilotDeckToolDefinition<PptxMakeInput, DocumentMakeOutput> {
  return createRegisteredDocumentMakeTool<PptxMakeInput>({
    name: "pptx_make",
    alias: "pptx.make",
    title: "Create PPTX",
    description:
      "根据文本、Markdown 或声明式 spec 创建新的 PowerPoint 演示文稿。后端使用已登记的 PPTX Skill，"
      + "输入和输出受当前任务目录约束；不要拼接 Bash、不要编写 builder 或自行安装依赖。",
    capability: "pptx.make",
    inputSchema: {
      type: "object",
      required: ["output_path"],
      additionalProperties: false,
      properties: {
        ...commonProperties,
        locale: { type: "string", description: "演示文稿语言，例如 zh-CN。" },
        footer: { type: "string", description: "页脚文本。" },
        theme: { type: "string", description: "已登记的演示主题。" },
      },
    },
    outputSchema: commonOutputSchema,
    outputMimeTypes: {
      ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    },
    buildOptions: (input) => ({
      ...(input.title !== undefined ? { "--title": input.title } : {}),
      ...(input.body !== undefined ? { "--body": input.body } : {}),
      ...(input.body_file_path !== undefined ? { "--body-file": input.body_file_path } : {}),
      ...(input.markdown_path !== undefined ? { "--markdown": input.markdown_path } : {}),
      ...(input.spec_path !== undefined ? { "--spec": input.spec_path } : {}),
      ...(input.locale !== undefined ? { "--locale": input.locale } : {}),
      ...(input.footer !== undefined ? { "--footer": input.footer } : {}),
      ...(input.theme !== undefined ? { "--theme": input.theme } : {}),
    }),
  }, options);
}

export function createSpreadsheetMakeTool(
  options: CreateDocumentMakeToolOptions = {},
): PilotDeckToolDefinition<SpreadsheetMakeInput, DocumentMakeOutput> {
  return createRegisteredDocumentMakeTool<SpreadsheetMakeInput>({
    name: "spreadsheets_make",
    alias: "spreadsheets.make",
    title: "Create Spreadsheet",
    description:
      "根据文本、Markdown、CSV、TSV 或声明式 spec 创建新的电子表格。后端使用已登记的表格 Skill，"
      + "输入和输出受当前任务目录约束；不要拼接 Bash、不要调用 Node 或自行安装依赖。",
    capability: "spreadsheets.make",
    inputSchema: {
      type: "object",
      required: ["output_path"],
      additionalProperties: false,
      properties: {
        ...commonProperties,
        csv_path: { type: "string", description: "任务内 CSV 输入路径。" },
        tsv_path: { type: "string", description: "任务内 TSV 输入路径。" },
        input_path: { type: "string", description: "任务内已有 XLSX 输入路径，仅与 spec_path 配合使用。" },
        sheet: { type: "string", description: "目标工作表名称。" },
        encoding: { type: "string", description: "CSV/TSV 编码。" },
        infer_types: { type: "boolean", description: "是否推断 CSV/TSV 单元格类型。" },
      },
    },
    outputSchema: commonOutputSchema,
    outputMimeTypes: {
      ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".csv": "text/csv",
      ".tsv": "text/tab-separated-values",
    },
    buildOptions: (input) => ({
      ...(input.title !== undefined ? { "--title": input.title } : {}),
      ...(input.body !== undefined ? { "--body": input.body } : {}),
      ...(input.body_file_path !== undefined ? { "--body-file": input.body_file_path } : {}),
      ...(input.markdown_path !== undefined ? { "--markdown": input.markdown_path } : {}),
      ...(input.csv_path !== undefined ? { "--csv": input.csv_path } : {}),
      ...(input.tsv_path !== undefined ? { "--tsv": input.tsv_path } : {}),
      ...(input.spec_path !== undefined ? { "--spec": input.spec_path } : {}),
      ...(input.input_path !== undefined ? { "--input": input.input_path } : {}),
      ...(input.sheet !== undefined ? { "--sheet": input.sheet } : {}),
      ...(input.encoding !== undefined ? { "--encoding": input.encoding } : {}),
      ...(input.infer_types ? { "--infer-types": true } : {}),
    }),
    validateExtra: (input) => {
      const issues: Array<{ path: string; code: "invalid_schema"; message: string }> = [];
      const sources = [
        input.body,
        input.body_file_path,
        input.markdown_path,
        input.csv_path,
        input.tsv_path,
        input.spec_path,
      ].filter((value) => value !== undefined);
      if (sources.length > 1) {
        issues.push({
          path: "body",
          code: "invalid_schema",
          message: "Spreadsheet content sources are mutually exclusive.",
        });
      }
      if (input.input_path !== undefined && input.spec_path === undefined) {
        issues.push({
          path: "input_path",
          code: "invalid_schema",
          message: "input_path requires spec_path for controlled workbook edits.",
        });
      }
      return issues;
    },
  }, options);
}

export function createDiagramMakeTool(
  options: CreateDocumentMakeToolOptions = {},
): PilotDeckToolDefinition<DiagramMakeInput, DocumentMakeOutput> {
  return createRegisteredDocumentMakeTool<DiagramMakeInput>({
    name: "diagram_make",
    alias: "diagram.make",
    title: "Create Diagram",
    description:
      "根据正文、Mermaid 或声明式 spec 创建离线 SVG/HTML 图示。后端使用已登记的图示 Skill，"
      + "输入和输出受当前任务目录约束；不要拼接 Bash、不要手写 SVG 或自行安装依赖。",
    capability: "diagram.make",
    inputSchema: {
      type: "object",
      required: ["output_path"],
      additionalProperties: false,
      properties: {
        ...commonProperties,
        theme: { type: "string", description: "clean 或 architecture。" },
        direction: { type: "string", description: "LR、RL、TB 或 TD。" },
        format: { type: "string", description: "svg 或 html。" },
      },
    },
    outputSchema: commonOutputSchema,
    outputMimeTypes: {
      ".svg": "image/svg+xml",
      ".html": "text/html",
      ".htm": "text/html",
    },
    buildOptions: (input) => ({
      ...(input.title !== undefined ? { "--title": input.title } : {}),
      ...(input.body !== undefined ? { "--body": input.body } : {}),
      ...(input.markdown_path !== undefined ? { "--markdown": input.markdown_path } : {}),
      ...(input.spec_path !== undefined ? { "--spec": input.spec_path } : {}),
      ...(input.theme !== undefined ? { "--theme": input.theme } : {}),
      ...(input.direction !== undefined ? { "--direction": input.direction } : {}),
      ...(input.format !== undefined ? { "--format": input.format } : {}),
    }),
    validateExtra: (input) => {
      const issues: Array<{ path: string; code: "invalid_schema"; message: string }> = [];
      const extension = input.output_path.toLowerCase().endsWith(".html")
        || input.output_path.toLowerCase().endsWith(".htm")
        ? "html"
        : "svg";
      if (input.format !== undefined && input.format !== extension) {
        issues.push({
          path: "format",
          code: "invalid_schema",
          message: "format must match the output_path extension.",
        });
      }
      return issues;
    },
  }, options);
}

