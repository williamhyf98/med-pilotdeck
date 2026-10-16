# 多用户功能实施计划（三）：用户目录沙箱与路径信息清洗

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在计划一（账号、作用域、Gateway 池）和计划二（迁移、管理员门禁、前端）之上，完成用户目录沙箱的最后一块安全拼图：Agent 保留通用工具，靠后端路径硬校验与操作系统级沙箱防止越界；同时清洗所有输出中的路径信息，防止用户推断系统目录结构与其他用户 ID。最后在 Linux 生产环境（node12）验收 bwrap 的实际隔离效果。

**Architecture:** 沙箱是 bash 工具的可替换适配层（`CommandSandbox { kind, wrap(), probe() }`），`commandRunner.ts` 不再直接 `spawn(command, {shell: true})`，改为 `sandbox.wrap(command, {cwd, userHome, env})` 包装后 `spawn(file, args)`。三种实现：bwrap（Linux 生产，只读挂载系统与代码，只有用户 home 可写）、sandbox-exec（macOS 开发，生成 SBPL profile）、none（显式配置允许，多用户模式下拒绝启动）。路径清洗是响应中间件：`sanitizePaths(text, userId, pilotRoot)` 统一替换 `<root>/users/<userId>/` → `~/`，其他用户路径 → `@users/<REDACTED>/`，应用在 Agent text、bash stdout、错误消息、工具描述；前端工具调用渲染与 UI 组件语义化显示。

**Tech Stack:** Node.js `>=22.13.0 <23`、Express、React 18 + Vite、TypeScript、bubblewrap（Linux 生产依赖）、sandbox-exec（macOS 内置）。测试：Vitest（UI `npm --prefix ui test -- <path>`）、引擎 `npm test`（不设 `PILOTDECK_SKIP_BOOTSTRAP`）、隔离端口与 `/tmp` 根、node12 SSH 验收。

**Spec:** `docs/superpowers/specs/2026-10-14-multi-user-design.md` §16（D15、D16）+ 本计划新增的路径信息清洗需求（2026-10-16 确认，未写入 spec，记录在本文 §0）。

---

## §0. 路径信息清洗需求（2026-10-16 补充）

**背景：** 即使用户在沙箱内无法直接访问其他用户目录，知道路径结构本身就是信息泄露。Agent 思考、工具调用描述（"查看附件目录内容 ls -la /Users/..."）、bash 输出（`pwd`、`ls -la`）、错误消息、前端 UI（面包屑、文件树）都可能暴露绝对路径或用户 ID，让用户能推断出系统有多少用户、自己是第几个注册的、目录结构是什么样的。这在将来发现路径遍历漏洞时会放大风险。

**决策（D18-D21，2026-10-16）：**

| # | 决策 |
|---|---|
| D18 | **路径清洗是安全边界**：在返回前端前，Agent 响应、所有工具 stdout/stderr、错误消息、工具调用 description 字段统一经 `sanitizePaths(text, userId, pilotRoot)` 清洗，替换 `<root>/users/<userId>/` → `~/`，其他用户路径 → `@users/<REDACTED>/`，系统目录 → `@system/`，共享插件 → `@plugins/`。 |
| D19 | 文件工具（read/write/edit/glob/grep）的返回值路径字段转为相对于 `userHome` 的相对路径，UI 服务器侧包装时转换。 |
| D20 | 前端工具调用渲染（生成"查看附件目录内容 ls ..."这类描述的逻辑）应用清洗函数（前端实现 TS 版本，与后端共享正则规则）。前端 UI 组件（面包屑、项目列表、文件选择器）显示语义化路径（"我的项目"、`~/...`），不显示物理路径或用户 ID。 |
| D21 | Agent 系统提示增加路径约束条款：永远不要输出绝对路径或包含用户 ID 的路径片段，只用相对路径或 `~/...`。（提示词不是安全边界，但减少需要过滤的频率） |

---

## Global Constraints

- 沙箱是 bash 工具的适配层，不影响其他工具。文件工具（read/write/edit/glob/grep）的后端硬校验在 UI 服务器侧独立实现，与沙箱正交。
- bwrap 的挂载策略：系统（`/usr`、`/lib`、`/bin`）、代码根目录、Node 二进制路径只读，**只有用户 home 可写**；其他用户 home、`<root>/system`、`<root>/pilotdeck.yaml` 不挂载；环境变量白名单；网络不隔离（医学技能需要）；`--die-with-parent` 配合 Gateway 回收。
- sandbox-exec 只用于 macOS 开发自测，**不作为生产验收依据**。
- 多用户模式下若沙箱落到 none 且未显式 `allowUnsandboxed: true`，Gateway **拒绝启动**（fail-closed）。免登录模式允许 none，只打警告。
- 路径清洗应用范围：`pilotdeck-bridge.js` submitTurn 返回前、bash 工具 stdout/stderr、错误响应中间件、工具调用 description 字段。前端工具调用渲染与 UI 组件同步改造。
- 替换规则按顺序：`<PILOT_ROOT>/users/<userId>/` → `~/`；`<PILOT_ROOT>/users/<其他ID>/` → `@users/<REDACTED>/`；`<PILOT_ROOT>/system/` → `@system/`；`<PILOT_ROOT>/plugins/` → `@plugins/`；`<PILOT_ROOT>` → `@root`；本机用户目录（`/Users/william/`、`/home/deploy/`）→ `@host/`。
- node12 验收必须包含负向测试：沙箱内故意尝试越界（读 `/root/.ssh`、写 `../users/999/`、访问 `<root>/system/auth.db`），确认全部被 bwrap 拒绝。负向测试脚本写在 repo `scripts/sandbox-negative-test.sh`，macOS 跑时 skip，Linux 跑时执行。
- 所有测试使用 `mkdtemp` 临时根，不触碰 `.pilotdeck-home`；隔离端口（3151 / 19200+）。
- 提交信息末尾加 harness 给出的 attribution trailer。

---

## Review Focus

1. **bwrap 挂载遗漏**：`/etc/alternatives`、`/opt/homebrew`（macOS 不存在但 Docker 可能有）、libreoffice / python3 / ImageMagick 等医学技能依赖的程序路径是否都挂载？遗漏会导致技能执行失败，但不是安全问题。测试在 Task 2 与 Task 9。
2. **路径清洗的正则边界**：多行输出（bash stdout 每行独立扫描）、转义字符、引号包裹路径、符号链接目标（`ls -la` 显示 `foo -> /absolute/path`）、YAML block scalar（`maskRawYamlText` 已按行锚定，但 flow map 可能逃逸）。测试在 Task 5。
3. **文件工具返回值转相对路径的时机**：UI 服务器包装引擎工具调用时转换，还是引擎工具本身返回相对路径？期望：UI 侧转换，引擎保持绝对路径（引擎不感知多用户）。测试在 Task 5。
4. **前端工具调用描述的生成位置**：你发现的"查看附件目录内容 ls -la /Users/..."是前端根据工具名 + arguments 自动生成，还是后端在 tool call 时附带 description？期望：找到生成位置并应用清洗。测试在 Task 6。
5. **sandbox-exec 的 profile 写入位置**：`<userHome>/.tmp/sandbox.sb`，这个目录在 Gateway 启动时可能还不存在（skeleton 创建时不建 `.tmp`）。期望：probe() 时创建或 wrap() 时惰性创建。测试在 Task 3。

