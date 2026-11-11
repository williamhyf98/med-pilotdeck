# permission-arch v2 执行清单（两条轨道 + 门槛）

> **这份文件只写"做什么 / 什么顺序 / 怎么验收 / 做到哪了"。**
> "是什么 / 为什么 / 边界"在 [permission-arch-v2-design.zh.md](../permission-arch-v2-design.zh.md)，
> 数据分析技能的细节在 [data-analysis-skill-design.zh.md](../data-analysis-skill-design.zh.md)。

## 0. 使用规则（三条，别再变）

1. **只追加，不改写**：完成即打 `[x]`，下面补一行「实测结论：……」；前面的段落不回头改。
2. **顺序用"门"表达，不用"第几步"**：决策变化只移动某一扇门，不重编号整张表。
3. **每个勾必须附一条跑过的命令**：`npm run build` / `node --test …` / 手工实测，三者之一。

## 0.1 门总表

| 门 | 含义 | 谁卡在这 | 状态 |
|---|---|---|---|
| **门 0** | 审计骨架 + 路径校验三条跑通 | **所有人**（含 B 轨） | ✅ **已通过（2026-11-11）** |
| 门 1 | 删除能进 `.trash`、可恢复 | A 轨前端删除按钮 | 未开始 |
| 门 2 | 前端工作区页 + 管理员总览可交付 | 只有 A 轨 | 未开始 |
| 门 3 | 数据分析技能可交付（含安全用例全绿） | 只有 B 轨 | 未开始 |

> 心法：**门 0 谁都别跳；之后 A 轨（用户看得见 / 能删 / 知道 inbox 多大）与
> B 轨（agent 能安全跑分析脚本）各走各的，唯一交汇点是门 0 和 B0。**

## 0.2 实现顺序总图

```
                       ┌──────────────────────────────────────────┐
                       │  门 0 · 地基（2d）—— 两条轨道共用的唯一前置  │
                       │   1.1 审计骨架（1d）                       │
                       │   1.2 路径校验三条（1d）                    │
                       └────────────────────┬─────────────────────┘
                                            │  门 0 通过
              ┌─────────────────────────────┴─────────────────────────────┐
              │                                                           │
              ▼  A 轨：权限与可见性（5.3d）                                 ▼  B 轨：数据分析（6.3d）
   ┌──────────────────────────────┐                        ┌──────────────────────────────┐
   │ A1 软删除 → .trash（1.5d）     │                        │ B0 白名单接线（1d）            │
   │      rename + restore + 7天清  │                        │  PolicyStore → bash 判定       │
   └──────────────┬───────────────┘                        └──────────────┬───────────────┘
                  │  ◆ 门 1：能删、能恢复                                     │
                  ▼                                                       ▼
   ┌──────────────────────────────┐                        ┌──────────────────────────────┐
   │ A2 删除按钮 + 用量汇总（0.8d）  │                        │ D1 设计定稿（0.5d）            │
   └──────────────┬───────────────┘                        │ D2 技能骨架（0.5d）            │
                  │                                         │ D3 离线运行时（0.5d）          │
                  ▼                                         │        │                     │
   ┌──────────────────────────────┐                        │        ▼                     │
   │ A3 工作区页 + 管理员总览（3d）  │                        │ D4 唯一入口（1d）              │
   │  三用量条 / inbox 列 / 403     │                        │ D5 执行期安全（1d）            │
   └──────────────┬───────────────┘                        │ D6 产物落位（0.3d）            │
                  │                                         │ D7 管理员依赖页（1d）          │
                  ▼  ◆ 门 2：前端可交付（A 轨结束）             │ D8 测试（1d）                 │
                  │                                         └──────────────┬───────────────┘
                  │                                                        │ ◆ 门 3：12 条安全用例全绿
                  └──────────────────────┬─────────────────────────────────┘
                                         ▼
                        ┌────────────────────────────────────┐
                        │ 第二批：回收站页面 / 新建目录 /        │
                        │ scratch 自动清理 / 归档硬删除收口      │
                        └────────────────────────────────────┘
```

**三条"为什么必须这样排"的硬理由**

