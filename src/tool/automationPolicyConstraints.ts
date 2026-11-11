import { basename, extname } from "node:path";

const EXECUTABLE_SOURCE_EXTENSIONS = new Set([
  ".bash",
  ".bat",
  ".c",
  ".cc",
  ".cjs",
  ".cpp",
  ".cs",
  ".fs",
  ".fish",
  ".go",
  ".h",
  ".hpp",
  ".ipynb",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".kts",
  ".lua",
  ".mjs",
  ".ps1",
  ".psm1",
  ".php",
  ".pl",
  ".py",
  ".pyw",
  ".r",
  ".rb",
  ".rs",
  ".scala",
  ".sh",
  ".swift",
  ".ts",
  ".tsx",
  ".vbs",
  ".zsh",
  ".cmd",
]);

const EXECUTABLE_SOURCE_FILENAMES = new Set([
  "cmakelists.txt",
  "dockerfile",
  "gemfile",
  "makefile",
  "rakefile",
]);

const BUNDLED_DOCUMENT_ENTRYPOINT =
  /\bbash\s+(?:"[^"]*(?:pdf|docx|pptx|spreadsheet|diagram)\.sh"|'[^']*(?:pdf|docx|pptx|spreadsheet|diagram)\.sh'|[^\s;&|]*(?:pdf|docx|pptx|spreadsheet|diagram)\.sh)(?=$|[\s;&|])/giu;
// data-analysis 的唯一入口要求 `--script <scratch/*.py>`，参数本身就是脚本路径。
// 它整条调用（入口 + 参数）一起视为受信任：参数由命令策略白名单
// （security/policy/skillCommandSpecs.ts）和执行器自己再校验一遍。
// 注意只吃到 `;&|` 为止，管道后面的东西照旧逐条检查。
const BUNDLED_ANALYSIS_ENTRYPOINT =
  /\bbash\s+(?:"[^"]*\/analysis\.sh"|'[^']*\/analysis\.sh'|[^\s;&|]*\/analysis\.sh) *[^;&|]*/giu;
// Keeps the stripped entrypoint's own arguments out of command position, so subcommands
// such as `make` are not mistaken for the build tool of the same name.
const BUNDLED_ENTRYPOINT_PLACEHOLDER = " bundled-entrypoint ";
const COMMAND_POSITION = String.raw`(?:^|[;&|]\s*|\$\(\s*)`;
const COMMAND_WRAPPERS = String.raw`(?:(?:(?:command|nohup|sudo)\s+|env(?:\s+-\S+)*\s+))*`;
const EXECUTOR_POSITION = String.raw`(?:\b(?:xargs(?:\s+-\S+)*|-exec)\s+)`;
const OPTIONAL_COMMAND_PATH = String.raw`(?:[^\s;&|]*\/)?`;
const INTERPRETER_OR_COMPILER_NAME =
  String.raw`(?:python(?:\d+(?:\.\d+)*)?|pypy\d*|node|bun|deno|tsx|ts-node|ruby|perl|php|lua|Rscript|awk|gawk|mawk|tclsh|wish|expect|groovy|clojure|julia|octave|matlab|osascript|powershell|pwsh|cmd(?:\.exe)?|wscript|cscript|swift|java|javac|dotnet|gcc|g\+\+|cc|c\+\+|clang|rustc|go\s+run|cargo\s+run)`;