---

## 文件结构

| 文件 | 职责 | 任务 |
|---|---|---|
| `src/tool/builtin/bash/sandbox/index.ts`（新） | `CommandSandbox` 接口、`selectSandbox()` 选择逻辑 | 1 |
| `src/tool/builtin/bash/sandbox/bwrap.ts`（新） | bwrap 实现：`wrap()` 生成 argv、`probe()` 自检 | 2 |
| `src/tool/builtin/bash/sandbox/sandboxExec.ts`（新） | macOS sandbox-exec 实现 | 3 |
| `src/tool/builtin/bash/sandbox/none.ts`（新） | none 实现（`wrap()` 返回 `/bin/sh -c`） | 1 |
| `src/tool/builtin/bash/commandRunner.ts` | 不再直接 `spawn(command, {shell: true})`，改为 `sandbox.wrap()` 包装 | 2 |
| `src/pilot/config/parseMultiUserConfig.ts` | 解析 `multiUser.sandbox.{kind, allowUnsandboxed, network, extraReadOnlyBinds}` | 1 |
| `src/cli/createLocalGateway.ts` | Gateway 启动时 `probe()` 自检，日志打印 `sandbox: bwrap (ok)`，多用户模式 none 未显式允许则拒绝启动 | 3 |
| `ui/server/utils/pathSanitization.js`（新） | `sanitizePaths(text, userId, pilotRoot)` 函数 | 5 |
| `ui/src/utils/pathSanitization.ts`（新） | 前端 TS 版本，与后端共享正则规则 | 5 |
| `ui/server/services/pilotdeck-bridge.js` | submitTurn 返回前应用 `sanitizePaths` | 5 |
| `ui/server/routes/*.js` | 文件工具包装层，返回值路径字段转相对路径 | 4 |
| `ui/src/components/chat/ChatMessage.tsx`（或类似） | 检查工具调用描述生成位置，应用清洗 | 6 |
| `ui/src/components/app-shell/SidebarV2.tsx`、`ui/src/components/settings/**` | 面包屑、项目列表语义化显示（"我的项目"、`~/...`） | 6 |
| `scripts/sandbox-negative-test.sh`（新） | 负向测试：沙箱内尝试越界，确认被拒绝 | 7, 9 |
| `scripts/pre-flight-check.sh`（新） | 启动前检查：多用户模式检查 `which bwrap`，缺失打印安装命令并退出 | 8 |
| `docs/deployment.md`（新增章节） | 部署文档：Linux 必须装 bubblewrap，安装命令，环境变量 | 8 |

---

### Task 1: 沙箱适配层接口、配置解析与 none 实现

**Files:**
- Create: `src/tool/builtin/bash/sandbox/index.ts`
- Create: `src/tool/builtin/bash/sandbox/none.ts`
- Create: `src/tool/builtin/bash/sandbox/bwrap.ts`（空骨架，Task 2 填充）
- Create: `src/tool/builtin/bash/sandbox/sandboxExec.ts`（空骨架，Task 3 填充）
- Modify: `src/pilot/config/parseMultiUserConfig.ts`（增加 `sandbox` 字段解析）
- Modify: `src/pilot/config/types.ts`（增加 `SandboxConfig` 类型）
- Test: `src/tool/builtin/bash/sandbox/index.test.ts`、`src/tool/builtin/bash/sandbox/none.test.ts`

**Interfaces:**
- Produces:

```ts
// src/tool/builtin/bash/sandbox/index.ts
export interface CommandSandbox {
  readonly kind: "bwrap" | "sandbox-exec" | "none";
  /** 把原始命令包装成实际要 spawn 的 argv；不改变 cwd 与 stdio 语义 */
  wrap(command: string, options: { cwd: string; userHome: string; env: NodeJS.ProcessEnv }): { file: string; args: string[] };
  /** 启动时自检：二进制存在、能执行 `true`，失败则返回原因 */
  probe(): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface SelectSandboxOptions {
  configuredKind?: "bwrap" | "sandbox-exec" | "none";
  multiUserEnabled: boolean;
  allowUnsandboxed?: boolean;
  platform: NodeJS.Platform;
}

/** 选择顺序：配置显式指定 > 自动探测（Linux bwrap，macOS sandbox-exec）> none */
export async function selectSandbox(options: SelectSandboxOptions): Promise<CommandSandbox>;
```

```ts
// src/tool/builtin/bash/sandbox/none.ts
export class NoneSandbox implements CommandSandbox {
  readonly kind = "none";
  wrap(command: string, _options: { cwd: string; userHome: string; env: NodeJS.ProcessEnv }): { file: string; args: string[] } {
    return { file: "/bin/sh", args: ["-c", command] };
  }
  async probe(): Promise<{ ok: true }> {
    return { ok: true };
  }
}
```

```ts
// src/pilot/config/parseMultiUserConfig.ts（增加）
export interface SandboxConfig {
  kind?: "bwrap" | "sandbox-exec" | "none";
  allowUnsandboxed?: boolean;
  network?: boolean;  // false = --unshare-net；默认 true（不隔离）
  extraReadOnlyBinds?: string[];  // 额外只读挂载路径（系统程序）
}

export interface MultiUserConfig {
  // ... 现有字段
  sandbox?: SandboxConfig;
}
```

- [ ] **Step 1: 写接口与 none 实现**

实现 `CommandSandbox` 接口、`NoneSandbox` 类、`selectSandbox()` 选择逻辑。`selectSandbox` 按顺序：配置 `configuredKind` → 平台探测（`platform === "linux"` 试 bwrap，`"darwin"` 试 sandbox-exec）→ none。平台探测时调用各实现的 `probe()`，成功则返回该实例。

`parseMultiUserConfig.ts` 解析 `multiUser.sandbox.{kind, allowUnsandboxed, network, extraReadOnlyBinds}`，默认值：`kind` 未设置（交给 selectSandbox 探测）、`allowUnsandboxed: false`、`network: true`、`extraReadOnlyBinds: []`。

- [ ] **Step 2: 写测试**

```ts
// src/tool/builtin/bash/sandbox/index.test.ts
import { describe, expect, it } from 'vitest';
import { selectSandbox } from './index.js';
import { NoneSandbox } from './none.js';

describe('selectSandbox', () => {
  it('returns configured kind when given', async () => {
    const sandbox = await selectSandbox({ configuredKind: 'none', multiUserEnabled: false, platform: 'darwin' });
    expect(sandbox.kind).toBe('none');
  });
  it('auto-detects on macOS: sandbox-exec or none', async () => {
    const sandbox = await selectSandbox({ multiUserEnabled: false, platform: 'darwin' });
    expect(['sandbox-exec', 'none'].includes(sandbox.kind)).toBe(true);
  });
  it('auto-detects on Linux: bwrap or none', async () => {
    const sandbox = await selectSandbox({ multiUserEnabled: false, platform: 'linux' });
    expect(['bwrap', 'none'].includes(sandbox.kind)).toBe(true);
  });
});

// src/tool/builtin/bash/sandbox/none.test.ts
describe('NoneSandbox', () => {
  it('wraps command as /bin/sh -c', () => {
    const s = new NoneSandbox();
    const { file, args } = s.wrap('echo hello', { cwd: '/tmp', userHome: '/home/u', env: {} });
    expect(file).toBe('/bin/sh');
    expect(args).toEqual(['-c', 'echo hello']);
  });
  it('probe always succeeds', async () => {
    const s = new NoneSandbox();
    expect(await s.probe()).toEqual({ ok: true });
  });
});
```