| 顺序 | 不能颠倒的原因 |
|---|---|
| 门 0 → 所有 | 路径三条是"写不进 `inbox`"的唯一实现；审计不在，后面的拒绝都无法留证。B 轨的 S7–S9 三条安全用例直接依赖它 |
| A1 → A2 | 删除按钮一旦先上线，就是**不可恢复的硬删除**；`.trash` 必须先存在 |
| B0 → D1 | 没接线时每条分析命令都要用户点一次，D 系列无法连续实测 |
| D3 → D4 | venv 不存在，`analysis.sh run` 根本起不来 |
| D4 → D5 | 先跑通再上拦截，否则分不清"被拦"还是"本身没跑通" |
| D5/D6 → D8 | 测试要拿真实产物与真实拒绝记录做断言 |

---

## 1. 门 0：地基（2d）✅ 已通过 2026-11-11

### 1.1 审计骨架（1d）

- [x] 新建 `src/security/audit/auditLog.ts`：`appendAudit(event)` 追加一行 JSON 到
      `<systemHome>/system/audit/<YYYY-MM-DD>.jsonl`（2026-11-11 完成）
      字段：`ts / action / decision / tool / target(相对路径) / reason / actor / meta`
      `systemHome` 取 `PILOTDECK_SYSTEM_HOME ?? PILOT_HOME`，与 `security/policy/paths.ts` 同约定
- [x] **写失败只打日志、绝不阻断业务**（整段 try/catch，返回 `{ok:false,error}` 供测试断言）
- [x] 接入 3 个点：`pathSafety.ts` 的 `file.denied`（写入拒绝 + 跨用户拒绝）、
      `bash/permissions.ts` 的 `bash.denied`（含命令片段脱敏）、
      沙箱启动探测/网络自检失败 `sandbox.denied`
- [x] 测试 `tests/security/audit-log.spec.ts`（7 条）：同日追加 / 跨天分文件 / SYSTEM_HOME 优先 /
      绝对路径退化 / 目录不可写不抛 / 超长字段截断 / 端到端一次写入拒绝留痕
- [x] `npm test` 全绿（2026-11-11：813 tests / 811 pass / 0 fail / 2 skipped）

**验收**：手动触发一次 deny，`system/audit/2026-11-11.jsonl` 出现一行；把该目录 `chmod 500` 后业务仍正常返回 deny。

### 1.2 路径校验三条（1d）

统一落点：`src/tool/builtin/filesystem/pathSafety.ts` 的 `writeDenialMessage()` 与三处 `forWrite` 分支
（全仓 23 处 `resolvePilotDeckWorkspacePath` 调用自动生效；上传接口不走它，无需豁免）。

- [x] ① `reserved`：顶层 `.trash` / `.usage.json` / `.pinned` / `.tmp` 写入 → deny（2026-11-11 完成）
- [x] ② `inbox`：**写操作**目标落在 `inbox/**` → deny（读不变）（2026-11-11 完成）
- [x] ③ 覆盖确认：`office_to_pdf` 输出已存在 → `ask`（含 allow_session）+ 审计 `file.overwrite_ask`（2026-11-11 完成）
      **口径修正**：`write_file` / `edit_file` 已有更强的一道门 —— `validateWriteSnapshotFresh()` 要求
      "写前必读 + 读后内容哈希不变"，未读过的文件直接报错、内容变过要求重读；在这两条工具上再加"覆盖 ask"
      只会变成每次改稿都弹窗的噪音，因此**不叠加**。真正裸写落盘的只有 `office_to_pdf`，覆盖确认补在这里。
- [x] 测试：`tests/tool/path-safety-write-roots.spec.ts` **9 条全过**（覆盖确认用例待 ③ 完成后追加）
- [x] `npm test` 全绿（2026-11-11：806 tests / 804 pass / 0 fail / 2 skipped）

**验收**：`§14` 第 15、16 条通过。参考基线 `tests/tool/path-safety-{chat-attachments,multiuser}.spec.ts`。

> 注：`inbox` 只读只覆盖 `write_file` / `edit_file` / `office_to_pdf`；
> bash 的 `rm/mv/cp` 仍可写 `inbox`（已知残留风险，见设计书 §16）。
> 仓库里**没有** move/copy 文件工具，所以本条不需要扩展源路径判断。

