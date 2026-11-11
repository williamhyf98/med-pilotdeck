import type { DocumentOptions } from "./documentCommandSpecs.js";

const I = "input", O = "output", N = "number", B = "switch";

/**
 * 非文档类技能的命令表面（spec §10.4.1）。
 *
 * 与 `DOCUMENT_COMMAND_SPECS` 同构：id 形如 `<skill>.<subcommand>`，
 * 与 `skills/<skill>/scripts/<file>.sh <subcommand>` 一一对应。
 * 这里**只登记需要"零弹窗"的运行入口**，不登记 `bootstrap-runtime` 等构建期命令。
 */
export const SKILL_COMMAND_SPECS: Readonly<Record<string, DocumentOptions>> = Object.freeze({
  // heads: bash skills/data-analysis/scripts/analysis.sh run --script ... --input ... --out ...
  "data-analysis.run": {
    "--script": I,
    "--input": I,
    "--out": O,
    "--timeout": N,
    "--mem-mb": N,
  },
  // 只读体检：返回运行时是否就绪、依赖版本
  "data-analysis.check": { "--json": B },
});

for (const options of Object.values(SKILL_COMMAND_SPECS)) Object.freeze(options);