- [ ] **Step 3: 验证**

Run: `npm run build && npm test -- src/tool/builtin/bash/sandbox/index.test.ts src/tool/builtin/bash/sandbox/none.test.ts`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add src/tool/builtin/bash/sandbox src/pilot/config/parseMultiUserConfig.ts src/pilot/config/types.ts
git commit -m "feat(sandbox): 沙箱适配层接口、配置解析与 none 实现"
```

---

### Task 2: bwrap 实现与 commandRunner 改造

**Files:**
- Modify: `src/tool/builtin/bash/sandbox/bwrap.ts`（填充 Task 1 空骨架）
- Modify: `src/tool/builtin/bash/commandRunner.ts`（不再直接 `spawn(command, {shell: true})`）
- Test: `src/tool/builtin/bash/sandbox/bwrap.test.ts`、`src/tool/builtin/bash/commandRunner.test.ts`（新增沙箱路径）

**Interfaces:**
- Produces:

```ts
// src/tool/builtin/bash/sandbox/bwrap.ts
export class BwrapSandbox implements CommandSandbox {
  readonly kind = "bwrap";
  constructor(private config: { appRoot: string; nodeBinDir: string; network: boolean; extraBinds: string[] }) {}
  
  wrap(command: string, options: { cwd: string; userHome: string; env: NodeJS.ProcessEnv }): { file: string; args: string[] } {
    const { cwd, userHome, env } = options;
    const args = [
      // 系统只读
      '--ro-bind', '/usr', '/usr',
      '--ro-bind', '/lib', '/lib',
      '--ro-bind', '/lib64', '/lib64',
      '--ro-bind', '/bin', '/bin',
      '--ro-bind', '/sbin', '/sbin',
      '--ro-bind', '/etc/alternatives', '/etc/alternatives',
      '--ro-bind', '/etc/ssl', '/etc/ssl',
      '--ro-bind', '/etc/resolv.conf', '/etc/resolv.conf',
      // 代码与 Node
      '--ro-bind', this.config.appRoot, this.config.appRoot,
      '--ro-bind', this.config.nodeBinDir, this.config.nodeBinDir,
      // 用户 home 唯一可写
      '--bind', userHome, userHome,
      // tmpfs
      '--tmpfs', '/tmp',
      '--proc', '/proc',
      '--dev', '/dev',
      // 隔离与生命周期
      '--unshare-pid',
      '--unshare-ipc',
      '--unshare-uts',
      '--die-with-parent',
      '--new-session',
      '--chdir', cwd,
    ];
    // 网络隔离
    if (!this.config.network) {
      args.push('--unshare-net');
    }
    // 额外只读挂载
    for (const bind of this.config.extraBinds) {
      args.push('--ro-bind', bind, bind);
    }
    // 环境变量白名单
    const whitelistEnv = ['PATH', 'LANG', 'TMPDIR', 'PILOT_HOME', 'HOME'];
    for (const key of whitelistEnv) {
      if (env[key]) {
        args.push('--setenv', key, env[key]);
      }
    }
    args.push('--setenv', 'HOME', userHome);
    args.push('--setenv', 'TMPDIR', '/tmp');
    args.push('--setenv', 'PILOT_HOME', userHome);
    // 执行
    args.push('/bin/sh', '-c', command);
    return { file: 'bwrap', args };
  }

  async probe(): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      const { spawn } = await import('node:child_process');
      const child = spawn('bwrap', ['--version'], { stdio: 'pipe' });
      const exitCode = await new Promise<number>((resolve) => {
        child.on('close', (code) => resolve(code ?? 1));
      });
      if (exitCode !== 0) {
        return { ok: false, reason: 'bwrap binary found but --version failed' };
      }
      // 测试执行 true
      const test = spawn('bwrap', ['--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64', '--ro-bind', '/bin', '/bin', '--proc', '/proc', '--dev', '/dev', '--unshare-pid', '--die-with-parent', '/bin/true'], { stdio: 'pipe' });
      const testExit = await new Promise<number>((resolve) => {
        test.on('close', (code) => resolve(code ?? 1));
      });
      if (testExit !== 0) {
        return { ok: false, reason: 'bwrap can run but fails to execute /bin/true in sandbox' };
      }
      return { ok: true };
    } catch (err: any) {
      return { ok: false, reason: `bwrap not found or cannot execute: ${err.message}` };
    }
  }
}
```

```ts
// src/tool/builtin/bash/commandRunner.ts（改造）
import { selectSandbox } from './sandbox/index.js';

// 模块级变量：Gateway 启动时初始化，存储选中的沙箱实例
let _sandbox: CommandSandbox | null = null;

export async function initializeSandbox(config: MultiUserConfig, env: NodeJS.ProcessEnv): Promise<void> {
  const multiUserEnabled = !env.PILOTDECK_DISABLE_LOCAL_AUTH || env.PILOTDECK_DISABLE_LOCAL_AUTH === '0';
  _sandbox = await selectSandbox({
    configuredKind: config.sandbox?.kind,
    multiUserEnabled,
    allowUnsandboxed: config.sandbox?.allowUnsandboxed,
    platform: process.platform,
  });
  const probeResult = await _sandbox.probe();
  if (!probeResult.ok) {
    if (multiUserEnabled && _sandbox.kind === 'none' && !config.sandbox?.allowUnsandboxed) {
      throw new Error(`Multi-user mode requires a sandbox, but none is available: ${probeResult.reason}. Install bubblewrap or set multiUser.sandbox.allowUnsandboxed: true in config.`);
    }
    if (multiUserEnabled && _sandbox.kind === 'none') {
      console.warn(`[sandbox] Multi-user mode running without sandbox (allowUnsandboxed=true). This is UNSAFE for production.`);
    }
  }
  console.log(`[sandbox] ${_sandbox.kind} (${probeResult.ok ? 'ok' : probeResult.reason})`);
}