---

## 2. A 轨：权限与可见性（5.3d）

### 2.1 A1 软删除（1.5d）

**前置**：门 0。**没有 `.trash` 兜底就不许出现删除入口。**

- [ ] `ui/server/routes/storage.js` 的 `deleteTarget()`：`kind:'file'` 由 `fs.rm` 改
      `rename` → `<groupRoot>/.trash/<相对路径>.<时间戳>`
- [ ] 保留项拦截：`.trash` / `.usage.json` / `.pinned` / `.tmp` 及其子路径 → 400
- [ ] `rename` 失败（磁盘满等）→ 可读错误 + 审计；**不得退化为 `rm`**
- [ ] `POST /api/trash/restore`（原路径被占用则提示改名）
- [ ] 每日过期清理任务（7 天，物理删除，写审计）
- [ ] 测试：删 inbox 文件后原件消失、`.trash` 出现；恢复成功；保留项 400

**验收**：设计书 §14 第 4 条「进 `.trash`，提示"已移入回收站"，不得真删」。

### 2.2 A2 删除按钮 + 用量汇总（0.8d）

**前置**：A1。

- [ ] 前端删除只针对 `kind:'file'`；文案统一为"移入回收站（7 天后自动释放）"，**不出现"永久删除"**
- [ ] 批量删除一次汇总确认（列文件数 + 总大小）
- [ ] `scanStorage()` 返回体加 `usage: { inboxBytes, exportsBytes, scratchBytes, totalBytes }`
      （从已有 `files[].path` 前缀聚合，不新增扫描）
- [ ] 测试：三组之和 = `workspaceBytes`；删文件后总量下降

**门 1 通过条件**：删除 → `.trash` → 能恢复，且保留项拦得住。

### 2.3 A3 前端工作区页 + 管理员总览（3d）

**前置**：A2 的 `usage` 字段。

- [ ] 工作区页：目录树懒加载（名称/大小/mtime）、预览（pdf/docx/xlsx/图片/文本）
- [ ] **三条用量条**：工作区总量 / `scratch` / `inbox`（纯提示，超阈值变黄）
- [ ] 能力卡片三行文案（可读＝整个工作区；可写＝除 `inbox` 与保留项；技能文档只读）
- [ ] 管理员总览（设计书 §9.2.1）：合计、排序、占比、**其中 inbox 列**、阈值着色、手动刷新、归档标灰
- [ ] 普通用户访问 `/api/admin/users` → 403（补测试锁定）
- [ ] 旧 `StorageV2.tsx` 保持不动（不在它上面加删除入口）

**门 2 通过条件**：设计书 §14 第 18、19、21、22 条。

---

## 3. B 轨：数据分析技能（1d + 5.3d）

### 3.1 B0 注册命令白名单接线（1d）

**前置**：门 0（不依赖 A 轨）。做完后 D 系列才不会每条命令都弹窗。

- [x] `src/tool/builtin/bash/permissions.ts` → `classifyBashPermission(command, {cwd, env})` 插入策略层：
      `HARD_DENY` → **白名单命中且选项/读写根全合规则 allow** → 只读 passthrough → 其余 ask（2026-11-11 完成）
- [x] 数据源：`<PILOT_HOME>/system/security/command-policy.yaml`（`PolicyStore` 已有 revision 锁、拒绝软链）；
      新增 `commandPolicyRuntime.ts` 按 **mtime** 缓存，管理员改完即时生效
- [x] 第一条登记命令：`data-analysis.run`（`--script/--input/--out/--timeout/--mem-mb`，
      `inputRoots=[inbox,scratch]`，`outputRoots=[exports]`，`timeoutMs=1_800_000`）+ `data-analysis.check`
- [x] 策略文件非法 → **fail-closed 到 ask**（不是直接拒），并写审计 `policy.invalid`
- [x] 测试 `tests/security/registered-commands.spec.ts`（11 条）：形状识别 / 合规 allow / 越根 deny /
      `..` 与绝对路径逃逸 / 未登记选项与 `--flag=value` / 未登记 id / 端到端 allow / 端到端 deny /
      `python3` 仍 ask / 坏 YAML 回落 ask / 管理员 `enabled: false` 生效
