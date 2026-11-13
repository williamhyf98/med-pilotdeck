# 沙箱可写范围收窄：改造清单 + 回归用例

> **目标一句话**：把 bash 沙箱的可写范围从"整个用户 home"收窄到
> **当前工作区 + `<home>/.cache` + `<home>/.tmp`**，让脚本（尤其是数据分析）无法误删
> `memory/`、其他工作区、`logs/`、`.trash/`。
>
> **不做什么**：不改 agent 的读范围（`memory`、技能缓存要读）、不改网络策略、不动
> `skills/` 的可见性（那是另一件事，见 permission-arch-v2-design §7）。

状态：**仅文档，未改代码**。

---

## 1. 现状（代码事实）

| 位置 | 当前行为 |
|---|---|
| `src/tool/builtin/bash/sandbox/bwrap.ts` → `wrap()` | `--bind <userHome> <userHome>`：**整个 home 读写挂载** |
| 同上 → `grants()` | `writable: grantForms(userHome)` |
| `src/tool/builtin/bash/sandbox/sandboxExec.ts` | `writeDirs = pathForms(userHome) + SYSTEM_WRITE_DIRS(=[])`；SBPL 里是 `(allow file* (literal "/dev/null") (subpath "<home>"))` |
| 同上 → `grants()` | `writable: [...SYSTEM_WRITE_DIRS, userHome]` |
| `src/tool/builtin/bash/commandRunner.ts` | `wrap()` 只传 `cwd` / `userHome` / `env`；`assertSandboxGrantsSafe()` 只校验"没覆盖到别的用户和系统配置" |
| `src/tool/builtin/bash.ts` | `runner.run()` 传 `context.cwd`（= 工作区根），**没有传** `permissionContext.additionalWorkingDirectories` |
| 读范围 | `appReadOnlyGrants()`：`skills/ plugins/ dist/ node_modules/ .runtime/` 只读挂载 |

后果（真实风险，不是假设）：

- 数据分析脚本里一句 `shutil.rmtree(os.path.expanduser("~/memory"))` 会**真删**；
- `rm -rf ../../其他工作区/exports` 可以跨工作区破坏；
- `rm -rf .trash` 会让"7 天可恢复"直接失效；
- `~/logs`、`~/projects/<repo>`（链接的 git 仓库）同样可写。

> 注意：`pathSafety.ts` 只管 file 工具，**bash 完全绕过它**。所以 file 工具的
> "inbox 只读 / 保留项禁写" 在 bash 里都不成立 —— 这是另一个既有缺口，本清单不扩大范围。

## 2. 目标态

| 维度 | 目标 |
|---|---|
| 写 | `<工作区根>`、`<home>/.cache`、`<home>/.tmp`（**不包括** `additionalWorkingDirectories`，见下注） |
| 读 | 保持整个 `<home>`（记忆、技能缓存、其他工作区读取都不动） |
| 挂载顺序（Linux） | 先 `--ro-bind <home> <home>`，再对每个可写根 `--bind`，最后 `--ro-bind skills/ plugins/ …` |
| 环境变量 | `HOME`、`PILOT_HOME`、`TMPDIR`、`XDG_CACHE_HOME` 保持不变（都指向 home / `.cache` / `.tmp`） |

> **关于"关联仓库"（2026-11-12 更正）**：底层确实有 `additionalWorkingDirectories` 机制
> （`createLocalGateway.ts` 从 `.cwd` marker 反推），但**当前产品没有这个入口**：
> `ProjectCreationWizard` 组件没有任何引用（死代码），`api.createWorkspaceProject` 没有调用点，
> `POST /api/projects/create` 又是 **admin-only**。所以写范围**不为它留口子**；
> 将来真做"关联文件夹/仓库"时再按需加入，并补一条 A10 用例。现在多开一个可写根只会扩大攻击面。

## 3. 允许写入清单（从 7 个技能的脚本反推）