export function runCommand(command: string, options: { cwd: string; userHome: string; env: NodeJS.ProcessEnv; stdin?: string }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (!_sandbox) {
    throw new Error('Sandbox not initialized. Call initializeSandbox() first.');
  }
  const { file, args } = _sandbox.wrap(command, { cwd: options.cwd, userHome: options.userHome, env: options.env });
  const { spawn } = require('node:child_process');
  const child = spawn(file, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
  // ... 现有的 stdin/stdout/stderr 处理逻辑
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
    child.on('close', (code: number | null) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
    child.on('error', reject);
    if (options.stdin) {
      child.stdin.write(options.stdin);
      child.stdin.end();
    }
  });
}
```

- [ ] **Step 1: 实现 bwrap**

填充 `bwrap.ts`，实现 `wrap()` 与 `probe()`。`wrap()` 生成的 argv 按 spec §16.4 骨架，注意：
- `appRoot` 从 `process.cwd()` 或 `__dirname` 向上找到 `package.json` 所在目录
- `nodeBinDir` 从 `process.execPath` 的 `path.dirname()`
- `extraReadOnlyBinds` 从配置读取，默认为空（部署时补充 `/usr/bin/python3`、`/usr/bin/libreoffice` 等）

- [ ] **Step 2: 改造 commandRunner**

在 `commandRunner.ts` 增加 `initializeSandbox()` 与模块级 `_sandbox` 变量。`runCommand()` 不再 `spawn(command, {shell: true})`，改为 `_sandbox.wrap(command, ...)` 后 `spawn(file, args, ...)`。

`src/cli/createLocalGateway.ts` 在启动 Gateway 时调用 `initializeSandbox(multiUserConfig, env)`，在读取 `pilotConfig` 之后、监听端口之前。

- [ ] **Step 3: 写测试**

```ts
// src/tool/builtin/bash/sandbox/bwrap.test.ts
import { describe, expect, it } from 'vitest';
import { BwrapSandbox } from './bwrap.js';

describe('BwrapSandbox', () => {
  it('generates correct argv with all mounts', () => {
    const s = new BwrapSandbox({ appRoot: '/app', nodeBinDir: '/usr/bin', network: true, extraBinds: ['/opt/libreoffice'] });
    const { file, args } = s.wrap('echo test', { cwd: '/home/u1/projects', userHome: '/home/u1', env: { PATH: '/usr/bin', HOME: '/home/u1' } });
    expect(file).toBe('bwrap');
    expect(args).toContain('--ro-bind');
    expect(args).toContain('/app');
    expect(args).toContain('--bind');
    expect(args).toContain('/home/u1');
    expect(args).toContain('--chdir');
    expect(args).toContain('/home/u1/projects');
    expect(args).toContain('--setenv');
    expect(args).toContain('PILOT_HOME');
    expect(args).toContain('/bin/sh');
    expect(args[args.length - 1]).toBe('echo test');
  });
  it('adds --unshare-net when network=false', () => {
    const s = new BwrapSandbox({ appRoot: '/app', nodeBinDir: '/usr/bin', network: false, extraBinds: [] });
    const { args } = s.wrap('true', { cwd: '/tmp', userHome: '/home/u', env: {} });
    expect(args).toContain('--unshare-net');
  });
  it('probe fails when bwrap not found', async () => {
    const s = new BwrapSandbox({ appRoot: '/app', nodeBinDir: '/nonexistent', network: true, extraBinds: [] });
    const result = await s.probe();
    if (process.platform === 'linux' && require('child_process').spawnSync('which', ['bwrap']).status === 0) {
      expect(result.ok).toBe(true);
    } else {
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/not found|cannot execute/);
    }
  });
});
```

- [ ] **Step 4: 验证**

Run: `npm run build && npm test -- src/tool/builtin/bash/sandbox/bwrap.test.ts src/tool/builtin/bash/commandRunner.test.ts`
Expected: PASS（macOS 上 bwrap 测试跳过或报 not found，Linux 上通过）

- [ ] **Step 5: 提交**

```bash
git add src/tool/builtin/bash/sandbox/bwrap.ts src/tool/builtin/bash/commandRunner.ts src/cli/createLocalGateway.ts
git commit -m "feat(sandbox): bwrap 实现与 commandRunner 沙箱化改造"
```

---

### Task 3: sandbox-exec 实现（macOS）与启动失败策略

**Files:**
- Modify: `src/tool/builtin/bash/sandbox/sandboxExec.ts`（填充 Task 1 空骨架）
- Modify: `src/cli/createLocalGateway.ts`（多用户模式 none 未显式允许则拒绝启动）
- Test: `src/tool/builtin/bash/sandbox/sandboxExec.test.ts`

**Interfaces:**
- Produces:

```ts
// src/tool/builtin/bash/sandbox/sandboxExec.ts
export class SandboxExecSandbox implements CommandSandbox {
  readonly kind = "sandbox-exec";
  constructor(private config: { appRoot: string; nodeBinDir: string }) {}

  wrap(command: string, options: { cwd: string; userHome: string; env: NodeJS.ProcessEnv }): { file: string; args: string[] } {
    const { userHome } = options;
    const profilePath = path.join(userHome, '.tmp', 'sandbox.sb');
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    const profile = `
(version 1)
(deny default)
(allow process-exec process-fork signal)
(allow sysctl-read mach-lookup)
(allow network*)
(allow file-read* (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/System") (subpath "/Library")
                  (subpath "/private/etc") (subpath "/opt/homebrew") (subpath "${this.config.appRoot}") (subpath "${this.config.nodeBinDir}"))
(allow file* (subpath "${userHome}") (subpath "/private/tmp") (subpath "/private/var/folders"))
`.trim();
    fs.writeFileSync(profilePath, profile, 'utf8');
    return { file: '/usr/bin/sandbox-exec', args: ['-f', profilePath, '/bin/sh', '-c', command] };
  }

