import type { CommandSandbox } from "./index.js";

/** Linux bubblewrap 沙箱。空骨架，Task 2 实现。 */
export class BwrapSandbox implements CommandSandbox {
  readonly kind = "bwrap";

  wrap(_command: string, _options: { cwd: string; userHome: string; env: NodeJS.ProcessEnv }): { file: string; args: string[] } {
    throw new Error("BwrapSandbox.wrap: not implemented");
  }

  async probe(): Promise<{ ok: true } | { ok: false; reason: string }> {
    throw new Error("BwrapSandbox.probe: not implemented");
  }
}