| 技能 | 运行时写哪里 | 依据 |
|---|---|---|
| `pdf` | `$PDF_SKILL_CACHE` → 缺省 `${XDG_CACHE_HOME}/pilotdeck-pdf` = `<home>/.cache/pilotdeck-pdf` | `skills/pdf/scripts/pdf.sh:8` |
| `docx` | `<home>/.cache/pilotdeck-docx`；soffice 用 `tempfile.TemporaryDirectory()`（即 `TMPDIR=<home>/.tmp`）作为 profile 与输出 | `docx.sh:8`、`docxlib/render.py:409-431` |
| `pptx` | `<home>/.cache/pilotdeck-pptx` | `pptx.sh:8` |
| `spreadsheets` | `<home>/.cache/pilotdeck-spreadsheets` | `spreadsheet.sh:8` |
| `data-analysis` | `MPLCONFIGDIR=<home>/.cache/pilotdeck-analysis-mpl`；venv 走共享只读缓存；输出写工作区 `exports/` `scratch/` | `analysis.sh:30-35` |
| `frontend-slides` | 只写工作区 `exports/`（`html.sh` 无 cache 变量） | 已核对，无 CACHE_ROOT |
| `diagram-maker` | 只写工作区 | 同上 |
| 所有技能 | 各自 `__pycache__` 位于 `skills/`（只读）→ Python 静默跳过写 `.pyc`，不影响运行 | 现网已验证（`skills/docx/scripts/docxlib/__pycache__` 为打包产物） |

**结论**：`<工作区> + <home>/.cache + <home>/.tmp` 覆盖全部既有技能，无需逐技能配置。

## 4. 改造清单

| # | 文件 | 改动 | 风险 |
|---|---|---|---|
| **W1** | `sandbox/index.ts` | `SandboxWrapOptions` 增 `writeRoots: string[]`（绝对路径，已去重、已在 home 内）；`CommandSandbox.grants(userHome, writeRoots?)` | 低（纯类型/签名） |
| **W2** | `bash/commandRunner.ts` | `PilotDeckCommandOptions` 增 `writeRoots?: string[]`；`run()` 里把 `writeRoots` 归一化：只保留 `home` 内、`realpath` 去重、**默认 `[cwd]`**；`wrap()` 传入 | 低 |
| **W3** | `bash.ts` | `runner.run()` 传 `writeRoots: [context.cwd]`（**只传工作区**；不加 `additionalWorkingDirectories`，理由见 §2 注） | 低 |
| **W4** | `sandbox/bwrap.ts` | ①`mkdir -p <home>/.cache`（与现有 `.tmp` 并列，`--bind` 源必须存在）；②`--ro-bind home home` 替代 `--bind`；③对 `writeRoots` + `.cache` + `.tmp` 逐个 `--bind`；④`grants()` 返回收窄后的 writable | **中**：挂载顺序错了会 `ENOENT`/`EPERM` |
| **W5** | `sandbox/sandboxExec.ts` | `buildSandboxProfile()` 的 `writeDirs` 改为 `writeRoots + .cache + .tmp`；`grants()` 同步收窄 | **中**（SBPL 规则写错会全盘 EPERM） |
| **W6** | `bash/commandRunner.ts` → `assertSandboxGrantsSafe()` | 新增反向断言：writable **不得**覆盖 `memory/`、`logs/`、`skills/`、`.trash/`、`projects/`、`workspaces/*/*`（当前工作区除外）；任一命中 → 启动即失败 | 低（fail-closed） |
| **W7** | `src/pilot/config/{types,parseMultiUserConfig}.ts` | `multiUser.sandbox.narrowWrites: boolean`，默认 `true`；`false` = 回到"整个 home 可写"的逃生门（仅灰度期保留） | 低 |
| **W8（可选）** | `commandRunner.ts` | bwrap 分支补 `XDG_CACHE_HOME`（现在只有 macOS 分支设，Linux 靠 `HOME` 兜底）；若发现 npm 之类写 `~/.npm`，加 `NPM_CONFIG_CACHE=<home>/.cache/npm` | 低 |