  async probe(): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      const { spawnSync } = await import('node:child_process');
      const result = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1) (allow default)', '/bin/true'], { encoding: 'utf8' });
      if (result.status !== 0) {
        return { ok: false, reason: `sandbox-exec exists but fails to run: ${result.stderr}` };
      }
      return { ok: true };
    } catch (err: any) {
      return { ok: false, reason: `sandbox-exec not found: ${err.message}` };
    }
  }
}
```

- [ ] **Step 1: 实现 sandbox-exec**

填充 `sandboxExec.ts`，`wrap()` 生成 SBPL profile 到 `<userHome>/.tmp/sandbox.sb`（`.tmp` 目录在此处惰性创建），`probe()` 测试 `sandbox-exec -p '(version 1) (allow default)' /bin/true`。

- [ ] **Step 2: 启动失败策略**

在 `createLocalGateway.ts` 的 `initializeSandbox()` 调用后，检查：
```ts
if (multiUserEnabled && _sandbox.kind === 'none' && !config.sandbox?.allowUnsandboxed) {
  throw new Error(`Multi-user mode requires a sandbox, but none is available. Install bubblewrap (Linux) or set multiUser.sandbox.allowUnsandboxed: true in config.`);
}
```

UI 服务器侧 `gatewayPool.js` 的 `_startGateway()` 捕获此错误，标记该用户 Gateway 为 `failed`，返回 503 给前端（Task 5 已有门禁，此处只需确保错误传播）。

- [ ] **Step 3: 写测试**

```ts
// src/tool/builtin/bash/sandbox/sandboxExec.test.ts
describe('SandboxExecSandbox', () => {
  it('generates profile at userHome/.tmp/sandbox.sb', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-'));
    const s = new SandboxExecSandbox({ appRoot: '/app', nodeBinDir: '/usr/bin' });
    const { file, args } = s.wrap('echo test', { cwd: tmpHome, userHome: tmpHome, env: {} });
    expect(file).toBe('/usr/bin/sandbox-exec');
    expect(args[0]).toBe('-f');
    expect(args[1]).toBe(path.join(tmpHome, '.tmp', 'sandbox.sb'));
    expect(fs.existsSync(args[1])).toBe(true);
    const profile = fs.readFileSync(args[1], 'utf8');
    expect(profile).toContain('(version 1)');
    expect(profile).toContain(`(subpath "${tmpHome}")`);
    fs.rmSync(tmpHome, { recursive: true });
  });
  it('probe succeeds on macOS, fails elsewhere', async () => {
    const s = new SandboxExecSandbox({ appRoot: '/app', nodeBinDir: '/usr/bin' });
    const result = await s.probe();
    if (process.platform === 'darwin') {
      expect(result.ok).toBe(true);
    } else {
      expect(result.ok).toBe(false);
    }
  });
});
```

- [ ] **Step 4: 验证**

Run: `npm run build && npm test -- src/tool/builtin/bash/sandbox/sandboxExec.test.ts`
Expected: macOS PASS，Linux skip 或 not found

- [ ] **Step 5: 提交**

```bash
git add src/tool/builtin/bash/sandbox/sandboxExec.ts src/cli/createLocalGateway.ts
git commit -m "feat(sandbox): sandbox-exec 实现（macOS）与多用户模式启动失败策略"
```

---

### Task 4: 文件工具后端硬校验强化

**Files:**
- Modify: `ui/server/routes/projects.js`、`ui/server/routes/storage.js`、`ui/server/routes/skills.js`（文件操作前检查路径在 `userHome` 下）
- Modify: `ui/server/services/pilotPaths.js`（新增 `assertPathInUserHome(targetPath, userHome)` 工具函数）
- Test: `ui/server/services/pilotPaths.test.js`（新增路径校验用例）

**Interfaces:**
- Produces:

```js
// ui/server/services/pilotPaths.js（新增）
export function assertPathInUserHome(targetPath, userHome) {
  const resolved = path.resolve(targetPath);
  const homeResolved = path.resolve(userHome);
  if (!resolved.startsWith(homeResolved + path.sep) && resolved !== homeResolved) {
    throw Object.assign(new Error('Path outside user home'), { code: 'PATH_OUT_OF_BOUNDS', path: targetPath });
  }
  return resolved;
}
```

- [ ] **Step 1: 实现路径校验**

在 `pilotPaths.js` 新增 `assertPathInUserHome(targetPath, userHome)`，检查 `path.resolve(targetPath)` 是否以 `path.resolve(userHome) + path.sep` 开头。不在范围内则抛错 `{ code: 'PATH_OUT_OF_BOUNDS' }`。

- [ ] **Step 2: 应用到文件路由**

在以下位置调用 `assertPathInUserHome`（都在请求处理函数内，`userHome` 从 `requireUserScope()` 获取）：
- `routes/projects.js` 的项目 CRUD、workspace 文件读写
- `routes/storage.js` 的附件上传路径、删除路径
- `routes/skills.js` 的技能 CRUD、技能文件读写

read_skill 返回技能内容时去掉绝对路径（`skill.path` 字段只返回相对于 `skills/` 的路径，不返回完整的 `/Users/.../users/<id>/skills/...`）。

网络工具（`web_fetch` 等，在引擎侧 `src/tool/builtin/` 下）拒绝 `file://` 协议与 `localhost` / `127.0.0.1` / `::1` 回环地址（现有逻辑，确认存在即可）。

- [ ] **Step 3: 写测试**

```js
// ui/server/services/pilotPaths.test.js（新增）
describe('assertPathInUserHome', () => {
  it('allows paths inside userHome', () => {
    const userHome = '/tmp/pilot-test/users/1';
    expect(() => assertPathInUserHome(path.join(userHome, 'projects/p1'), userHome)).not.toThrow();
    expect(() => assertPathInUserHome(userHome, userHome)).not.toThrow();
  });
  it('rejects paths outside userHome', () => {
    const userHome = '/tmp/pilot-test/users/1';
    expect(() => assertPathInUserHome('/tmp/pilot-test/users/2/projects', userHome)).toThrow(/PATH_OUT_OF_BOUNDS/);
    expect(() => assertPathInUserHome('/tmp/pilot-test/system', userHome)).toThrow(/PATH_OUT_OF_BOUNDS/);
    expect(() => assertPathInUserHome('../2/projects', userHome)).toThrow(/PATH_OUT_OF_BOUNDS/);
  });
  it('resolves symlinks and rejects escapes', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-path-'));
    const userHome = path.join(tmpRoot, 'users/1');
    fs.mkdirSync(userHome, { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'system'));
    fs.symlinkSync(path.join(tmpRoot, 'system'), path.join(userHome, 'escape'));
    expect(() => assertPathInUserHome(path.join(userHome, 'escape'), userHome)).toThrow(/PATH_OUT_OF_BOUNDS/);
    fs.rmSync(tmpRoot, { recursive: true });
  });
});
```

- [ ] **Step 4: 验证**

Run: `npm --prefix ui test -- services/pilotPaths.test.js routes/projects.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add ui/server/services/pilotPaths.js ui/server/routes
git commit -m "feat(security): 文件工具后端路径硬校验，拒绝访问用户目录外路径"
```

---

### Task 5: 路径信息清洗（后端 sanitizePaths + 工具返回值标准化）

**Files:**
- Create: `ui/server/utils/pathSanitization.js`
- Modify: `ui/server/services/pilotdeck-bridge.js`（submitTurn 返回前应用）
- Modify: `ui/server/routes/*.js`（文件工具包装，返回值路径转相对）
- Modify: `ui/server/middleware/errorHandler.js`（错误响应应用清洗，如果有）
- Test: `ui/server/utils/pathSanitization.test.js`

**Interfaces:**
- Produces:

```js
// ui/server/utils/pathSanitization.js
const path = require('node:path');

/**
 * 替换文本中的路径为语义化路径
 * @param {string} text - 原始文本
 * @param {string | number} userId - 当前用户 ID
 * @param {string} pilotRoot - PILOT_ROOT 路径
 * @returns {string} 清洗后的文本
 */
function sanitizePaths(text, userId, pilotRoot) {
  if (!text || typeof text !== 'string') return text;
  const userIdStr = String(userId);
  const rootResolved = path.resolve(pilotRoot);
  const userHome = path.join(rootResolved, 'users', userIdStr);
  
  // 替换顺序很重要：先替换自己的 home，再替换其他用户，再替换根目录
  let result = text;
  
  // 1. 当前用户 home → ~/
  const userHomeRegex = new RegExp(escapeRegex(userHome) + '(?=/|$)', 'g');
  result = result.replace(userHomeRegex, '~');
  
  // 2. 其他用户 home → @users/<REDACTED>/
  const usersDir = path.join(rootResolved, 'users');
  const otherUsersRegex = new RegExp(escapeRegex(usersDir) + '/([^/]+)(?=/|$)', 'g');
  result = result.replace(otherUsersRegex, (match, capturedId) => {
    return capturedId === userIdStr ? match : '@users/<REDACTED>';
  });
  
  // 3. system/ → @system/
  const systemDir = path.join(rootResolved, 'system');
  const systemRegex = new RegExp(escapeRegex(systemDir) + '(?=/|$)', 'g');
  result = result.replace(systemRegex, '@system');
  
  // 4. plugins/ → @plugins/
  const pluginsDir = path.join(rootResolved, 'plugins');
  const pluginsRegex = new RegExp(escapeRegex(pluginsDir) + '(?=/|$)', 'g');
  result = result.replace(pluginsRegex, '@plugins');
  
  // 5. 根目录本身 → @root
  const rootRegex = new RegExp('^' + escapeRegex(rootResolved) + '(?=/|$)', 'gm');
  result = result.replace(rootRegex, '@root');
  
  // 6. 本机用户目录（/Users/william、/home/deploy）→ @host/
  if (process.platform === 'darwin') {
    result = result.replace(/\/Users\/[^/]+/g, '@host');
  } else {
    result = result.replace(/\/home\/[^/]+/g, '@host');
    result = result.replace(/\/root(?=\/|$)/g, '@host');
  }
  
  return result;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { sanitizePaths };
```