const SHELL_NAME = String.raw`(?:bash|sh|zsh|dash|ksh|fish|csh|tcsh)`;
const INTERPRETER_OR_COMPILER = new RegExp(
  String.raw`${COMMAND_POSITION}${COMMAND_WRAPPERS}${OPTIONAL_COMMAND_PATH}${INTERPRETER_OR_COMPILER_NAME}\b|${EXECUTOR_POSITION}${OPTIONAL_COMMAND_PATH}${INTERPRETER_OR_COMPILER_NAME}\b`,
  "iu",
);
const SHELL_EXECUTION = new RegExp(
  String.raw`${COMMAND_POSITION}${COMMAND_WRAPPERS}${OPTIONAL_COMMAND_PATH}${SHELL_NAME}\b|${EXECUTOR_POSITION}${OPTIONAL_COMMAND_PATH}${SHELL_NAME}\b`,
  "iu",
);
const INLINE_PROGRAM =
  /<<<?|(?:^|[;&|]\s*|\$\(\s*)(?:eval|source)\b/iu;
const EXECUTABLE_FILE_OPERATION =
  /(?:>|>>|\btee(?:\s+-a)?|\b(?:cp|mv|install)\b)[^\n;&|]*\.(?:bash|bat|c|cc|cjs|cmd|cpp|cs|fish|fs|go|java|js|jsx|kt|kts|lua|mjs|php|pl|ps1|psm1|py|pyw|r|rb|rs|scala|sh|swift|ts|tsx|vbs|zsh)\b/iu;
const EXECUTION_ENABLEMENT =
  /(?:^|[\s;&|])chmod\s+(?:[^\n;&|]*\+x|[0-7]*[1357][0-7]{2})\b/iu;
const BUILD_OR_PACKAGE_RUNNER =
  /(?:^|[;&|]\s*|\$\(\s*)(?:(?:env|xargs)\s+)?(?:make|cmake|ninja|npm|npx|pnpm|yarn|pip|pip3|uv|poetry|composer|gradle|mvn)\b/iu;
const DIRECT_EXECUTABLE_PATH = /(?:^|[;&|]\s*)(?:\.{1,2}\/|\/)[^\s;&|]+/u;
const EXECUTABLE_SOURCE_IN_COMMAND =
  /(?:^|[\s"'`=<>|;&()])(?:[^\s"'`=<>|;&()]*\/)?[^\s"'`=<>|;&()]+\.(?:bash|bat|c|cc|cjs|cmd|cpp|cs|fish|fs|go|java|js|jsx|kt|kts|lua|mjs|php|pl|ps1|psm1|py|pyw|r|rb|rs|scala|sh|swift|ts|tsx|vbs|zsh)(?=$|[\s"'`=<>|;&()])/iu;

export function isExecutableSourcePath(filePath: string): boolean {
  const name = basename(filePath).toLowerCase();
  return EXECUTABLE_SOURCE_EXTENSIONS.has(extname(name)) || EXECUTABLE_SOURCE_FILENAMES.has(name);
}

/**
 * data-analysis 的唯一入口要求 agent **先写脚本再交给 analysis.sh**：
 * `run --script` 只接受工作区 `scratch/**` 下的 `.py`，执行前由
 * `analysis_guard.scan_source()` 扫描危险调用，并在 analysis 自己的沙箱里跑。
 * 所以这里是"声明式输入文件"，不是可执行程序，写它不应该被
 * "blocks writing executable source" 挡住——否则技能自相矛盾、根本用不了。
 *
 * 放行条件刻意收得很窄：
 * - 只放行 `.py`（`.sh`/`.js`/`.mjs` 等能绕过 guard 的形式一律不放行）
 * - 路径里必须真的含 `scratch` 这一段，且不允许任何 `..`（防止借 scratch/ 写到别处）
 */
export function isAnalysisScratchScriptPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/gu, "/");
  if (extname(normalized).toLowerCase() !== ".py") return false;
  const segments = normalized.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.some((segment) => segment === "..")) return false;
  return segments.includes("scratch");
}

export function getAutomationPolicyViolation(toolName: string, input: unknown): string | undefined {
  if (toolName === "write_file" || toolName === "edit_file") {
    const filePath = readStringField(input, "file_path") ?? readStringField(input, "path");
    if (!filePath || !isExecutableSourcePath(filePath)) return undefined;
    if (isAnalysisScratchScriptPath(filePath)) return undefined;
    return [
      `Automation policy blocks writing executable source '${filePath}'.`,
      "Exception: data-analysis scripts are written to the workspace scratch/ (scratch/**.py) "
        + "and executed only through analysis.sh, which sandboxes them.",
      "Use registered tools and bundled skill entrypoints with declarative Markdown, JSON, CSV, TSV, or text inputs.",
      "If no bundled tool supports the operation, stop and explain the limitation.",
    ].join(" ");
  }

  if (toolName !== "bash") return undefined;
  const command = readStringField(input, "command");
  if (!command) return undefined;

  const commandWithoutBundledEntrypoints = command.replace(
    BUNDLED_ANALYSIS_ENTRYPOINT,
    BUNDLED_ENTRYPOINT_PLACEHOLDER,
  ).replace(
    BUNDLED_DOCUMENT_ENTRYPOINT,
    BUNDLED_ENTRYPOINT_PLACEHOLDER,
  );
  let reason: string | undefined;
  if (INTERPRETER_OR_COMPILER.test(commandWithoutBundledEntrypoints)) {
    reason = "direct interpreter or compiler execution";
  } else if (SHELL_EXECUTION.test(commandWithoutBundledEntrypoints)) {
    reason = "non-bundled shell execution";
  } else if (INLINE_PROGRAM.test(commandWithoutBundledEntrypoints)) {
    reason = "inline program execution";
  } else if (EXECUTABLE_FILE_OPERATION.test(commandWithoutBundledEntrypoints)) {
    reason = "creating or moving executable source through the shell";
  } else if (EXECUTION_ENABLEMENT.test(commandWithoutBundledEntrypoints)) {
    reason = "making generated content executable";
  } else if (BUILD_OR_PACKAGE_RUNNER.test(commandWithoutBundledEntrypoints)) {
    reason = "build or package runner execution";
  } else if (EXECUTABLE_SOURCE_IN_COMMAND.test(commandWithoutBundledEntrypoints)) {
    reason = "running a non-bundled executable source file";
  } else if (DIRECT_EXECUTABLE_PATH.test(commandWithoutBundledEntrypoints)) {
    reason = "running an arbitrary executable path";
  }
  if (!reason) return undefined;

  return [
    `Automation policy blocks ${reason}.`,
    "Use a registered tool or call the bundled entrypoint directly: skills/data-analysis/scripts/analysis.sh, "
      + "or pdf.sh / docx.sh / pptx.sh / spreadsheet.sh / diagram.sh for document tasks. "
      + "data analysis (pandas/stats/plots over csv, xlsx, DICOM, ECG) has its own Python sandbox — "
      + "write the script to scratch/ and run it through analysis.sh instead of calling an interpreter.",
    "Do not retry by wrapping the operation in another command.",
  ].join(" ");
}

function readStringField(input: unknown, field: string): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = (input as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}