**明确不做**：

- 不把 `.trash` / `.usage.json` / `.pinned` 做成只读挂载 —— 回收站本身要 `rename` 进 `.trash`，
  只读会互相打架；这部分继续靠"软删除 + 审计"兜底，并记入残余风险。
- 不收窄读范围（`memory`、其他工作区读取照旧），理由见 §6。

## 5. 回归用例

### 5.1 自动化（建议新增 `tests/sandbox/writable-scope.spec.ts`）

| ID | 场景 | 期望 |
|---|---|---|
| A1 | `bwrap` 生成的 args | 含 `--ro-bind <home> <home>`；含 `--bind <workspace>`、`--bind <home>/.cache`、`--bind <home>/.tmp`；**不含** `--bind <home> <home>` |
| A2 | `sandbox-exec` 生成的 profile | `(allow file* (literal "/dev/null") …)` 只列工作区/`.cache`/`.tmp`；**不出现** `(subpath "<home>")` 整包可写 |
| A3 | `grants()` 返回的 writable | 等于 `[workspace, .cache, .tmp]`（+additional dirs），不含 `home` 本身 |
| A4 | `assertSandboxGrantsSafe()` | 构造 writable=`[home]` → 抛错；构造 writable 覆盖 `memory` / 其他工作区 → 抛错 |
| A5 | `writeRoots` 归一化 | 传 `home` 之外的路径 / `..` / 相对路径 → 被丢弃或 clamp 到 home，不进入挂载 |
| A6 | 沙箱内实际写 | 工作区内 `touch` 成功；`<home>/.cache/x` 成功；`<home>/.tmp/x` 成功 |
| A7 | 沙箱内越界写 | `<home>/memory/x`、`<home>/logs/x`、`<home>/workspaces/<其他>/x`、`<home>/projects/x` 全部 **EPERM/EROFS** |
| A8 | 软链逃逸 | 工作区内 `ln -s ../../memory m` 后写 `m/x` → 失败 |
| A9 | 读不受影响 | 沙箱内 `cat <home>/memory/**` 仍可读；`cat skills/pdf/SKILL.md` 仍可读 |
| A10 | （预留，暂不实现） | 将来若接入"关联文件夹"，需断言其可写且仍在 home 内；当前**不传** `additionalWorkingDirectories`，无需覆盖 |

> A1/A2 直接断言生成的 argv / profile 字符串，不需要真跑沙箱，CI 友好；
> A6–A10 需要平台能力，按 `bwrap` / `sandbox-exec` 存在性跳过。

### 5.2 手工端到端（每个技能一条最小链路，macOS + Linux 各跑一遍）

| ID | 技能 | 命令（照抄各 SKILL.md 的 Quick Start） | 通过标准 |
|---|---|---|---|
| E1 | pdf | `bash "$PDF_SKILL_ROOT/scripts/pdf.sh" make --title T --markdown body.md --out "$PWD/exports/t.pdf"` | 生成 PDF；`<home>/memory` 未被触碰 |
| E2 | docx | `docx.sh make …` （含 `--render`，会走 soffice） | 生成 docx；soffice 转换成功（验证 `.tmp` profile 可写） |
| E3 | pptx | `pptx.sh make …` | 生成 pptx；无 `Permission denied` |
| E4 | spreadsheets | `spreadsheet.sh …` | 生成 xlsx |
| E5 | data-analysis | `analysis.sh check --json` → `analysis.sh run --script s.py --out exports/` | `ready`；跑出图表；matplotlib 字体缓存写入 `.cache` 成功 |
| E6 | frontend-slides | `html.sh themes` → 生成 HTML | 产物在 `exports/`；`html.sh audit` 通过 |
| E7 | diagram-maker | `diagram.sh make …` | 生成图；无写权限报错 |

**E2/E5 是重点**：这两条最容易因收窄而挂（soffice 需要可写 profile、matplotlib 需要可写缓存）。