- [ ] **Step 1: 实现 sanitizePaths**

在 `ui/server/utils/pathSanitization.js` 实现 `sanitizePaths(text, userId, pilotRoot)`，按决策 D18 的替换规则。注意：
- 正则需要 escape 路径中的特殊字符（`escapeRegex` 辅助函数）
- 多行文本用 `gm` flag，每行独立扫描
- 边界情况：转义字符、引号包裹路径、符号链接目标（`ls -la foo -> /absolute/path`）

- [ ] **Step 2: 应用到 bridge**

在 `pilotdeck-bridge.js` 的 `submitTurn()` 返回前，对 `response.text` 应用 `sanitizePaths(response.text, userId, pilotRoot)`。bash 工具的 stdout/stderr 同样在返回前清洗。

- [ ] **Step 3: 工具返回值标准化**

在文件工具的 UI 服务器包装层（`routes/projects.js`、`routes/storage.js`），返回值中的 `path` 字段转为相对于 `userHome` 的相对路径：
```js
if (result.path) {
  result.path = path.relative(userHome, result.path);
}
```

glob / grep 的结果数组同样转相对路径。

- [ ] **Step 4: 写测试**

```js
// ui/server/utils/pathSanitization.test.js
describe('sanitizePaths', () => {
  const pilotRoot = '/data/pilotdeck';
  const userId = 123;
  
  it('replaces user home with ~/', () => {
    const text = `/data/pilotdeck/users/123/projects/p1/file.txt`;
    expect(sanitizePaths(text, userId, pilotRoot)).toBe('~/projects/p1/file.txt');
  });
  
  it('replaces other user paths with @users/<REDACTED>/', () => {
    const text = `/data/pilotdeck/users/456/projects/p2`;
    expect(sanitizePaths(text, userId, pilotRoot)).toBe('@users/<REDACTED>/projects/p2');
  });
  
  it('replaces system directory with @system/', () => {
    const text = `/data/pilotdeck/system/auth.db`;
    expect(sanitizePaths(text, userId, pilotRoot)).toBe('@system/auth.db');
  });
  
  it('handles multi-line bash output', () => {
    const text = `file1.txt\n/data/pilotdeck/users/123/file2.txt\n/data/pilotdeck/users/789/file3.txt`;
    const result = sanitizePaths(text, userId, pilotRoot);
    expect(result).toContain('~/file2.txt');
    expect(result).toContain('@users/<REDACTED>/file3.txt');
  });
  
  it('handles symlink targets in ls -la output', () => {
    const text = `plugins -> /data/pilotdeck/plugins`;
    expect(sanitizePaths(text, userId, pilotRoot)).toBe('plugins -> @plugins');
  });
});
```

- [ ] **Step 5: 验证**