- [x] `npx tsc --noEmit` ✅ ｜ `npm test` → **827 tests / 825 pass / 0 fail / 2 skipped**

### 3.2 B1 技能本体（5.3d）

细节全部在 [data-analysis-skill-design.zh.md](../data-analysis-skill-design.zh.md)。

| # | 步骤 | 工期 | 前置 | 状态 |
|---|---|---|---|---|
| D1 | 设计文档定稿（依赖清单 / 12 条安全用例 / 正确性清单） | 0.5d | B0 | ✅ |
| D2 | 技能骨架 `skills/data-analysis/**` | 0.5d | D1 | ✅ |
| D3 | 离线运行时（venv + wheels + Dockerfile 两处） | 0.5d | D2 | 🟡 代码已接（Dockerfile 加 `-r`、`prepare-offline-runtime.sh` 调 bootstrap）；未在 arm64 容器实测 |
| D4 | 唯一入口 `analysis.sh run` | 1d | D3 | ✅ |
| D5 | 执行期安全（AST 黑名单 + 运行期护栏 + 资源上限） | 1d | D4 | ✅ |
| D6 | 产物落位 `exports/analysis/<slug>-<ts>/` | 0.3d | D4 | ✅ |
| D7 | 管理员「数据分析依赖」页 | 1d | D3 | 🟡 只读接口 `GET /api/admin/skills/data-analysis/deps` 完成；前端页面未做 |
| D8 | 正确性 + 安全测试 | 1d | D5、D6 | 🟡 S1–S12 + C1/C12/R1 已覆盖；C2–C11、R2/R3 待补 |

**门 3 通过条件**：设计书 §14 第 24、25 条必须失败且留审计；
真实 CSV 能产出统计结果与图文件。

---

## 4. 已完成的留档（不要重复做）

### 4.1 网络出口策略（2d，2026-11-11 完成）

- [x] Linux 按技能分组落策略（`data-analysis` → `none`）
- [x] macOS 三态 `network` 真正生效 + 端口级 `allowlist`
- [x] 启动自检（5 探针 + fail-closed）
- [x] 配置落地：`.pilotdeck-home/pilotdeck.yaml` → `network: none` + 3 个 openSkills + `networkAllow: 10.31.112.13:19400`
- [x] 提交：`9ee2b91`（功能）、`f207e72`（macOS SBPL 实测结论）

**实测结论**：macOS `none` 下内网 19400/8000/18890/18130 与公网全 EPERM、DNS BLOCKED、自起服务 OK；
`allowlist` 只放 19400；Linux `--unshare-net` 全 ENETUNREACH。`npm test` 795 passed。

### 4.2 已核实"无需再做"的项

- [x] **统一路径校验**：`validatePathInProject` 在本仓库不存在；
      `ui/server/utils/pilotPaths.js:170` 的 `assertPathInUserHome()` 已做 realpath + 软链 + 用户 home 三重校验，
      且 `storage.js` / `projects.js` / `skills.js` 均已接入 → 取消（2026-11-11）
- [x] **用户目录占用统计**：`ui/server/services/storageUsage.js` + `/api/admin/users` 已返回 `storageBytes`，
      用户表格已有"存储"列 → A 轨只补"合计/排序/占比/inbox 列"
- [x] **存储删除接口**：`ui/server/routes/storage.js` 已支持 `kind: file/workspace/archive` + 软链/边界校验
      → A1 只改"`fs.rm` → `rename`"

---

## 5. 第二批（门 2 + 门 3 之后）

| 项 | 触发条件 |
|---|---|
| 回收站页面（列表 / 恢复 / 清空） | A1 稳定运行 2 周；"清空"是唯一不可恢复入口，必须单独汇总确认 |
| 前端写操作：新建目录、就地编辑 | 回收站页面先上线 |
| `scratch` 自动清理 | 告警跑满 2 周、拿到真实用量分布 |
| `kind:'workspace'` / `kind:'archive'` 硬删除收口 | 与"归档"功能一起设计 |
| 可见性白名单 / 沙箱可写范围收窄 | `skills/_shared` 结构冻结、skills 回归跑完（不急） |