### 5.3 反向验收（"确实挡住了"）

| ID | 操作 | 期望 |
|---|---|---|
| N1 | 让 agent 跑 `rm -rf ~/memory` | 失败（EPERM），且审计有记录 |
| N2 | `rm -rf ../<其他工作区>` | 失败 |
| N3 | `rm -rf .trash` | **仍会成功**（已知残余风险，见 §6） |
| N4 | 正常任务（E1–E7） | 全部不受影响 |

## 6. 残余风险与不做的理由

| 项 | 现状/原因 | 处理 |
|---|---|---|
| 工作区内 `.trash` 仍可被 bash 删除 | 回收站本身依赖 `rename` 进 `.trash`，只读挂载会冲突 | 接受；靠软删除 + 审计 `trash.purge` 留痕 |
| bash 可读其他工作区 | 读范围保持整个 home（记忆/缓存需要） | 接受；跨**用户**已由挂载隔离 |
| `~/.config`、`~/.local` 写入会失败 | `HOME` 仍是 home，只放行 `.cache`/`.tmp` | 若某技能真的需要，按需增挂具体目录（不要整包放开） |
| 写 `~/projects/` 下内容 | 该目录放的是项目 `.cwd` marker，不是用户文件；当前无 UI 用途 | 收窄后不可写；如需改项目元数据，走接口而非 bash |
| Windows | `sandbox.kind=none`，本方案不涉及 | 不做 |

## 7. 回滚

- 配置逃生门：`multiUser.sandbox.narrowWrites: false` → 恢复"整个 home 可写"，**无需回滚代码**。
- 代码回滚点：W4/W5 是两个独立提交，可单独 revert。

## 8. 顺序与验收口径

| 阶段 | 内容 | 验收 |
|---|---|---|
| S1 | W1–W3 + W7（接线与开关，行为不变） | 全量测试绿；`narrowWrites:false` 与现状行为一致 |
| S2 | W4（Linux bwrap） | A1/A3/A5–A10 + Linux 上 E1–E7 |
| S3 | W5（macOS sandbox-exec） | A2 + macOS 上 E1–E7 |
| S4 | W6 反向断言 + N1–N4 | 启动自检通过；越界写全部失败 |

**上线口径**：双平台 E1–E7 全绿 + A1–A10 全绿 → 默认 `narrowWrites: true`；
任何一条技能回归失败 → 该项保留 `false`，先修技能（不要为了过测试放宽成整包可写）。

**预估**：S1 0.5d｜S2 0.5–1d｜S3 0.5d｜S4 0.5d，合计 **2–2.5d**（不含技能侧修缺陷）。

## 9. 实施记录

### S1 完成（2026-11-12）：接线 + 开关，默认关闭

**行为不变**：`multiUser.sandbox.narrowWrites` 缺省 / 显式 `false` 时，可写范围仍是整个 user home；
新增的 `writeRoots` 参数在此档位被忽略。

| 文件 | 改动 |
|---|---|
| `src/tool/builtin/bash/sandbox/writeScope.ts`（新） | `resolveWriteRoots()` 唯一口径（`narrowWrites` 两档）、`canonicalPath()`、`isWithin()`、`describeWriteScope()` |
| `src/tool/builtin/bash/sandbox/index.ts` | `SandboxWrapOptions.writeRoots?`；`CommandSandbox.grants(userHome, writeRoots?)`；三个 Options 类型加 `narrowWrites` |
| `src/tool/builtin/bash/sandbox/bwrap.ts` | 收窄档：`--ro-bind <home>` + 逐根 `--bind`（含 `.cache`/`.tmp`，缺则建）；`grants()` 走同一口径 |
| `src/tool/builtin/bash/sandbox/sandboxExec.ts` | `buildSandboxProfile(config, userHome, writeRoots?)`；收窄档写规则不再出现 `(subpath "<home>")` |
| `src/tool/builtin/bash/commandRunner.ts` | `PilotDeckCommandOptions.writeRoots?`；读配置、传给 `wrap()`（缺省 `[cwd]`）；启动日志加 `writes=narrow\|home` |
| `src/tool/builtin/bash.ts` | `runner.run()` 传 `writeRoots: [context.cwd]`；审计改用 `context.now` 的时钟（见下） |
| `src/pilot/config/{types,parseMultiUserConfig}.ts` | `narrowWrites?: boolean`，缺省 `false`，非布尔值回落 + 一条 `multi-user.sandbox.invalid` 诊断 |
| `tests/tool/builtin/bash/sandbox/writeScope.spec.ts`（新） | 8 条：两档返回值、越界/相对路径/home 本身丢弃、bwrap argv、SBPL profile |