Run: `npm --prefix ui test -- utils/pathSanitization.test.js services/pilotdeck-bridge.test.js`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add ui/server/utils/pathSanitization.js ui/server/services/pilotdeck-bridge.js ui/server/routes
git commit -m "feat(security): 路径信息清洗，Agent 输出与工具返回值不再暴露绝对路径"
```

---

### Task 6: 前端路径清洗与 UI 语义化

**Files:**
- Create: `ui/src/utils/pathSanitization.ts`（前端 TS 版本，与后端共享正则规则）
- Modify: `ui/src/components/chat/ChatMessage.tsx`（或类似，工具调用描述生成位置）
- Modify: `ui/src/components/app-shell/SidebarV2.tsx`、`ui/src/components/settings/**`（面包屑、项目列表语义化）
- Test: `ui/src/utils/pathSanitization.test.ts`

**Interfaces:**
- Produces:

```ts
// ui/src/utils/pathSanitization.ts
export function sanitizePathsClient(text: string, userId: string | number): string {
  // 前端不知道 pilotRoot，但可以通过 API 响应中已清洗的路径模式反推
  // 简化版：只处理常见模式，主要靠后端清洗
  if (!text || typeof text !== 'string') return text;
  
  // 前端主要处理工具调用描述中的路径
  // 如果后端已清洗，这里只需处理前端自己生成的描述
  let result = text;
  
  // 替换形如 "/Users/.../users/<id>/" 的模式
  // 实际上前端应该从 AuthContext 获取 pilotRoot（通过 API 传递），这里简化
  const userHomePattern = /\/(?:Users|home)\/[^/]+\/[^/]+\/users\/\d+\//g;
  result = result.replace(userHomePattern, '~/');
  
  return result;
}
```

- [ ] **Step 1: 实现前端清洗函数**

在 `ui/src/utils/pathSanitization.ts` 实现 `sanitizePathsClient(text, userId)`。前端版本简化：主要靠后端清洗，前端只处理自己生成的工具调用描述。

- [ ] **Step 2: 检查工具调用描述生成位置**

在 `ui/src/components/chat/` 下搜索 "ls -la" 或 "查看附件" 这类模式，找到工具调用描述的生成位置（可能在 `ChatMessage.tsx` 或 `ToolCallDisplay.tsx`）。如果是前端根据 `tool.name` + `tool.arguments` 自动生成，应用 `sanitizePathsClient`。

如果是后端在 tool call 时附带 description，后端在 Task 5 已清洗，前端无需额外处理。

- [ ] **Step 3: UI 语义化**

在以下组件中语义化显示路径（§D20）：
- `SidebarV2.tsx` 的项目列表：只显示项目名称，不显示路径
- `Settings.tsx` 的面包屑或文件路径：显示 `~/projects/...` 而不是完整物理路径
- 浏览器 tab 标题（`index.html` 的 `<title>`）：只显示项目名，不含路径

- [ ] **Step 4: 写测试**

```ts
// ui/src/utils/pathSanitization.test.ts
import { describe, expect, it } from 'vitest';
import { sanitizePathsClient } from './pathSanitization';

describe('sanitizePathsClient', () => {
  it('sanitizes user home patterns', () => {
    const text = '查看附件目录内容 ls -la /Users/william/.pilotdeck-home/users/123/workspace';
    const result = sanitizePathsClient(text, 123);
    expect(result).not.toContain('/Users/william');
    expect(result).toContain('~/');
  });
});
```

- [ ] **Step 5: 验证**

Run: `npm --prefix ui test -- src/utils/pathSanitization.test.ts src/components/chat`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add ui/src/utils/pathSanitization.ts ui/src/components
git commit -m "feat(ui): 前端路径清洗与 UI 语义化显示（项目列表、面包屑）"
```

---

### Task 7: 本地 macOS 验收与负向测试脚本

**Files:**
- Create: `scripts/sandbox-negative-test.sh`
- Modify: `scripts/smoke-multi-user.sh`（增加沙箱验证步骤）

**Interfaces:**
- Produces: `bash scripts/sandbox-negative-test.sh [--root /tmp/pd-sandbox] [--platform linux|darwin]`，负向测试：沙箱内尝试越界，确认被拒绝；macOS 跑时标记 skip，Linux 跑时执行

- [ ] **Step 1: 写负向测试脚本**

```bash
#!/usr/bin/env bash
# scripts/sandbox-negative-test.sh — 沙箱负向测试：尝试越界，确认被拒绝
set -euo pipefail
ROOT=/tmp/pd-sandbox; PLATFORM=$(uname -s | tr '[:upper:]' '[:lower:]')
while [ $# -gt 0 ]; do case "$1" in --root) ROOT=$2; shift 2;; --platform) PLATFORM=$2; shift 2;; *) echo "unknown arg $1"; exit 1;; esac; done

if [ "$PLATFORM" != "linux" ]; then
  echo "SKIP: negative tests only run on Linux (platform: $PLATFORM)"
  exit 0
fi

REPO=$(cd "$(dirname "$0")/.." && pwd)
rm -rf "$ROOT"; mkdir -p "$ROOT/users/1" "$ROOT/system"
echo "secret" > "$ROOT/system/auth.db"
echo "other-user-data" > "$ROOT/users/2/secret.txt"

# 启动一个最小 Gateway（只测试 bash 工具的沙箱）
export PILOT_HOME="$ROOT/users/1" PILOTDECK_DISABLE_LOCAL_AUTH=0
# 实际测试需要启动 Gateway 并调用 bash 工具，这里简化为直接调用 bwrap
# 真实实现：启动 Gateway，通过 WebSocket 发 bash 命令，验证响应是 permission denied

echo "TEST 1: read /root/.ssh (expect: permission denied)"
bwrap --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 --ro-bind /bin /bin --bind "$ROOT/users/1" "$ROOT/users/1" --proc /proc --dev /dev --unshare-pid --die-with-parent /bin/sh -c "cat /root/.ssh/id_rsa 2>&1" | grep -q "Permission denied\|cannot open\|No such file" || { echo "FAIL: read /root/.ssh succeeded"; exit 1; }

echo "TEST 2: write ../users/2/ (expect: no such file or directory)"
bwrap --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 --ro-bind /bin /bin --bind "$ROOT/users/1" "$ROOT/users/1" --proc /proc --dev /dev --unshare-pid --die-with-parent /bin/sh -c "cd '$ROOT/users/1' && echo hijack > ../2/hijack.txt 2>&1" | grep -q "No such file or directory\|cannot create" || { echo "FAIL: write ../users/2/ succeeded"; exit 1; }

echo "TEST 3: access <root>/system/auth.db (expect: no such file)"
bwrap --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 --ro-bind /bin /bin --bind "$ROOT/users/1" "$ROOT/users/1" --proc /proc --dev /dev --unshare-pid --die-with-parent /bin/sh -c "cat '$ROOT/system/auth.db' 2>&1" | grep -q "No such file or directory\|cannot open" || { echo "FAIL: access system/auth.db succeeded"; exit 1; }

rm -rf "$ROOT"
echo "NEGATIVE TESTS PASS"
```

- [ ] **Step 2: 本地 macOS 验收**

在本地 `/tmp/pd-plan3`（端口 3151 / 19200+）启动系统，测试：
1. 文档技能（docx / pptx）能跑，输出落到用户 workspace
2. 战创伤 Runner 能调用 bash 工具
3. bash 工具执行 `ls -la /absolute/path`，前端显示的是 `~/...` 而不是绝对路径
4. Agent 思考时输出路径，前端显示清洗后的 `~/...`
5. 错误消息（读取不存在文件）不泄露其他用户路径

- [ ] **Step 3: 验证**

Run: `bash scripts/sandbox-negative-test.sh --platform linux`（macOS 上 skip）
Expected: Linux PASS，macOS SKIP

- [ ] **Step 4: 提交**

```bash
git add scripts/sandbox-negative-test.sh scripts/smoke-multi-user.sh
git commit -m "test(sandbox): 负向测试脚本，验证沙箱拒绝越界访问"
```

---

### Task 8: 部署文档与 pre-flight check 脚本

**Files:**
- Create: `docs/deployment.md`（新增 Linux 部署章节）
- Create: `scripts/pre-flight-check.sh`
- Modify: `scripts/lib-local-runtime.sh`（启动前调用 pre-flight check）

**Interfaces:**
- Produces: `docs/deployment.md` 增加「Linux 生产部署」章节，说明 bubblewrap 安装、环境变量、配置示例；`scripts/pre-flight-check.sh` 检查多用户模式下 `which bwrap`，缺失打印安装命令并退出

- [ ] **Step 1: 写部署文档**

创建 `docs/deployment.md`，增加以下章节：

```markdown
## Linux 生产部署

### 依赖

多用户模式需要 bubblewrap（用户目录沙箱）。安装：

```bash
# Debian / Ubuntu
sudo apt install bubblewrap

# CentOS / RHEL
sudo yum install bubblewrap

# Arch
sudo pacman -S bubblewrap
```

验证：`which bwrap` 应返回 `/usr/bin/bwrap`。

### 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `PILOT_HOME` | 系统根目录 | `.pilotdeck-home` |
| `PILOTDECK_DISABLE_LOCAL_AUTH` | `0` 启用多用户模式 | 未设置（免登录） |
| `PILOTDECK_ADMIN_PASSWORD` | 管理员初始密码 | `passok` |
| `SERVER_PORT` | UI 服务端口 | `3020` |
| `PILOTDECK_GATEWAY_PORT_BASE` | Gateway 池基础端口 | `5170` |

### 配置示例

`pilotdeck.yaml` 增加：

```yaml
multiUser:
  sandbox:
    kind: bwrap  # 或 none（需 allowUnsandboxed: true）
    network: true  # 医学技能需要网络，不隔离
    extraReadOnlyBinds:
      - /usr/bin/python3
      - /usr/bin/libreoffice
      - /usr/bin/convert  # ImageMagick
```

### 启动检查

`scripts/pre-flight-check.sh` 在启动前检查依赖。多用户模式下若无 bubblewrap，脚本退出并打印安装命令。
```

- [ ] **Step 2: 写 pre-flight check 脚本**

```bash
#!/usr/bin/env bash
# scripts/pre-flight-check.sh — 启动前检查依赖
set -euo pipefail

# 检查多用户模式
if [ "${PILOTDECK_DISABLE_LOCAL_AUTH:-}" = "0" ]; then
  echo "[pre-flight] Multi-user mode enabled, checking sandbox..."
  if [ "$(uname -s)" = "Linux" ]; then
    if ! command -v bwrap >/dev/null 2>&1; then
      echo "ERROR: Multi-user mode on Linux requires bubblewrap, but 'bwrap' not found."
      echo "Install with:"
      echo "  sudo apt install bubblewrap       # Debian/Ubuntu"
      echo "  sudo yum install bubblewrap       # CentOS/RHEL"
      echo "  sudo pacman -S bubblewrap         # Arch"
      echo ""
      echo "Or disable multi-user mode by unsetting PILOTDECK_DISABLE_LOCAL_AUTH."
      exit 1
    fi
    echo "[pre-flight] bubblewrap found: $(which bwrap)"
  elif [ "$(uname -s)" = "Darwin" ]; then
    echo "[pre-flight] macOS detected, sandbox-exec will be used (development only)"
  fi
else
  echo "[pre-flight] No-login mode (PILOTDECK_DISABLE_LOCAL_AUTH not 0), sandbox not required"
fi
```

- [ ] **Step 3: 集成到启动脚本**

在 `scripts/lib-local-runtime.sh` 的 `start_server()` 函数开头调用 `bash scripts/pre-flight-check.sh`。

- [ ] **Step 4: 验证**

Run: `PILOTDECK_DISABLE_LOCAL_AUTH=0 bash scripts/pre-flight-check.sh`
Expected: macOS 打印 "sandbox-exec will be used"，Linux 检查 bwrap（有则 pass，无则退出并打印安装命令）

- [ ] **Step 5: 提交**

```bash
git add docs/deployment.md scripts/pre-flight-check.sh scripts/lib-local-runtime.sh
git commit -m "docs(deployment): Linux 生产部署文档与启动前依赖检查"
```

---

### Task 9: node12 Linux 环境验收（含负向测试）

**Files:**
- 无代码修改，纯验收

**Prerequisites:**
- node12 SSH 访问
- `local_data/huojianfan/med-pilotdeck` 已同步 GitHub/Gitee feat/multi-user-v2 分支（HEAD e5122e1 + Plan 3 提交）

**Steps:**

- [ ] **Step 1: node12 同步代码**

在本地推送 Plan 3 所有提交到 GitHub 和 Gitee：
```bash
git push origin feat/multi-user-v2
git push gitee feat/multi-user-v2
```

SSH 到 node12：
```bash
ssh node12
cd local_data/huojianfan/med-pilotdeck
git fetch origin
git checkout feat/multi-user-v2
git pull origin feat/multi-user-v2
```

- [ ] **Step 2: 安装 bubblewrap**

```bash
# node12 是 Kylin/UOS ARM64，使用 apt
sudo apt update
sudo apt install bubblewrap
which bwrap  # 应返回 /usr/bin/bwrap
```

- [ ] **Step 3: 功能测试**

在 node12 上启动系统（隔离根 `/tmp/pd-plan3`，端口 3151 / 19200+）：
```bash
export PILOT_HOME=/tmp/pd-plan3 SERVER_PORT=3151 PILOTDECK_GATEWAY_PORT_BASE=19200 PILOTDECK_DISABLE_LOCAL_AUTH=0 PILOTDECK_ADMIN_PASSWORD=adminpass
npm --prefix ui run dev:server
```

在另一个终端：
```bash
# 登录
curl -X POST localhost:3151/api/auth/login -H 'content-type: application/json' -d '{"username":"admin","password":"adminpass"}' | jq .token

# 创建项目，调用文档技能（docx / pptx），确认能跑
# 调用战创伤 Runner，确认 bash 工具正常
```

- [ ] **Step 4: 负向测试**

在 node12 上运行：
```bash
bash scripts/sandbox-negative-test.sh --platform linux
```

Expected: `NEGATIVE TESTS PASS`（所有越界尝试被拒绝）

- [ ] **Step 5: 路径清洗验证**

在前端（浏览器访问 node12:3151）：
1. 调用 bash 工具 `ls -la /绝对路径`，前端显示应为 `~/...`
2. Agent 思考时输出路径，前端显示清洗后的 `~/...`
3. 错误消息不泄露其他用户路径

- [ ] **Step 6: 记录验收结果**

在本文末尾「执行记录」章节记录：
- node12 环境：Kylin/UOS ARM64，Node.js 版本，bubblewrap 版本
- 功能测试通过：文档技能、战创伤 Runner
- 负向测试通过：3 个越界尝试全部被拒绝
- 路径清洗通过：前端无绝对路径泄露

---

### Task 10: 回归测试与最终整理

**Files:**
- Modify: `docs/superpowers/plans/2026-10-16-multi-user-sandbox-and-path-sanitization.md`（本文档，末尾填写执行记录）
- 无新增代码

**Steps:**

- [ ] **Step 1: 全量测试**

在本地 macOS：
```bash
npm --prefix ui test
npm --prefix ui run typecheck
npm --prefix ui run build
npm test  # 不设 PILOTDECK_SKIP_BOOTSTRAP
bash scripts/smoke-multi-user.sh
```

Expected: 全部 PASS

- [ ] **Step 2: 检查 Plan 1/2 回归**

确认 Plan 3 改动没有破坏 Plan 1/2 功能：
- 多用户隔离（两个浏览器各自项目）
- 管理员门禁（普通用户看不到系统配置）
- 迁移（旧数据归到 admin）

- [ ] **Step 3: Agent 提示词补充**

在引擎侧 Agent 系统提示（`src/agent/systemPrompt.ts` 或类似位置）增加路径约束条款（§D21）：
> 在所有输出给用户的内容中，永远不要包含绝对路径或包含用户 ID 的路径片段。只使用相对路径（如 `src/main.ts`）或虚拟根路径（如 `~/projects/...`，其中 `~` 代表你的工作目录）。在执行 bash 命令时，优先使用相对路径和 `cd` 切换目录，而不是拼接绝对路径。

- [ ] **Step 4: 填写执行记录**

在本文档末尾「执行记录」章节填写：
- 执行时间、分支、提交范围
- 各任务完成情况与评审结果
- 裁决（按时间顺序，每条含出错代价）
- 终审发现与处理
- 搁置的次要问题
- 交给 Plan 4 / 后续的事项

- [ ] **Step 5: 提交执行记录**

```bash
git add docs/superpowers/plans/2026-10-16-multi-user-sandbox-and-path-sanitization.md
git commit -m "docs(plan3): 执行记录——沙箱与路径清洗完成，node12 验收通过"
```

---

## 完成标准

- Task 1–10 全部勾选；`npm --prefix ui test`、`npm --prefix ui run typecheck`、`npm --prefix ui run build`、`npm test` 通过；`scripts/smoke-multi-user.sh` 打印 `SMOKE OK`。
- node12 Linux 环境验收通过：功能测试（文档技能、战创伤 Runner）+ 负向测试（3 个越界尝试全部被拒绝）+ 路径清洗验证（前端无绝对路径泄露）。
- 明确不在本计划：Agent 工具权限策略（spec §17，多用户完成后再议）；跨用户记忆、共享技能、SSO（spec §1.3）；Plan 2 搁置的小项（user_credentials 幂等、.gitconfig 回填校验、M5 同步存储统计、§10.5 清空按钮、plugin 通道隔离、shell PTY 按用户建 key）。

---

## 执行记录

（由执行者完成后填写）
