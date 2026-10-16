import type { CommandSandbox } from "./index.js";

/** 不做任何隔离：命令原样交给 /bin/sh 执行，与未引入沙箱前的行为一致。 */
export class NoneSandbox implements CommandSandbox {
  readonly kind = "none";

  wrap(command: string, _options: { cwd: string; userHome: string; env: NodeJS.ProcessEnv }): { file: string; args: string[] } {
    return { file: "/bin/sh", args: ["-c", command] };
  }

  async probe(): Promise<{ ok: true }> {
    return { ok: true };
  }
}
