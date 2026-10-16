import type { CommandSandbox } from "./index.js";

/** macOS sandbox-exec 沙箱（仅开发自测）。空骨架，Task 3 实现。 */
export class SandboxExecSandbox implements CommandSandbox {
  readonly kind = "sandbox-exec";

  wrap(_command: string, _options: { cwd: string; userHome: string; env: NodeJS.ProcessEnv }): { file: string; args: string[] } {
    throw new Error("SandboxExecSandbox.wrap: not implemented");
  }

  async probe(): Promise<{ ok: true } | { ok: false; reason: string }> {
    throw new Error("SandboxExecSandbox.probe: not implemented");
  }
}