**参考总量**：第一批 ≈13.6d（两人并行关键路径 7.3d）；第二批 ≈3.5d；第三批 ≈3d。

---

## 6. 进度日志（只追加）

### 2026-11-11

- 文档拆分：设计书 §15 移出为本文档；新增 `docs/data-analysis-skill-design.zh.md`；设计书 §15 改为指针表。
- 决策变更留档：D-P10（软删除保留、删除按钮提前）、D-P11（inbox 单列）、D-P12（白名单接线）、
  D-P13（bash 可写 inbox 入风险表）、D-P14（两轨三门）、D-P15（取消统一路径校验）。
- 网络出口部分已关闭，不再讨论。

### 2026-11-11 · 门 0 / 1.2 第一切片

- 改动：`src/tool/builtin/filesystem/pathSafety.ts` 新增 `RESERVED_WORKSPACE_ENTRIES`、
  `READ_ONLY_WORKSPACE_ROOTS`、`writeDenialMessage()`；三处 `forWrite` 分支改为输出带原因的拒绝消息
  （原来统一是 "not allowed by default"，模型分不清原因）
- 新增测试：`tests/tool/path-safety-write-roots.spec.ts`（9 条，含 bypass / default 两种模式）
- 命令：`npx tsc --noEmit` ✅ ｜ `npm test` → **806 tests / 804 pass / 0 fail / 2 skipped**
- 实测结论：写 `inbox/**`、`.trash|.usage.json|.pinned|.tmp` 均 `path_not_allowed` 且消息含原因；
  `exports/`、`scratch/`、用户自建目录（含 `我的资料/`）不受影响；**只有顶层段生效**
  （`my/inbox/x` 与 `data/.trash/a` 允许），避免把用户自己的同名子目录误杀
- 未做：③ 覆盖确认（下一步）

### 2026-11-11 · 门 0 / 1.1 审计骨架

- 新增 `src/security/audit/auditLog.ts`（`appendAudit` / `resolveAuditDir` / `auditFilePath` / `sanitizeTarget`）
- 接入点：`pathSafety.ts`（`file.denied`，含跨用户拒绝占位 `(outside-workspace)`）、
  `bash/permissions.ts`（`bash.denied`，命令片段先把路径抹成 `(path)`）、
  `commandRunner.ts`（`sandbox.denied`，探测失败与网络自检失败两处）
- 防泄漏：绝对路径一律退化为 `(absolute)/<basename>`；单字段 500 字符、单行 4 KB 上限
- 命令：`npx tsc --noEmit` ✅ ｜ `npm test` → **813 tests / 811 pass / 0 fail / 2 skipped**
- 实测结论：测试全程未在真实的 `~/.pilotdeck` 下产生 `system/audit`（所有用例都注入临时 `PILOT_HOME`），
  说明审计目录跟随注入的 home，不会污染开发机
- 未做：③ 覆盖确认（下一步）

### 2026-11-11 · 门 0 / 1.2 ③ 覆盖确认（门 0 收口）

- 改动：`src/tool/builtin/officeToPdf.ts` 的 `checkOfficeToPdfPermissions()` —— 输出文件已存在时返回 `ask`
  （`allow_session` 作用域为该目录），并写审计 `file.overwrite_ask`
- 口径修正：`write_file` / `edit_file` 不叠加覆盖 ask，理由见 §1.2 ③
- 新增测试：`tests/tool/office-pdf-overwrite-ask.spec.ts`（3 条：已有输出 → ask + 审计；
  新输出 → passthrough；写 inbox → deny）
- 命令：`npx tsc --noEmit` ✅ ｜ `npm test` → **816 tests / 814 pass / 0 fail / 2 skipped**
- 结论：**门 0 通过**，可以并行开 A1（软删除）与 B0（白名单接线）

### 2026-11-11 · B0 注册命令白名单接线

- 新增：`security/policy/{skillCommandSpecs,registeredCommands,commandPolicyRuntime}.ts`
- 改动：`parseCommandPolicy.ts`（注册 `data-analysis.run` / `data-analysis.check`）、
  `bash/sandbox/networkPolicy.ts`（抽出 `simpleInvocationTokens`）、
  `bash/permissions.ts`（策略层）、`bash.ts`（把 `cwd`/`env` 传进去）