**测试**：`npx tsc --noEmit` ✅ ｜ `npm test` → **873 tests / 871 pass / 0 fail / 2 skipped** ｜
`ui && npx vitest run` → **174 files / 1313 passed**。

**顺带修掉一个与 S1 无关的既有定时炸弹**：`analysis.rejected` 审计用真实时钟分片，
而 `tests/tool/analysis-audit.spec.ts` 按 `2026-11-11` 读文件，跨天后必挂。
改为 `appendAudit(..., { now: context.now?.() })`——审计文件跟随本次调用日期，测试可注入。

**未做（留待 S2）**：Linux 上真实打开 `narrowWrites: true`、跑 E1–E7 七个技能回归；
macOS 侧同理（S3）。默认值在双平台回归全绿前保持 `false`。

**已知残余风险**（§6）：工作区 `.trash` 仍可被 bash 删除；`~/.config`、`~/.local` 收窄后不可写。

### S3 完成（2026-11-12）：macOS `sandbox-exec` 真开 + E1–E7 实测

**方法**：不改动正在运行的服务，用临时用户 home（`<tmp>/users/7`）走**生产同一条路径**——
`parseMultiUserConfig` 读真实 `pilotdeck.yaml`，只把 `sandbox.narrowWrites` 改成 `true`，
再 `initializeSandbox()` → `NodeShellCommandRunner.run()`（真 sandbox-exec + 真技能脚本）。

**跑出来的一个真缺陷（已修）**

| 现象 | 根因 | 修法 |
|---|---|---|
| 收窄后 `cat ~/memory/x` → `Operation not permitted`；`analysis.sh run` 读不了 `inbox/`，直接 exit 4 | SBPL 的读规则一直是 `(allow file-read* (literal "/") <SYSTEM_READ_DIRS+appGrants>)`，**从来没单独列过 home**；兼容档位下 home 可读是写规则 `(allow file* (subpath home))` 顺带给的。收窄把 home 移出写规则 → 读权限同时消失 | `buildSandboxProfile()` 的 `readDirs` 显式加入 `pathForms(userHome)`；`grants().readOnly` 同步（macOS 始终、bwrap 收窄档位），并补 2 条断言锁死 |

> 这个坑只在真跑时暴露：单测只断言"写规则不含 home"，没人验证"读规则仍含 home"。

**E1–E7（`narrowWrites: true`，macOS 15.6.1 / sandbox-exec）**

| ID | 命令 | 结果 | 产物 |
|---|---|---|---|
| E1 | `pdf.sh make` | ✅ 0.78s | `exports/s3.pdf` 12.7 KB |
| E2 | `docx.sh make` | ✅ 0.51s | `exports/s3.docx` 36.9 KB |
| E2b | `docx.sh check` | ✅ 0.19s | — |
| E3 | `pptx.sh make` | ✅ 0.30s | `exports/s3.pptx` 322 KB |
| E4 | `spreadsheet.sh make` | ✅ 0.35s | `exports/s3.xlsx` 6.7 KB |
| E5a | `analysis.sh check --json` | ✅ 0.03s | `ready` |
| E5b | `analysis.sh run` | ✅ 6.8s | `exports/analysis/s3-…/run.json` `status: ok`；`MPLCONFIGDIR` 落在 `~/.cache`，字体缓存首建成功 |
| E6a | `html.sh themes` | ✅ 0.04s | 六套主题 |
| E6b | `html.sh audit` | ✅ 0.05s | 内联主题 CSS 后 0 error |
| E7 | `diagram.sh make` | ✅ 0.06s | `exports/s3.svg` 1.7 KB |

