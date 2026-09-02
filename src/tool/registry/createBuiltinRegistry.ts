import { createAskUserQuestionTool } from "../builtin/askUserQuestion.js";
import { createBashTool, type CreateBashToolOptions } from "../builtin/bash.js";
import { createEditFileTool } from "../builtin/editFile.js";
import { createGlobTool } from "../builtin/glob.js";
import { createGrepTool } from "../builtin/grep.js";
import { createGetCurrentTimeTool } from "../builtin/getCurrentTime.js";
import { createEnterPlanModeTool, createExitPlanModeTool } from "../builtin/planMode.js";
import { createReadFileTool } from "../builtin/readFile.js";
import { createReadSkillTool, type ReadSkillDeps } from "../builtin/readSkill.js";
import { createTodoWriteTool } from "../builtin/todoWrite.js";
import { createWriteFileTool } from "../builtin/writeFile.js";
import { ToolRegistry } from "./ToolRegistry.js";

export type CreateBuiltinRegistryOptions = {
  bash?: CreateBashToolOptions;
  /**
   * `read_skill` builtin. **Opt-in** — pass `{ loader, lister }` to
   * register; absent or `false` keeps it out of the registry.
   */
  readSkill?: ReadSkillDeps | false;
  /**
   * `ask_user_question` builtin. Registered by default. Pass `false` to skip.
   */
  askUserQuestion?: false;
  /**
   * `enter_plan_mode` / `exit_plan_mode` builtins. Registered by default.
   * Pass `false` for non-interactive or otherwise constrained hosts.
   */
  planMode?: false;
};

export function createBuiltinRegistry(options?: CreateBuiltinRegistryOptions): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(createGetCurrentTimeTool());
  registry.register(createReadFileTool());
  registry.register(createGlobTool());
  registry.register(createGrepTool());
  registry.register(createEditFileTool());
  registry.register(createWriteFileTool());
  registry.register(createBashTool(options?.bash));
  if (options?.askUserQuestion !== false) {
    registry.register(createAskUserQuestionTool());
  }
  if (options?.planMode !== false) {
    registry.register(createEnterPlanModeTool());
    registry.register(createExitPlanModeTool());
  }
  registry.register(createTodoWriteTool());
  if (options?.readSkill) {
    registry.register(createReadSkillTool(options.readSkill));
  }
  return registry;
}