- 三档结果：合规 → `allow`（零弹窗）；越根 → `deny`（不可点通过）；其余 → 回落 `ask`
- 冒烟（dist + 临时 PILOT_HOME 实测）：
  `analysis.sh run ... --out exports/...` → allow ｜ `--out inbox/x` → deny ｜
  `python3 x.py` → ask ｜ `docx.sh make --out exports/a.docx` → allow
- **行为变化**：已登记的 `pdf/docx/pptx/spreadsheets/diagram` 子命令合规时也不再弹窗；
  不想放行的子命令在 YAML 里 `enabled: false` 即可
- 命令：`npx tsc --noEmit` ✅ ｜ `npm test` → **827 tests / 825 pass / 0 fail / 2 skipped**
- 下一步：D1 设计定稿 → D2 技能骨架（B 轨），或转 A1 软删除

### 2026-11-11 · B1 技能骨架 + 双层安全（D2/D4/D5/D6）

- 新增：`skills/data-analysis/{SKILL.md,references/cheatsheet.md,scripts/analysis.sh,scripts/run_analysis.py,scripts/analysis_guard.py,runtime/requirements.txt}`
- 入口：`analysis.sh {check [--json] | run --script … --input … --out … | bootstrap-runtime}`，
  子命令与参数名和 `skillCommandSpecs.ts` 逐字一致（只认 `--flag value`）
- 安全两层：静态 AST（S1–S12 字面量）+ 运行期 `sys.addaudithook`（动态路径、`getattr` 拼函数、
  动态导入的模块）。运行期拒绝不再混在 `failed` 里，单独 `status: blocked` / 退出码 8
- 修掉一个坑：macOS 不支持 `RLIMIT_AS`，`preexec_fn` 里抛异常会让**所有**脚本起不来；
  现在逐项 `try` 设置，macOS 退化成 `RLIMIT_DATA`，Linux 上 `RLIMIT_AS` 照旧生效
- 另修两个真问题（都是实测才暴露的）：
  ① 冷字体缓存下 matplotlib 会 `subprocess` 跑 `fc-list` / `system_profiler` 扫字体 →
  护栏对这几个只读枚举工具放行，并把字体缓存在 `bootstrap-runtime` 预热到 `$CACHE_ROOT/mpl`；
  ② 系统 python 的 pydicom 装在 user-site，被 `-I` 隔离后不可见 —— 生产用 venv，不受影响，
  开发机自测 DICOM 片段需直接在 venv 里跑
- 冒烟（临时工作区，系统 python3）：C1 样本 → `tables/summary.csv` + `figures/*.png`（960×640）
  + `run.json`（依赖版本、输入指纹、limits）；动态越界写 / `getattr(os,'system')` /
  动态 socket / `chdir /` / `os.remove` 工作区外 → 全部 `blocked`
- 新增测试：`tests/skills/data-analysis-runner.spec.ts`（6 条：S1–S12 逐条、运行期护栏 6 类、
  C1 数值与 BOM、C12 两次一致、R1 超时、参数越界）
- 命令：`npx tsc --noEmit` ✅ ｜ `npm test` → **833 tests / 831 pass / 0 fail / 2 skipped**
- 未做：D8 的 C2–C11 与 R2/R3、D7 前端页面

### 2026-11-11 · B1 离线运行时接线 + 随包中文字体（D3 代码部分）

- `packaging/offline-arm64.Dockerfile`：离线 requirements 加一行
  `-r /src/skills/data-analysis/runtime/requirements.txt`（与 pdf/docx/med-tools 共用同一批 wheels）
- `scripts/prepare-offline-runtime.sh`：导出 `PILOTDECK_ANALYSIS_CACHE` / `PILOTDECK_ANALYSIS_WHEELS`
  并调 `analysis.sh bootstrap-runtime`（wheels 目录由 `analysis.sh` 的 `WHEEL_DIR` 承接，不再往技能里拷第二份）