**反向验收（同一次运行）**

| 用例 | `narrowWrites: true` | `false`（对照） |
|---|---|---|
| 写 `~/memory`、`~/logs`、`~/projects`、其他工作区 | ✅ 全部 EPERM | ❌ 全部成功（**这就是要收窄的原因**） |
| 软链指向 `~/memory` 再写 | ✅ 失败 | ❌ 成功 |
| 写工作区 `exports/`、`~/.cache`、`~/.tmp` | ✅ 成功 | ✅ 成功 |
| 读 `~/memory/seed.txt`、`skills/pdf/SKILL.md` | ✅ 成功 | ✅ 成功 |
| home 顶层残留 | 只有 `.cache`/`.tmp`/`logs`/`memory`/`projects`/`workspaces`，`memory` 内文件未被改 | — |

**没覆盖到的**

- `docx.sh make --render`：本机没有 LibreOffice，本地也没起 19400 渲染服务，`render` 走不到；Linux 侧（S2）连带验证。
- bwrap（Linux）：未测，S2。
- Windows：不涉及。

**结论**：macOS 侧 `narrowWrites: true` 通过 E1–E7 与全部反向用例。默认值仍保持 `false`，
等 Linux（S2）同样全绿后再切默认。

### S4 完成（2026-11-12）：W6 反向断言 + A4/A6–A9 + N1–N4 自动化

**代码（W6）**：`assertSandboxGrantsSafe(sandbox, userHome, { narrowWrites, writeRoots })`
—— 仅当 `narrowWrites: true` 时生效（默认档位行为不变），可写授权逐条压回白名单，命中即启动失败：

| 规则 | 拒绝示例 | 报错 |
|---|---|---|
| 必须落在 home 内 | `/tmp/x` | `escapes the user home` |
| home 本身不可整体可写 | `writable = [home]` | `covers the whole user home` |
| `workspaces/` 根不可写 | `home/workspaces` | `covers the workspaces root` |
| 只允许声明的当前工作区 | `home/workspaces/p2` | `covers another user workspace` |
| `memory/logs/skills/.trash/projects` 双向拒绝 | `home/memory`、`home/logs/audit` | `overlaps protected directory` |

`initializeSandbox()` 已把 `narrowWrites` 传入，配置一旦打开，**启动时**就会读实际 grants 自检，
不是只靠 `wrap()` 时的参数正确。

**测试**

| 文件 | 用例 |
|---|---|
| `tests/tool/builtin/bash/commandRunner.spec.ts` | +2 条：合法组合（工作区 + `.cache` + `.tmp`）通过；9 种越界写法逐一抛错；兼容档位不触发 |
| `tests/tool/builtin/bash/sandbox/writableScope.integration.spec.ts`（新） | 7 条真跑沙箱：A6 三个可写点、A7 五处越界写、A8 软链逃逸、A9 读不受影响、N1 `rm -rf ~/memory`、N2 `rm -rf` 兄弟工作区、N3 `.trash` 仍可删（已知残余风险，显式钉住） |

真跑用例在 `platform` 无可用沙箱（非 macOS/Linux、缺 `sandbox-exec`/`bwrap`）时整组 skip，CI 不会红。

**结果**：`npx tsc --noEmit` ✅ ｜ `npm test` → **882 tests / 880 pass / 0 fail / 2 skipped**
（比 S3 多 9 条）。S3 的手工 harness 重跑仍然全绿，确认 W6 没有误杀正常路径。

**仍未做**：Linux bwrap 真机验证（S2）；`narrowWrites` 默认值保持 `false`，等 S2 全绿后再切。