- `scripts/check-offline.sh`：加一条结构检查（技能入口必须存在）
- 字体：`analysis_plot.py` 注册随包 Noto Sans SC / Noto Serif SC（复用 `skills/pdf/assets/fonts`，
  不打第二份进镜像），`analysis.sh` 导出 `PILOTDECK_ANALYSIS_FONTS`，bootstrap 时预热字体缓存
- 实测（系统 python3）：`import analysis_plot` → `family= Noto Sans SC`，中文标题零 glyph 警告，
  PNG 960×640
- 未验证：arm64 容器里的 `pip wheel` 解析（本机无 docker/arm64）

### 2026-11-11 · D7（后端）管理员「数据分析依赖」只读页

- 新增 `ui/server/routes/adminSkills.js`：`GET /api/admin/skills/data-analysis/deps`
  （挂在 `requireAdminChain` 下），返回依赖清单（包名/约束/档位）、venv 里实际装到的版本、
  运行时状态（`ready` / `missing_dependencies` / `not_bootstrapped`）、bootstrap 时间
- 判定口径与 `analysis.sh check` 对齐：以 `.pilotdeck-requirements-hash` 与 requirements 的
  sha256 是否相等为准；**不 spawn python**（管理页不该有执行面），版本直接读 `*.dist-info` 目录名
- 测试：`ui/server/routes/adminSkills.test.js`（9 条，vitest）+
  `ui/server/adminGating.test.js` 增加一行（非管理员 403）
- 命令：`cd ui && npx vitest run server/routes/adminSkills.test.js server/adminGating.test.js` → 53 passed
- 未做：前端页面（与 A3 管理员总览一起排）

### 2026-11-11 · B1 审计接线 + 两个"真跑不起来"的坑

写集成测试时撞到两个只有真调用才暴露的问题，都已修：

1. **自动化策略把 `analysis.sh` 整条命令硬拦了**。`src/tool/automationPolicyConstraints.ts`
   的 `BUNDLED_DOCUMENT_ENTRYPOINT` 只认 `pdf|docx|pptx|spreadsheet|diagram`，`bash …/analysis.sh`
   于是命中"non-bundled shell execution"，而 `--script scratch/…py` 又命中
   "executable source in command" —— 也就是说 B0 放行了、这一层却根本不让执行。
   新增 `BUNDLED_ANALYSIS_ENTRYPOINT`：把 `bash <…>/analysis.sh <参数…>` 整条视作受信任入口
   （只吃到 `;&|` 为止），参数仍由命令策略白名单与执行器二次校验。
2. **`check` 用退出码表达"没就绪"**，于是 bash 工具把整条命令判成失败、把 JSON 吞了，
   agent 看不到 status。改成 `check` 永远退出 0（状态是数据不是错误），
   `bootstrap-runtime` 自己在末尾判 `runtime_ready`。

审计接线：`src/security/audit/analysisOutcome.ts` 解析执行器最后一行 JSON，在 bash 工具抛错
**之前**落审计：

| 执行器结果 | 审计 action |
|---|---|
| `rejected`（静态，退出 3） | `analysis.rejected`，reason = `static:<规则>` |
| `blocked`（运行期，退出 8） | `analysis.blocked`，reason = `runtime:<事件>` |
| 超时（退出 5 / bash 层超时） | `analysis.timeout` |
| `oom`（退出 6） | `analysis.oom` |
| `ok` / 普通 `failed` | 不写（否则日常噪声淹没拒绝） |

端到端实测（真 bash 工具 + 真执行器 + 临时工作区）：
`check --json` → success；正常分析 → success 且 `run.json.status=ok`；
`import subprocess` → 退出 3、审计落到 `analysis.rejected`。

新增/补充测试：`tests/tool/analysis-audit.spec.ts`（9 条）、
`tests/skills/data-analysis-runner.spec.ts`（+2 条：check 的退出码、`PILOTDECK_ANALYSIS_PYTHON`
必须是可执行路径）、`tests/tool/automation-policy-constraints.spec.ts`（+data-analysis 用例，
并把 data-analysis 加进"所有文档技能入口示例都过自动化策略"那条）。

命令：`npx tsc --noEmit` ✅ ｜ `npm test` → **844 tests / 842 pass / 0 fail / 2 skipped**
