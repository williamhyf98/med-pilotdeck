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
| 门 1 | 删除能进 `.trash`、可恢复 | A 轨前端删除按钮 | ✅ **已通过（2026-11-11，A1+A2）**；恢复按钮按设计留到第二批（先用 `POST /api/storage/trash/restore`） |
| 门 2 | 前端工作区页 + 管理员总览可交付 | 只有 A 轨 | ✅ **已通过（2026-11-11，A3 收尾；判定见 §2.3 末尾）** |
| 门 3 | 数据分析技能可交付（含安全用例全绿） | 只有 B 轨 | 🟡 代码侧已全绿（S1–S12 + C1–C12 + R1–R3）；差 arm64 容器实测 + C6/C11 在依赖齐全机器复跑 |

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

- [x] `ui/server/routes/storage.js` 的 `deleteTarget()`：`kind:'file'` 由 `fs.rm` 改
      `rename` → `<groupRoot>/.trash/<相对路径>.<时间戳>`
- [x] 保留项拦截：`.trash` / `.usage.json` / `.pinned` / `.tmp` 及其子路径 → 400
- [x] `rename` 失败（磁盘满等）→ 可读错误 + 审计；**不得退化为 `rm`**
- [x] `POST /api/trash/restore`（原路径被占用则提示改名）
- [x] 每日过期清理任务（7 天，物理删除，写审计）
- [x] 测试：删 inbox 文件后原件消失、`.trash` 出现；恢复成功；保留项 400

实测结论（2026-11-11）：新增 `ui/server/services/trash.js`（rename 进 `.trash`、`parseTrashedRelative`
还原路径、`restoreFromTrash`、`purgeExpiredTrash`）与 `trashRetention.js`（启动跑一次 + 每 24h）；
`GET /api/storage/trash`、`POST /api/storage/trash/restore` 已接。`kind:'file'` 走软删除，
`kind:'workspace'` / `kind:'archive'` 仍为 `fs.rm`（本轮范围外，见 §16 风险）。
命令：`cd ui && npx vitest run server/routes/storage.trash.test.js server/routes/storage.test.js` → 11 passed；
`cd ui && npm test` → 170 files / 1240 passed；根目录 `npm test` → **864 tests / 862 pass / 0 fail / 2 skipped**。

**验收**：设计书 §14 第 4 条「进 `.trash`，提示"已移入回收站"，不得真删」。

### 2.2 A2 删除按钮 + 用量汇总（0.8d）

**前置**：A1。

- [x] 前端删除只针对 `kind:'file'`；文案统一为"移入回收站（7 天后自动释放）"，**不出现"永久删除"**
      （2026-11-11 调整：归档 tab 的**组勾选**代表整包 `kind:'archive'`，同样是软删除、7 天释放）
- [x] 批量删除一次汇总确认（列文件数 + 总大小）
- [x] `scanStorage()` 返回体加 `usage: { inboxBytes, exportsBytes, scratchBytes, totalBytes }`
      （从已有 `files[].path` 前缀聚合，不新增扫描）
- [x] 测试：三组之和 = `workspaceBytes`；删文件后总量下降

实测结论（2026-11-11）：只改 `StorageV2.tsx` 的**既有**删除入口（未新增入口，A3 面板另起）：
分组整包删除按钮移除、全选只选文件、文案改为"移入回收站"、确认框列"共 N 个文件，合计 X"、
成功提示"已移入回收站，7 天内可恢复"；总量区新增第 4 格"回收站（7 天后释放）"。
后端 `scanWorkspaceGroups()` 加 `usage`，按 `files[].path` 顶层目录聚合，自定义目录不计入三项，
故 `inbox+exports+scratch <= totalBytes`（只含三个默认目录时相等）。
顺带补了一个 A1 遗留的记账缺口：归档里的文件同样走软删除，`scanArchiveGroups()` 现在也读 `.trash`，
`totals.trashBytes` 把工作区与归档两边相加，否则删归档文件时 `totalBytes` 会凭空变小。
命令：`cd ui && npx vitest run server/routes/storage.trash.test.js server/routes/storage.test.js
src/components/main-content-v2/StorageV2.test.tsx` → 17 passed；`cd ui && npm test` → 170 files / 1243 passed
（并行跑时 `memory.test.js` 有一条既存偶发 403 抖动，单跑 3/3 稳定，与本轮改动无关）；
`cd ui && npx tsc --noEmit` ✅；`npx eslint src/components/main-content-v2/StorageV2.tsx` ✅；
根目录 `npm test` → **864 / 862 pass / 0 fail / 2 skipped**。

**门 1 通过条件**：删除 → `.trash` → 能恢复，且保留项拦得住。

### 2.3 A3 前端工作区页 + 管理员总览（3d）

**前置**：A2 的 `usage` 字段。

- [x] 工作区页：目录树懒加载（名称/大小/mtime）、预览（pdf/docx/xlsx/图片/文本）
- [x] **三条用量条**：工作区总量 / `scratch` / `inbox`（纯提示，超阈值变黄）
- [x] 能力卡片三行文案（可读＝整个工作区；可写＝除 `inbox` 与保留项；技能文档只读）
- [x] 管理员总览（设计书 §9.2.1）：合计、排序、占比、**其中 inbox 列**、阈值着色、手动刷新、归档标灰
- [x] 普通用户访问 `/api/admin/users` → 403（补测试锁定）
- [x] 旧 `StorageV2.tsx` 保持不动（不在它上面加删除入口）

实测结论（2026-11-11，工作区面板部分）：
- 面板本体改造的是 `FilesV2.tsx`（原「项目文件」面板）：标题改「工作区」，`MainContent` 侧栏
  `aria-label` 同步改「工作区」。目录树改成按层请求，不再一次拉整棵树
- 新接口：`GET /api/projects/:name/workspace/usage`（三条用量条 + 阈值占位）、
  `GET /api/projects/:name/files/list?path=`（单层目录，名称/大小/mtime，隐藏 `.trash` 等保留项与软链，
  单目录最多 500 项并回 `truncated`）
- 预览复用已有链路：图片/PDF 走 `/files/content`，Office（docx/xlsx/pptx/csv）走
  `/files/preview/pdf`，文本走 `/file`；预览弹窗可"在编辑器中打开"保留原有编辑路径
- 三条用量条：工作区总量 / scratch 用「数值 / 提示阈值」，≥80% 变黄；inbox 条显示数值 + 占工作区百分比
- `/api/admin/users` 的 403 由 `ui/server/adminGating.test.js` 锁定（未改）
- 命令：`cd ui && npx vitest run src/components/main-content-v2/FilesV2.test.tsx` → 3 passed；
  `cd ui && npm test` → 170 files / 1248 passed；`npx tsc --noEmit` ✅；`eslint FilesV2.tsx` ✅

实测结论（2026-11-11，管理员总览部分）：
- 后端 `storageUsage.js` 一次遍历同时产出 `{ bytes, inboxBytes }`：`inbox` 只认
  `workspaces/<id>/inbox` 与 `workspaces/<typeKey>/<id>/inbox` 两处（其余同名目录、文件都不算），
  因此 `inboxBytes <= bytes` 恒成立；`getUserStorageBytes()` 仍返回数字，旧调用与旧测试不受影响
- 新增 `listArchivedUserBytes()`：扫 `<root>/archives/users/<id>-<stamp>`，按 `<id>-` 前缀归属
  （`1-` 不会吞掉 `12-`），被删账号的目录仍计入合计，行上标「已归档」灰标 +「（含归档 X）」
- 新增 `getUserTotalWarningBytes()`：读 `workspace.quota.userTotalMaxBytes`，缺配置回落 20 GiB（§9.2 默认）
- `GET /api/admin/users` 增加 `inboxBytes` / `archivedBytes` 与顶层 `storage: { totalBytes,
  totalInboxBytes, archivedBytes, userTotalWarningBytes }`；`?refresh=1` 先 `invalidateStorageCache()` 再重算
- 前端「用户」页：页头合计 + 用户数 + 其中 inbox + 单用户告警值；「刷新」按钮走 `?refresh=1`；
  「存储用量」列表头可点击切换升/降序（默认降序）；新增「占比」「其中 inbox（占本用户 %）」两列；
  超告警值的存储单元格标琥珀色并带 title；列数 7 → 9，确认行 `colSpan` 同步
- `formatBytes` 补 GB/TB（原来到 MB 就截断，20 GB 会显示成 20480 MB）
- 命令：`cd ui && npx vitest run server/services/storageUsage.test.js server/routes/adminUsers.test.js
  src/components/settings/view/users/UsersSettings.test.tsx src/utils/formatBytes.test.ts` → 39 passed；
  `cd ui && npm test` → **170 files / 1258 passed**；`npx tsc --noEmit` ✅；
  `eslint users/index.tsx users/useUsersAdmin.ts utils/formatBytes.ts` ✅

**门 2 通过条件**：设计书 §14 第 18、19、21、22 条。

判定：18（工作区页三用量条 + 预览）✅、19（管理员总览合计/排序/占比/inbox 列/告警着色/刷新/归档标灰）✅、
21（普通用户 `/api/admin/users` → 403）✅、22（删除先进回收站、可恢复）✅ → **门 2 达成**

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
      - 2026-11-12 追记：`inputRoots` 放宽为 `[inbox,scratch,exports]`（链式分析直接吃上一轮产物），
        写入范围不变；见 `data-analysis-skill-design.zh.md` §3 U2 补充
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
| D3 | 离线运行时（venv + wheels + Dockerfile 两处） | 0.5d | D2 | 🟡 代码已接；**macOS 本机 bootstrap 实测已通过（status: ready）**；C6/C11 已于 2026-11-12 在本机跑通（共享运行时含 lifelines/wfdb）；仅剩 arm64 容器实测 |
| D4 | 唯一入口 `analysis.sh run` | 1d | D3 | ✅ |
| D5 | 执行期安全（AST 黑名单 + 运行期护栏 + 资源上限） | 1d | D4 | ✅ |
| D6 | 产物落位 `exports/analysis/<slug>-<ts>/` | 0.3d | D4 | ✅（目录规则已被 D9 取代） |
| D7 | 管理员「数据分析依赖」页 | 1d | D3 | ✅ 设置页「扩展 / 技能依赖」+ 只读接口 |
| D8 | 正确性 + 安全测试 | 1d | D5、D6 | ✅ S1–S12 + C1–C12 + R1–R3 全接上；C6/C11 因本机缺 lifelines/wfdb 显式 skip |
| D9 | 产物改为「一轮一目录」：`exports/<YYYYMMDD-HHMMSS>-<中文主题>/`，失败就地重试、`report.md` 骨架 | 1d | D8 | ✅ 执行器 + `SKILL.md` + 4 条新用例；旧 `exports/analysis/` 已移入回收站 |

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
| [x] 回收站页面（列表 / 恢复 / 清空） | 已完成 2026-11-12；"清空"是唯一不可恢复入口，二次确认 + 审计 `trash.purge` |
| [x] 前端写操作：新建目录 | 已完成 2026-11-12（多级、父目录须已存在、隐藏名/保留项/软链拒绝） |
| [x] 前端写操作：就地编辑 | 已完成 2026-11-12；文本预览弹窗「编辑→保存/取消」，保存走 `PUT /file` 并共用同一套路径规则 |
| [x] `scratch` 自动清理 | 已完成 2026-11-12；启动一次 + 每 6 小时，只清 scratch，`.pinned`/保护窗免删 |
| [x] `scratch` 分档清理（D10） | 已完成 2026-11-12；回合结束删本轮 `work/<session>/<turn>/` 与 `tool-results/<turn>-*`，其余 TTL 30→7 天；开关 `workspace.quota.cleanOnTurnEnd` |
| [x] `kind:'workspace'` 硬删除收口 | 已完成 2026-11-12；改为逐顶层条目软删 + 重建默认目录 |
| [x] `kind:'archive'` 硬删除收口 | 2026-11-11 已改 `moveGroupToTrash`（整组进 `.trash/groups`） |
| 可见性白名单 | **评估后暂缓**（2026-11-12）：UI 层已无脚本入口，真正缺口是"agent 能念脚本"；要 100% 成立必须做"执行/读取分离"（宿主执行器），成本 4–6d，详见 §6 同日日志 |
| 沙箱可写范围收窄 | **S1–S4 已完成（2026-11-12）**：接线 + 开关（默认 `false`）+ W6 反向断言 + 自动化用例，macOS 实测 E1–E7 全绿。剩 **S2：Linux bwrap 真机回归**（需先 push）。见 [sandbox-write-scope-narrowing.md](./sandbox-write-scope-narrowing.md) |

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
- 未做：D8 的 C2–C11 与 R2/R3

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

### 2026-11-11 · D7 前端页（设置 → 扩展 → 技能依赖）

- 新增 `ui/src/components/settings/view/skills/index.tsx`：状态徽章（就绪/依赖缺失/未初始化）、
  已装/总数、最近初始化时间、运行时目录，以及依赖表（包名 / 版本要求 / 档位 / 实际版本）；
  只读，不给安装按钮
- 接线：`SettingsMenuKey` 加 `skills`、侧栏挂在「扩展」下、`SettingsContent` 分发、
  zh-CN/en 文案补齐
- 测试：`SkillsDeps.test.tsx`（3 条：渲染、接口失败提示、刷新重取）＋ 侧栏顺序断言同步
- 命令：`cd ui && npx tsc --noEmit` ✅ ｜ `npx vitest run` → **169 files / 1230 passed** ｜
  `npx vite build` ✅

### 2026-11-11 · D8 正确性 + 资源用例（C2–C11、R2/R3）

- 新增 `tests/skills/data-analysis-correctness.spec.ts`（13 条）：**真执行器 + 真产物**，参考值不取自被测代码 ——
  手算闭式解（C5 斜率/截距 = 2/3）、独立公式重算（C4 用均值和标准误重算 t，p 对一次性黄金值）、
  同数据集上 scipy/statsmodels 的一次性值（C2/C3）、写进去的值再读回来（C10 PixelSpacing）
- 覆盖：C2 分组均值 / C3 缺失值丢弃数 / C4 t 检验 / C5 OLS / C6 KM / C7 图像 ≥800px 且带标题轴标签 /
  C8 UTF-8 BOM / C9 100 MB 分块读 / C10 DICOM 3 序列×2 层 / C11 wfdb / R2 超内存 / R2b 资源上限下发 / R3 大文件写 scratch
- 实测（本机）：**10 通过 / 3 skip**；补 pydicom 后（`PILOTDECK_ANALYSIS_PYTHON=/tmp/pdvenv/bin/python`）
  → **11 通过 / 2 skip**。C6 缺 lifelines、C11 缺 wfdb 显式 skip 并写明原因（本机 PyPI 被 SSL 中间证书挡住，
  `pip install` 装不上；装得到依赖的机器上会自动从 skip 变成真跑，不假装通过）
- 测试驱动修掉三个真问题（都是"正常脚本被误判成攻击"这类，比少一层防护更糟）：
  ① numpy.testing 在 import 期跑 `lscpu` 探 ARM SVE（statsmodels 带进来）→ 若无条件拒，正常 OLS 直接 `blocked`；
     护栏白名单补 `lscpu` / `nproc` / `sysctl`（`sysctl` 禁 `-w` / `-p` / `=` 写入参数）
  ② urllib3 在 import 期 `socket(AF_INET6)` + `bind('::1')` 探 IPv6（pydicom 的依赖）→ 原 `socket.*` 一刀切
     会让所有 requests 系库变 `blocked`；改成只拦真正出网的 8 个事件，`bind` 只许回环（不含 `0.0.0.0`）
     → 顺带补上"对外监听"拒绝用例（`data-analysis-runner.spec.ts` 现有 8 条）
  ③ `MemoryError` 原先被算成 `failed`，审计拿不到 `analysis.oom` → 执行器 status 判定改成
     `timeout > blocked > oom > (ok|failed)` 的显式分支
- 命令：`npx tsc --noEmit` ✅ ｜ `npm test` → **857 tests / 852 pass / 0 fail / 5 skipped**
  （5 = 原有 2 条 + D8 的 C6/C10/C11；C10 装 pydicom 后可跑通）
- 遗留（不阻塞门 3 结论）：C6/C11 未在本机真跑，需在 node12 / 交付镜像（依赖齐全）上跑一次留档
- **追记（2026-11-12）：上面这条已作废。** 11-11 14:58 与 15:38 两次 `analysis.sh bootstrap-runtime`
  把 `lifelines 0.30.3` + `wfdb 4.3.1` 装进了两个 venv（`~/.cache/pilotdeck-analysis`、
  `.runtime/cache/xdg/pilotdeck-analysis`）。测试的 `pickPython()` 会按候选顺序挑一个**能 import 目标模块**的
  解释器，因此 C6/C11 早就自动从 skip 变成真跑了，不需要改测试。
  实测：`node --test dist/tests/skills/data-analysis-correctness.spec.js` → **13 pass / 0 skip**。
  （`npm test` 里仍显示的 2 条 skip 是平台条件跳过：`sandbox-exec 不存在`、`bwrap 未安装`，与依赖无关。）
  教训：这条备注写在 `pip` 被 SSL 挡住的那次，后来装好了却没回头改——文档里的"未做"要带观察命令。

### 2026-11-11 · macOS 本机把运行时真装起来（D3 开发机侧 + D8 补全）

- 目标：不只是"测试绿"，而是让开发机 `analysis.sh check --json` 真的 `status: ready`，用户能手动试
- 命令：`PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple PIP_TRUSTED_HOST=pypi.tuna.tsinghua.edu.cn bash skills/data-analysis/scripts/analysis.sh bootstrap-runtime`
  （默认 pypi.org 被公司 SSL 中间证书挡住；tuna 镜像可达）→ **`status: ready`**，17 包全装齐
- 过程中查出来的**不是网络问题**，是 requirements 的两处真缺陷：
  ① `numpy>=1.24` 缺上界 → 解析到 2.5.x，pip 在 statsmodels / lifelines / wfdb 间回溯几十轮
     （实测下载 58 个候选仍未收敛，还把 numpy 升到 2.5.4 顶掉 lifelines）→ 改成 `numpy>=1.24,<2.4`
  ② `lifelines 0.29.0` 元数据是 `numpy<2.0`，而 Python 3.13 上 numpy 最低 2.0 —— **该组合无解**
     → 改成 `lifelines>=0.30,<0.31`（0.30.x 才放开 numpy 2；离线镜像是 Python 3.12，两边同版本）
- 修一条测试 fixture 的真错：C11 的 `wfdb.wrsamp(p_signal=int16)` 在 wfdb 4.3 被
  `check_np_array` 拒（要 float64 且二维），改成 float64 + `adc_gain`/`baseline`
- `data-analysis-correctness.spec.ts` 的解释器候选加上 `~/.cache/pilotdeck-analysis/runtime/bin/python`：
  本机 bootstrap 过就不再依赖 `PILOTDECK_ANALYSIS_PYTHON`，C6/C11 自动从 skip 变真跑
- 结果：**C2–C11 + R2/R2b/R3 共 13 条全绿、0 skip**；`npm test` → **857 tests / 855 pass / 0 fail / 2 skipped**
  （剩下的 2 条是门 0 阶段就有的无关 skip）
- 端到端手工样例（临时工作区，中文列名 + 中文图题）：120 行 CSV → `by-group.csv` / `ttest.csv`
  （t=-4.2461，p=4.4e-05，与手算一致）/ `sbp-by-group.png`（960×640，中文零方框）/ `run.json`（含输入 sha256）
- 仍未验证：arm64 **容器**里的 bootstrap（本机无 docker）；node12 上的同一步

### 2026-11-11 · 真实会话暴露的三处问题：附件路径 / 拦截文案 / 共享运行时

起因：管理员在「数据分析」项目上传 15 张 CSV 让 agent 做分析，`check` 返回
`not_bootstrapped`（不是数据问题），agent 只好用 awk/grep 手搓，产出一份全 0 假阴性
（它自己识破并作废，最终 `exports/` 为空）。逐项定位后修三处：

**P3（真 bug）附件路径按 `projectKey` 拼，图片/PDF 内容进不了模型**
- 证据：每条消息都带 `Attachment not found: <app>/ui/general_med-…/inbox/…csv`，而文件就在
  `<PILOT_HOME>/users/1/workspaces/general_med/general_med-…/inbox/` 下
- 根因：`ui/server/pilotdeck-bridge.js` 把 `projectKey` 当"项目根"传给
  `uiFilesToAttachments` / `uiImagesToAttachments` → `path.resolve(projectKey, 'inbox/x.csv')`
  解析成 `<server cwd>/<projectKey>/inbox/x.csv`（路径合法但不存在）
- 修法：新增 `buildTurnAttachments()`，统一用 `resolveAgentCwd(projectKey)` 得到真实项目目录；
  trauma 附件复用同一个根
- 测试：`ui/server/pilotdeck-bridge.test.js` +2（相对路径必须落在项目目录内、越界路径被丢弃）

**P2（体验）拦截文案里没有 analysis.sh，agent 白试两轮**
- `src/tool/automationPolicyConstraints.ts` 的提示只列 pdf/docx/pptx/spreadsheet/diagram；
  `errorRecovery.ts` 的 avoid-retry 理由还写着"永久禁止解释器执行"，等于告诉 agent 这条路彻底不通
- 修法：两处文案都补上 `skills/data-analysis/scripts/analysis.sh`，并说明"写脚本到 scratch/，
  走 analysis.sh 而不是自己调解释器"

**P1（架构）运行时改为一台机器一份只读，不再按用户复制**
- 之前：`bootstrap` 落在 `${XDG_CACHE_HOME}/pilotdeck-analysis`，而沙箱把 `XDG_CACHE_HOME`
  改成 `<PILOT_HOME>/users/<id>/.cache` → 每用户一条 venv（589 MB × N），且 packager 装好的那份没人看得到
- 现在：`analysis.sh` 三级解析（`PILOTDECK_ANALYSIS_CACHE` → `<app>/.runtime/cache/xdg/pilotdeck-analysis`
  → 每用户缓存）；`skillCacheEnv()` 注入 `PILOTDECK_ANALYSIS_CACHE`，`appReadOnlyGrants()` 把它加进
  只读挂载；字体缓存 `MPLCONFIGDIR` 单独放每用户目录（共享目录只读，写不进去）
- 管理员页 `analysisCacheRoot()` 同步同一顺序（否则会出现"管理页 ready、agent 报未就绪"）
- 实测（macOS）：共享运行时 `chmod -R a-w` 后跑绘图 → `status: ok`、PNG 正常、
  `XDG_CACHE_HOME/pilotdeck-analysis-mpl` 被创建、共享目录未被写
- 测试：`adminSkills.test.js` +1（存在共享运行时时优先）

命令：`npx tsc --noEmit` ✅ ｜ `npm test` → **857 tests / 855 pass / 0 fail / 2 skipped** ｜
`cd ui && npx vitest run` → **169 files / 1233 passed**

### 2026-11-11 · 会话里"静默全 0"的真根因：沙箱里 chdir 全线失败

- 现象：agent 写 `cd "$D"` 后用相对路径 `tail S1_*.csv`，54 条 `No such file or directory`，
  所有计数变成 0；`exit_code` 仍是 0，看着像"数据很干净"
- 现场证据：`<PILOT_HOME>/users/1/workspaces/scratch/qc` 这个**多出来两级**的目录，
  说明 `cd` 没生效、cwd 一直是工作区根（`../../scratch` 从工作区往上跳了两层）
- 真正的原因（已复现）：`buildSandboxProfile()` 的 `(allow file-read-metadata ...)` 只算了
  app 授权项的祖先链，**没算 userHome 的祖先**。macOS 的 `chdir` 要逐级解析路径，
  任一层拿不到 metadata 就返回 **ENOTDIR**；而 `ls` / `test -d` 走叶子节点的 `file*` 授权，照常成功
  → "ls 能看见、cd 说不是目录"
- 影响面：所有技能/脚本里的 `cd` 与 Python `os.chdir`（`analysis.sh` 也在沙箱里跑），
  不只是这一次会话；相对路径一旦写错，错误只落在 stderr，很容易被当成正常结果
- 修法：`metadataAncestors()` 收进 userHome 并展开整条祖先链；`grants().metadataOnly` 同步
  （启动守卫会校验两者一致）
- 验证：真实工作区里 `sandbox-exec -f <新 profile>` → `cd inbox/<batch>` 成功、`tail` 得到 4 行；
  `python -c "os.chdir(...)"` 同样成功
- 测试：`sandboxExec.spec.ts` +2（祖先链必须出现在 metadata 行；macOS 上真跑 `cd` 进子目录）
- 附带：`SKILL.md` 明确"禁止 cd / 只看 status / 全 0 先怀疑路径"，
  并用 analysis.sh 复跑同类错误写法 → `status: failed`、退出 4、`stderrTail` 带 `FileNotFoundError`

命令：`npx tsc --noEmit` ✅ ｜ `node --test dist/tests/tool/builtin/bash/sandbox/sandboxExec.spec.js` → 18/18

### 2026-11-11 · 重启后 503：祖先链 metadata 被启动守卫判成"覆盖受保护数据"

- 现象：重启机器后 UI 全部报 `Server error (503): Service Unavailable`，
  `code: GATEWAY_UNAVAILABLE`；日志首行是
  `Unsafe sandbox metadata grant <dataRoot>/users overlaps protected data.` →
  `[gateway-pool] stopped gateway for user 1 (start-failed)`
- 根因：上一条修 chdir 时把 userHome 的**祖先链**（含 `…/users`、`…/<dataRoot>`）放进了
  `metadataOnly`，但启动守卫只认"**在 userHome 之内**"的授权
  （`covered(form, root)`），祖先属于反向包含，于是被误判为越权并直接抛错
- 为什么不能简单退回：`chdir()` 要逐级解析，删掉祖先链就回到"ls 正常、cd 报 Not a directory"
- 修法：守卫把 userHome 的**祖先或自身**都视为合法（`covered(form, root) || covered(root, form)`）。
  安全性不变：`metadataOnly` 是 `(literal …)`，只允许 stat 该路径本身，不给目录内容；
  `users/2`（兄弟 home）、其下任意子路径、`system/*` 仍然全部拒绝
- 测试：`commandRunner.spec.ts` 的守卫用例扩成"整条祖先链都放行 + 兄弟 home/子路径必须拒绝"
- 运维注意：**gateway 子进程跑的是 `dist/src/cli/pilotdeck.js`**，只改 `src` 不 `npm run build`
  的话 503 依旧（服务端 tsx 跑源码，网关跑编译产物，两边不同步）

命令：`npx tsc --noEmit` ✅ ｜ `npm test` → **859 tests / 857 pass / 0 fail / 2 skipped** ｜
重启后 `GET /api/projects` → `200`，日志 `[gateway-pool] gateway ready for user 1`

### 2026-11-11 · data-analysis 用不了：策略禁止写 .py，而技能唯一入口就要 .py

- 现象：runtime `ready` 之后 agent 仍然做不了分析。`write_file scratch/work/p0/analysis.py` →
  `automation_policy_violation: blocks writing executable source`；
  改走 `bash` 用 `printf > …/probe.py` 也 → `blocks creating or moving executable source through the shell`
- 根因：`src/tool/automationPolicyConstraints.ts` 把 `.py` 一律算作"可执行源码"，
  **不分位置**地拒绝写入；而 `analysis.sh run --script` 只接受 `scratch/**.py`，
  即技能文档要求的输入就是 `.py`。两条规则直接互斥 → 技能在部署里等于不可用
- 为什么这不算放宽安全边界：
  1. 写文件本身不执行；执行只有 `analysis.sh run` 一条路，且它先跑
     `analysis_guard.scan_source()` 扫 `subprocess`/`socket`/`os.system` 等，再在自己的沙箱里跑
  2. 只放行 `.py`（`.sh`/`.js`/`.mjs` 这些能绕开 guard 的形式仍然拒绝）
  3. 路径必须含 `scratch` 段且不含任何 `..`，防止借 scratch 写到别处
- 修法：新增 `isAnalysisScratchScriptPath()`，`write_file`/`edit_file` 命中该规则即放行；
  被拒时的提示语补上"例外：scratch/**.py 交给 analysis.sh"
- 测试：`automation-policy-constraints.spec.ts` +1（正例 3 条、反例 5 条）

命令：`npx tsc --noEmit` ✅ ｜ `npm test` → **860 tests / 858 pass / 0 fail / 2 skipped** ｜
两个 dev 实例（3001/3020）的网关子进程重启后 `GET /api/projects` 均 `200`

### 2026-11-11 · 技能 references 读不到：read_file 只认工作区

- 现象：agent 按 `SKILL.md` 的指引读 `docx/references/specifications.md`，
  两次 `ENOENT`（被解析成 `<workspace>/skills/docx/...`），白费两轮后改用 `bash sed` 才读到
- 根因：`read_skill` 返回的是**技能根相对路径**（`docx/SKILL.md`），而 `read_file`
  只解析"工作区相对/绝对且在工作区内"，技能目录在仓库根，两者对不上
- 修法（`filesystem/pathSafety.ts`，只作用于读）：
  1. 命中 `<appRoot>/skills/**` 或 `<appRoot>/plugins/**` 的读取直接放行，
     `root` 记为共享技能根，**不再走"是否在工作区"的弹窗判定**
  2. 相对路径若在工作区里不存在，再按"技能根相对"解析一次
     （`docx/references/x.md` → `<appRoot>/skills/docx/references/x.md`，
     插件技能按 `<appRoot>/plugins/*/skills/<name>` 找），工作区同名路径优先
  3. 仍拒绝：`..` 跳出、技能树写入、realpath 逃逸
- 测试：`path-safety-multiuser.spec.ts` +2（三种模式放行 + 五条拒绝）

命令：`npx tsc --noEmit` ✅ ｜ `npm test` → **862 tests / 860 pass / 0 fail / 2 skipped** ｜
dist 实测：`docx/references/specifications.md` → OK；`docx/../src/cli/pilotdeck.ts` → DENY

### 2026-11-11 · 报告表格长字段名断词 + 分析产物目录混放

- 现象 1：报告第 3 页「数据集清点」第一列把 `S1_REPORT_PERFORM_RELATIONS` 断成
  `…RELAT` / `IONS`——不是拼写错误，是列宽 2.3in 放不下 26 字符的英文长词，
  LibreOffice 从单词中间硬断
- 现象 2：agent 三次运行都用了不带时间戳的 `s1-profile/s1-detail/s1-more`，
  重跑会覆盖 `code.py` / `run.json`，而 `tables/` 不清空 → 新旧结果混放
- 修法：
  1. `docxlib/core.py` 的自动列宽上限从 4.0 提到 6.0、分母 12→10，
     长字段名能拿到更宽的列；`specifications.md` + `SKILL.md` 明确
     "表格默认不写 `column_widths`，省略即自动分配"
  2. `run_analysis.py` 拒绝复用已有成功结果的 `--out`（提示改用
     `exports/analysis/<主题>-<YYYYMMDD-HHMMSS>`），失败运行仍可就地重试；
     `SKILL.md` 与设计文档同步该约定
- 验证：把报告 spec 的 `column_widths` 全部去掉后用远端 Renderer 重渲染，
  第 3 页表名完整单行显示，中文含义列自然换行
- 测试：`data-analysis-runner.spec.ts` +2（复用被拒 / 失败可重试）

命令：`npm test` → **864 tests / 862 pass / 0 fail / 2 skipped**

### 2026-11-11 · docx 内置模板：模板锁死，块级配色放开（受内置调色板约束）

- 需求：builtin 模式原来一刀切"不许上色"，结果想给标注加个风险色条、给表头加深底
  都被拒。改为**模板原生设置不动、生成后文件里的块级配色可改**。
- 边界（别再扩）：

  | 项 | builtin 模式 | 说明 |
  | --- | --- | --- |
  | `style_overrides`（字体/字号/行距/页边距/标题色等） | ❌ 拒绝 | 模板原生设置 |
  | 表格 `style` | ❌ 拒绝 | 网格/边框样式属于模板 |
  | `callout.accent` / `callout.fill` | ✅ 仅调色板 | 原来两者都拒 |
  | 表格 `header_fill` / `header_text_color` / `border_color` | ✅ 仅调色板 | 原来三者都拒 |
  | run 的 `color` / `size_pt` | ❌ 拒绝 | 本轮未动 |

- 调色板（`protocol.py:BUILTIN_PALETTE`，名字或等价 hex 均可，大小写不敏感、`#` 可省）：
  `ink 000000` / `muted 595959` / `rule D9D9D9` / `soft F2F2F2` / `white FFFFFF` /
  `primary 1F4E79` / `accent 8C6D1F` / `success 2E7D32` / `warning B26B00` /
  `danger B3261E` / `info 1565C0`；越界颜色报 `builtin-style-override`
- 修法：`protocol.py` 新增 `palette_color()` / `_require_builtin_color()`，`callout` 与
  `table` 两处校验分支改为按模式选择"调色板 / 任意 hex"（含后段 `_require_hex_color` 段，
  否则名字型颜色会在第二道校验里被拒）；`core.py` 新增 `resolve_color()` 统一把名字落成 hex；
  `CREATE_BLOCK_PROPERTY_SCHEMAS` 的 `pattern` 放宽为 `COLOR_TOKEN_PATTERN` 并在 `description`
  里列调色板，`PROTOCOL_VERSION` 8→9
- 审计提示语微调：`excessive-chromatic-table-fill` 现在会说明"调色板表头底色是正常的"
- 文档：`references/specifications.md` 新增「1.1 内置调色板」，改 builtin 段、callout 示例
  （`595959`→`muted`）与表格规则；`references/design-and-layout.md`、`SKILL.md` 同步
- 验证：`self-test` ✅（新增 `builtin-palette-colors` / `builtin-off-palette-blocked`）；
  四条反例仍被拒（`style_overrides` / 表格 `style` / run `color` / `FF00FF`）；
  XML 落盘 `1F4E79`×2、`B3261E`、`F2F2F2`、`D9D9D9`×6；远端 Renderer 目视：深蓝表头白字、
  浅灰底 + 红色色条提示框，均正常
- 命令：`npm test` → **864 tests / 862 pass / 0 fail / 2 skipped**

### 2026-11-11 · docx：配色门禁对齐调色板 + 角色色按主题解析 + 四个排版开关

- 背景：上一轮放开了块级配色，但 `preflight` 仍按"零彩色"判 error（`create` 过、`deliver` 拦）；
  且同名的 `primary` 在主题下取的是中性深蓝，和主题色打架。
- 修法一（门禁）：`preflight._builtin_style_gate_issues()` 改判"调色板外"计数，
  `audit_docx()` 新增 `palette=` 与四个 `off_palette_*` 指标
  （表单元格/文字/段落底/表格边框）；`preflight` 用 `palette_for_policy(acceptance.style_policy)`
  传入当前模板调色板
- 修法二（角色色）：`protocol.palette_for_policy()` 按模板返回调色板——neutral 用中性值，
  `themed-v1` 用 `design_theme` 的颜色词（`design_theme` 现在回传 `colors`）；
  `templates` 把它塞进 `style["palette"]`，`core.resolve_color()` 据此解析；
  四个语义色（success/warning/danger/info）改为与 `_shared/design-tokens.json` 的
  `semantic.fg` 一致，保证 Word/PPT/PDF/Excel 同色
- 修法三（排版开关，纯样式不碰骨架）：
  `table.variant: grid|three-line`（三线表，顶/底 1.5pt + 表头下线，无竖线）、
  `table.zebra`（数据行隔行 `soft`，与三线表互斥）、
  `table.cell_valign: center|top`、
  `title`/`subtitle`/`image` 的 `alignment`、
  `bullet`/`numbered` 的 `level: 1|2`
- `PROTOCOL_VERSION` 9→10（新增块字段）
- 验证：
  - neutral + `header_fill: primary`：`preflight` 不再报 `builtin-style-chromatic-table-fill`（只剩 `render-unavailable`）
  - clinical + `primary`：XML 落 `12404F`（不是 `1F4E79`），`off_palette_*` 全 0
  - clinical + `header_fill: 1F4E79`（中性色不在主题里）：被拒
  - 远端 Renderer 目视：三线表无竖线、斑马纹隔行、二级列表缩进、标题左对齐、主题青绿表头正常
- 测试：`self-test` 新增 `themed-palette-resolves` / `preflight-palette-gate` / `themed-off-palette-blocked`；
  `npm test` → **864 tests / 862 pass / 0 fail / 2 skipped**
- 未做：pptx / pdf / xlsx 的同类开口（按计划排后面）

### 2026-11-11 · pptx 方案 A 第一步：单页强调色

- 决策：用户选 A（把 layout-library 当自家资产升级），但第一步不动版式库——
  版式库所有颜色都读 `tokens.colors`，所以"单页强调色"用派生 token 实现，零改版式。
- 实现：新增 `skills/pptx/scripts/lib/slide-style.mjs`（`SLIDE_ACCENT_ROLES` /
  `resolveSlideAccent` / `tokensForSlide`）；`make.mjs` 的 `normalizeSlides` 校验
  `slides[].accent`，`addSlide` 用 `tokensForSlide()` 传入该页 token
- 取值：`accent`（默认）/ `support` / `primary` / `success` / `danger`，映射到
  版式库实际读的 `accent` / `cyan` / `navy` / `positive` / `negative`；写错直接报错
- 验证（clinical 主题，3 页 metric）：默认页 `B4552D`、`danger` 页 `B42318`、
  `success` 页 `157F3D`；三页的 paper/ink/muted 完全一致（`FBF9F6`/`1C2B33`/`5C6B72`）；
  远端 Renderer 目视：只有大数字颜色变化，版式与背景不动
- 文档：`SKILL.md` 新增「单页强调色」小节，`references/creation.md` 补字段说明
- 测试：`pptx.sh self-test` 通过；`npm test` → 864 / 862 pass / 0 fail / 2 skipped
- 未做：`slide.tone`（深底页）——需要在 4–5 个版式上做对比度白名单 + 逐页目视验收，
  下一轮单独做

### 2026-11-11 · pptx 方案 A 第二步：单页深底（slide.tone）

- 实现仍在 `lib/slide-style.mjs`，不动 layout-library：`tone: dark` 时派生一份
  "深底 token"——背景用主题主色，文字用 `onDark`，`rule`/`soft` 按比例提亮，
  强调色/正负色用 **HSL 提亮**（保色相饱和度）而不是混白，避免"风险红"被冲成粉灰
- 对比度兜底：正文 ≥ 4.5:1、强调色 ≥ 3.5:1；达不到会继续提亮，仍达不到则由主题本身决定
  （目前 6 套主题均通过）
- 边界：`title`/`section`/`closing` 已是深底，传 `tone: dark` 直接报错；
  `tone` 非法值报错，不静默回退
- 验证（clinical 主题，逐页远端 Renderer 目视）：
  `content` / `metric` / `table` / `statement` / `quote` / `chart` / `comparison` /
  `two-column` / `timeline` / `case` / `evidence` / `imaging` 共 12 种版式深底均正常；
  表格斑马纹在深底下改为 18% 提亮才看得出；danger 强调由 `B42318` 提为 `EA6B62`
- 文档：`SKILL.md` 新增「单页深底」小节，`references/creation.md` 补字段
- 测试：`pptx.sh self-test` 通过；`npm test` → 864 / 862 pass / 0 fail / 2 skipped
- 未做：`split` 版式（需要真实图片才能验，逻辑与 imaging 同源）

### 2026-11-11 · xlsx：条件格式 / 重点行角色色

- 问题：`--spec` 生成时主题在 `buildWorkbookFromSpec` 之后才解析，条件格式只能写死 hex，
  换个主题"风险红"就跟 Word/PPT 不是同一个红。
- 实现：`commandMake` 把主题解析提前到写单元格之前，作为 `context.theme` 传入；
  `spreadsheet_cli.mjs` 新增 `ROLE_KEYS` / `mixHex` / `themeRoleColors` /
  `normalizeConditionalRule` / `applyRoleHighlight`
- spec 新写法（不写 hex，写角色）：
  `{"range":"B2:B4","rules":[{"type":"cellIs","operator":"lessThan","formulae":[0.6],"role":"danger","bold":true}]}`；
  另加 `highlights: [{"range":"A4:C4","role":"danger"}]` 给重点行/结论行静态上色
- 角色：`success/warning/danger/info` 取 `_shared/design-tokens.json` 的 `semantic.fg/bg`
  （四端同色，且**不选主题也能用**）；`primary/accent/support/ink/muted/rule/soft/white`
  取当前主题色板，未选主题时报错而不是静默变黑
- 底色：角色色字色 + 约 12% 混白的浅底；`fill: false` 只要字色，`bold: true` 加粗；
  原有 `style` 继续可用
- 安全：`validateConditionalFormattingRule` 拒绝在 builder API 里直接传 `role`（只有 spec 简写支持）
- 验证：
  - clinical：`danger` → `FFB42318` 字 + `FFFDECEC` 底；`warning` → `FFB45309` 字 + `FFFDF3E3` 底；
    `highlights` 落 `C4` 红色加粗（解包 `styles.xml` dxf + 远端 Renderer 目视）
  - mono：dxf 里四个语义色不变（`B42318` / `B45309`），页面主色随主题变灰
  - 不选主题：语义色可用；`primary` 报 `role 'primary' is unavailable for the active theme`
  - `make --input` 编辑既有文件同样生效（academic 主题，`fill:false` 只改字色）
- 文档：`SKILL.md` 新增「重点标注（角色色）」；`references/creation.md` 补字段 + 示例
- 测试：`self-test` 离线分支新增角色色断言；`npm test` → **864 tests / 862 pass / 0 fail / 2 skipped**
- 补：`soft` / `white` 按"底色角色"解析（配墨色字），用于分组行/隔断行；
  远端 Renderer 目视：`soft` 分组行是米色底 + 深墨字，`primary` 合计行是浅青底 + 主色字

### 2026-11-11 · pdf：局部强调色 / 提示框 / 三线表

- 问题：`make --spec` 只有全局主题，页面内没法表达"这一节标红""加个提示框""表格换三线表"，
  agent 只能改主题或放弃；且 PDF 的语义色没有和 Word/PPT/Excel 打通。
- 实现（`skills/pdf/scripts/pdf_cli.py`）：
  - `resolve_pdf_role()`：角色 → `fg`（字色）/ `bg`（浅底）/ `bar`（色条）/ `fill`（实底）/ `onFill`；
    语义色取 `_shared/design-tokens.json` 的 `semantic.fg/bg`，`designTheme: none` 也可用；
    主题角色未选主题时报错（不静默变黑）；`resolve_pdf_theme()` 现在回传 `semantic`
  - `sections[].accent` / 顶层 `accent`：小标题色条 + 标题文字换成该角色色
  - `callout`（顶层/小节）：`{role,title,body}` 浅底 + 左侧色条，语义色默认 `info`
  - `tableStyle`（顶层/小节，小节覆盖顶层）：`variant: grid|three-line`、`zebra`、`headerRole`
  - `build_table_flowable()` 支持三线表（无竖线、表头不上底色）、关斑马纹、表头换角色底色
- 验证（远端/本地 poppler 100dpi 逐项目视）：
  - clinical + `accent: danger`：风险提示标题与色条为 `B42318`，其余小节仍是主题主色
  - `callout.role=info`：底 `EAF1FA`、左条 `1F5FA9`；`danger`：底 `FDECEC`、左条 `B42318`
  - `tableStyle.variant=three-line`：只有上/表头下/下三条线，无竖线；`headerRole: accent`
    的网格表表头为 `B4552D` + 白字；`zebra:false` 生效
  - `designTheme: none` + `callout.role=warning`：底 `FDF3E3`、左条 `B45309`（语义色独立于主题）
  - 默认路径零回归：同一 spec 与 HEAD 版本输出逐像素 `diff bbox=None`
- 文档：`SKILL.md` 新增「局部样式」小节；`references/creation.md` 补字段与示例
- 测试：`pdf.sh self-test` 新增角色色断言（`B42318` / `B4552D`、主题角色必须选主题）
  与"提示框 + 三线表 + 网格表"构建/取文/取表校验；`npm test` → **864 / 862 pass / 0 fail / 2 skipped**
- 已知限制：`inspect --tables-out` 用 pdfplumber 的线条策略，三线表没有竖线时数不出表格
  （内容仍在文本层，可正常取文与目视）；
- 未做：正文内联强调（`==高亮==`）、表格单元格级角色色、多栏版式

### 2026-11-11 · A1 软删除（门 1 后端）

- 问题：以前"删除文件"就是 `fs.rm`，删掉不可恢复；设计书 §6.3 要求先进 `.trash`，
  7 天后才物理删除，且保留项不许删。
- 实现：
  - `ui/server/services/trash.js`：`moveFileToTrash()` 用同盘 `rename`（原子、不占双倍空间），
    失败只抛 `trash_failed` + 写审计，**绝不退化成 `rm`**；条目名
    `<groupRoot>/.trash/<原相对路径>.<YYYYMMDDTHHMMSSmmmZ>`，同毫秒冲突顺延 1ms，
    后缀可解析回原路径；`restoreFromTrash()` 原路径被占用报 `target_exists`（409），
    不覆盖；`purgeExpiredTrash()` 只删超过 7 天的，逐条写 `trash.purge` 审计
  - `ui/server/services/trashRetention.js`：启动跑一次 + 每 24h（`unref` 定时器）；
    多用户下枚举 `<PILOT_HOME>/users/*`，单用户退回根目录；失败只记日志，不影响启动
  - `ui/server/routes/storage.js`：`kind:'file'` 改软删除；`scanFiles()` 跳过根级 `.trash`
    （回收站文件不再出现在文件树/预览）；`totals` 新增 `trashBytes` 并计入 `totalBytes`
    （回收站仍占磁盘），`workspaceBytes` 只算当前文件；保留项删除 → 400 `invalid_input`；
    新增 `GET /api/storage/trash`（列表 + 合计）与 `POST /api/storage/trash/restore`
    （400/404/409/500 按错误码映射）
  - 审计动作：`file.trash` / `file.trash_failed` / `trash.restore` / `trash.restore_failed` /
    `trash.purge` / `trash.purge_failed`
- 验证：`cd ui && npx vitest run server/routes/storage.trash.test.js server/routes/storage.test.js`
  → 11 passed（rename 成功、恢复、二次恢复 404、占位 409、保留项 400、过期清理、扫描口径）；
  `cd ui && npm test` → 170 files / 1240 passed；根目录 `npm test` → 864 / 862 pass / 0 fail / 2 skipped
- 已知限制：清空整个工作区（`kind:'workspace'`）与归档（`kind:'archive'`）仍是硬删；
  前端还没有回收站列表/恢复入口（A2/A3）；`.trash` 本身仍可能被 bash 的 `rm/mv` 直接动到
  （与 inbox 残留风险同类）

### 2026-11-11 · A2 删除入口收口 + 用量聚合（门 1 通过）

- 问题：A1 把文件删除改成进回收站后，旧的 `StorageV2` 仍写着"永久删除""此操作不可恢复"，
  而且分组按钮还能触发 `kind:'workspace'/'archive'` 的**硬删除**——用户看到的语义和实际行为相反。
- 决定：A2 只收口**既有**删除入口，不新增入口；A3 的工作区面板仍按设计另起，不在 `StorageV2` 上扩展
  （见设计书 §5.3.1 的 2026-11-11 修订注记）。
- 实现：
  - `StorageV2.tsx`：删除目标只剩 `kind:'file'`；移除分组整包删除按钮；分组勾选框改为"只选文件"；
    主按钮"移入回收站"；确认框显示"共 N 个文件，合计 X"+"7 天内可恢复"；成功提示"已移入回收站"；
    总量区新增"回收站（7 天后释放）"一格（`totalBytes` 已含回收站，三者相加不再等于总量，
    必须单列才不误导）；工作区文件为空但 `trashCount>0` 时提示回收站里还有几个
  - `storage.js`：`scanWorkspaceGroups()` 增加 `usage: {inboxBytes, exportsBytes, scratchBytes, totalBytes}`，
    复用 `files[]` 聚合，不新增磁盘遍历
- 验证：`npx vitest run storage.trash.test.js storage.test.js StorageV2.test.tsx` → 17 passed；
  `cd ui && npm test` → 170 files / 1243 passed（`memory.test.js` 并行偶发 403 为既存抖动，单跑稳定）；
  `npx tsc --noEmit` ✅；`eslint StorageV2.tsx` ✅；根目录 `npm test` → 864 / 862 pass / 0 fail / 2 skipped
- 已知限制：①前端仍没有"恢复"按钮（第二批），恢复只能用 API；②清空工作区/整包归档的硬删除
  后端仍在，但前端已无法触发，等第二批收口；③`usage` 只在前端类型里预留，A3 面板才真正展示三条用量条

- 视觉微调（2026-11-11）：勾选框保留原生方框样式，只去掉**外围**那圈棕色焦点框——
  根源是 `index.css` 里 `input[type="checkbox"]:focus` 用 `--ring`（暖色主题下是棕红）画 2px outline，
  鼠标点选也会触发。改为 `:focus-visible`：鼠标点选不再出框，键盘 Tab 聚焦仍有焦点环。

### 2026-11-11 · 归档整包也进回收站（A2 追加）

- 需求：①"归档残留"这个词像垃圾，改成「已归档项目」并加副标题；②删除归档也要走
  "移入回收站、7 天后自动释放"，不能再硬删；③不新增"单文件归档"。
- 实现：
  - `ui/server/services/groupTrash.js`（新增）：整组回收站放在**用户 home** 下
    `<PILOT_HOME>/.trash/groups/`，布局 `workspaces/<type>/<id>.<stamp>` /
    `archives/<id>.<stamp>`。为什么不在 `trash.js` 里做：文件级回收站是"每个工作区根一个
    `.trash`"，整组删除时不能把工作区移进它自己内部，只能提到 home 级。
    提供 `moveGroupToTrash` / `listGroupTrash` / `restoreGroupFromTrash` /
    `purgeExpiredGroupTrash` / `groupTrashUsage`
  - `trashRetention.js`：7 天任务同时清理整组回收站
  - `storage.js`：`kind:'archive'` 由 `fs.rm` 改为 `moveGroupToTrash`；
    `totals.trashBytes` 加整组回收站占用；新增 `GET /api/storage/trash/groups`、
    `POST /api/storage/trash/groups/restore`
  - `StorageV2.tsx`：总量第三格改名「已归档项目」+ 副标题"删除项目时保留的文件，不会自动清理"；
    归档分组行新增"删除归档"按钮（文案"移入回收站（7 天后自动释放）"），确认框同样列
    文件数 + 合计大小
- 验证：`npx vitest run storage.trash.test.js storage.test.js StorageV2.test.tsx` → 18 passed
  （含整组 move/restore/409/过期清理/扫描口径）；`cd ui && npm test` → 170 files / 1247 passed；
  `npx tsc --noEmit` ✅；`eslint StorageV2.tsx` ✅
- 已知限制：`kind:'workspace'`（清空整个工作区）后端仍是硬删，前端未暴露，等第二批收口；
  两类回收站的"恢复/清空"UI 仍留到第二批（接口已可用）。
- 修正（同日，按反馈）：撤掉归档行那个独立的"删除归档"按钮——顶部红色「移入回收站」选中归档里的文件
  就能完成同样的事，不需要第二个入口。后端 `kind:'archive'` 仍是软删除（整组进 `.trash/groups`，
  仅 API 可达），前端不新增入口；`StorageV2` 的删除目标回到只有 `kind:'file'`。

### 2026-11-11 · 归档改为"组勾选 + 红色按钮"整包删除

- 需求：不加行内按钮，但要让删除**整个归档**是真的整包（目录直接消失），而不是只把里面的文件一个个搬走。
- 实现（`StorageV2.tsx`）：
  - 归档 tab 的组勾选 = 一个 `kind:'archive'` 目标（整包）；勾单个文件时会自动取消该组的整包选择，
    避免"确认框写整包、实际只删一个文件"
  - 顶部红色「移入回收站」对整包目标发 `{ kind:'archive', scope:'archive', groupId }`，
    确认框显示"整个归档目录（含 N 个文件，X）会移入回收站，7 天内可恢复"
  - 空归档也可整包勾选删除（否则空壳永远留着），空工作区仍禁用
  - 混选（整包 + 单个文件）时按"选中的 N 项"描述，不冒充整包
- 后端无需改动：`kind:'archive'` 在上一轮已改成 `moveGroupToTrash`（`<PILOT_HOME>/.trash/groups/archives/`），
  7 天过期任务与 `GET/POST /api/storage/trash/groups*` 恢复接口都已就位
- 验证：`npx vitest run StorageV2.test.tsx` → 5 passed（整包、空归档、文件级、扫描口径）；
  `cd ui && npm test` → 170 files / 1247 passed；`npx tsc --noEmit` ✅；`eslint StorageV2.tsx` ✅
- 已知限制：`kind:'workspace'`（清空整个工作区）后端仍是硬删且前端不暴露；两类回收站的 UI 恢复按钮仍在第二批

### 2026-11-11 · A3 收尾：管理员"各用户目录占用总览"（§9.2.1）

- 需求：管理员一眼看到每个用户目录占多少、谁在涨、inbox 占多少；不新增"停用账号"之类快捷操作。
- 实现：
  - `ui/server/services/storageUsage.js`：`sumDirectory` 换成 `walkDirectory`，一次遍历同时累计
    `bytes` 与 `inboxBytes`（`workspaces/<id>/inbox` 与 `workspaces/<type>/<id>/inbox` 两处），
    新增 `getUserStorageBreakdown()` / `listArchivedUserBytes()` / `getUserTotalWarningBytes()`，
    `getUserStorageBytes()` 保留原签名。缓存仍是每用户 60 s，`invalidateStorageCache()` 同时清
    归档与阈值缓存
  - `ui/server/routes/adminUsers.js`：`GET /users` 返回 `inboxBytes` / `archivedBytes` 与顶层
    `storage` 汇总；`?refresh=1` 先清缓存。归档目录按 `<id>-` 前缀归属，删掉的账号依旧计入合计
  - `ui/src/components/settings/view/users/*`：合计行、刷新按钮、存储列排序（默认降序）、
    占比列、其中 inbox 列（含占本用户百分比）、超阈值琥珀色、归档灰标；`storage` 汇总由 hook 透传
  - `ui/src/utils/formatBytes.ts`：补 GB / TB 两档
- 设计取舍：不把"占比"算成 `storageBytes / 所有用户 storageBytes` 之外的东西——分母含归档字节，
  与页头合计一致，避免出现"各行占比加起来不是 100%"。
- 验证：见 §2.3 实测结论（39 条定向用例 + 170 files / 1258 passed + tsc + eslint 全绿）
- 已知限制：①归档目录只做总量与行内提示，没有"查看/恢复已归档账号"的入口（第二批）；
  ②阈值只读 `pilotdeck.yaml`，管理页还没有编辑配额的表单（§9.2 的配置表单未做）；③告警只着色不拦截

### 2026-11-12 · 第二批：回收站 UI / 新建目录 / scratch 清理 / 工作区硬删收口

- 需求：进第二批，不再等"A1 跑满 2 周"这类触发条件；回收站、新建目录、scratch 自动清理、
  `kind:'workspace'` 硬删收口一起做。
- 后端：
  - `services/trash.js`：`listTrash` 按"是否带时间戳后缀"区分**条目**与中间层 →
    目录也能作为单个回收站条目（递归计量、整体恢复）；抽出 `purgeEntries` 让
    7 天过期与手动清空共用一套审计（`trash.purge`，`meta.kind`/`retentionDays`）；
    新增 `emptyTrash(groupRoot,{audit,actor})`（`reason: manual`，`tool: trash.empty`）
  - `services/workspaceLimits.js`（新）：`workspace.quota` 唯一来源 + 60 s 缓存 + 非法值回落默认；
    默认 workspace 5 GiB / scratch 1 GiB / soft 0.8 / TTL 30 d / 保护窗 10 min / 单用户 20 GiB / 影像 2 GiB
  - `services/scratchRetention.js`（新）：只清 `scratch/<四类>`，按单元整体删，
    先 TTL 后超限，按 `tool-results → preview → work → qa` + `lastUsedAt` 清到软阈值；
    `.pinned`（JSON 数组 / 逐行）与保护窗免删；启动一次 + 每 6 h；审计 `scratch.clean(_failed)`
  - `routes/storage.js`：`kind:'workspace'` 由 `fs.rm` 改为逐顶层条目 `moveFileToTrash`
    （跳过保留项）后重建 `inbox/exports/scratch`
  - `utils/workspacePaths.js`（新）：把新建目录的校验从 `index.js` 抽出来
    （`index.js` import 即起服务，路由逻辑只能靠起服务测；与既有 `routeErrors.js` 同一做法）
  - `index.js`：新增 `POST …/files/mkdir`、`GET …/trash`、`POST …/trash/restore`、
    `POST …/trash/empty`（必须 `confirm:true`）、`POST …/workspace/scratch/clean`；
    `/workspace/usage` 返回由配置算出的阈值 + `scratchPolicy`；启动处 `startScratchRetention()`
- 前端（`FilesV2.tsx`）：头部「新建目录」+ 弹窗（多级、父目录须已存在）；
  用量条下补「只有 scratch 会被自动清理」说明 + 「立即清理 scratch」（为 0 时禁用）；
  可折叠「回收站」区（条目数/大小/7 天说明、逐项恢复、清空 → 二次确认）
- 验证：
  - `npx vitest run server/services/workspaceLimits.test.js` → 6 passed（默认/部分覆盖/非法值/YAML 坏/影像覆盖/60 s 缓存）
  - `npx vitest run server/services/scratchRetention.test.js` → 8 passed（只动 scratch、TTL、清理顺序、未超限不动、
    `.pinned` 两种格式、审计字段）
  - `npx vitest run server/utils/workspacePaths.test.js` → 11 passed（绝对路径/盘符/`..`/隐藏名/非法字符/层级/长度/越界/软链）
  - `npx vitest run server/routes/storage.trash.test.js server/services/storageUsage.test.js src/components/main-content-v2/FilesV2.test.tsx` → 35 passed
  - `npx vitest run`（ui 全量）→ **173 files / 1290 passed**
  - `npx tsc --noEmit` ✅ ｜ `eslint`（index.js / workspacePaths / scratchRetention / workspaceLimits / trash / storage）✅
- 已知限制：
  1. 新增的 5 个路由没有 HTTP 级自动化测试——`index.js` import 即 `listen`；已把**校验规则**
     抽到 `workspacePaths.js` 单测覆盖，路由本身只做"校验 → 调用 service → 映射状态码"，
     手工验收需重启 `node server/index.js` 后 curl。
  2. 就地编辑 UI 未做（后端 `/api/files/save` 已可用）。
  3. 可见性白名单/沙箱可写范围收窄仍延后（依赖 skills 结构冻结）。
  4. scratch 清理是旁路任务，**不会**在测试里验证定时器本身，只验证 `cleanScratch` 单次行为。
- 未提交：本轮所有改动仍在工作区（用户要求只改代码、不 commit/push）。

### 2026-11-12 · 第二批收尾：就地编辑 + 路由级测试

- 需求：把第二批剩余的两项做完——①预览弹窗里的就地编辑；②新路由的 HTTP 级测试。
- 实现：
  - `ui/server/routes/workspaceFiles.js`（新）：把第二批 5 条路由从 `index.js` 搬出来，
    改成 `createWorkspaceFilesRouter({ extractProjectDirectory })`。理由与 `apiRouter.js` 一致：
    `index.js` import 即 listen，路由只能靠起真服务测；注入依赖后可以用临时工作区跑完整链路。
  - `apiRouter.js`：新增可选参数 `extractProjectDirectory`；`/projects` 挂载改为
    `api.use('/projects', ...requireUser, projectsRoutes, workspaceFilesRouter)`——
    同一条 `requireUser` 链只跑一次，不重复鉴权。
  - `index.js`：删掉 92 行内联路由 + 不再使用的 import；保留 `/workspace/usage` 等面板接口。
  - `utils/workspacePaths.js`：新增 `normalizeWritePath()`（`normalizeNewPath` + inbox 顶层只读）
    与 `WORKSPACE_READ_ONLY_ROOTS`。
  - `PUT /api/projects/:name/file`：路径校验由"前缀 startsWith"换成
    `normalizeWritePath → resolveInsideRoot → assertNoSymlinkOnPath`；
    越界/隐藏名/保留项/inbox/软链统一 400（原先是 403 或直接放行），二进制 Office/PDF 仍 415。
  - `FilesV2.tsx`：文本预览弹窗新增「编辑」→ textarea → 「保存 / 取消」；
    保存成功回写预览内容并 `refresh()`；`truncated` 与 inbox 文件不显示编辑按钮
    （前者会截断丢内容，后者是只读原始凭证）；关闭弹窗时清空草稿。
- 验证：
  - `npx vitest run server/routes/workspaceFiles.test.js` → 18 passed（mkdir 201/400×6/409/404/软链；
    回收站空列表、恢复、404、409 冲突、缺 confirm 400、confirm 清空；scratch clean；未知项目 500）
  - `npx vitest run server/utils/workspacePaths.test.js` → 12 passed（新增 `normalizeWritePath`：inbox 只读、
    `我的资料/inbox` 放行、exports/scratch 放行）
  - `npx vitest run src/components/main-content-v2/FilesV2.test.tsx` → 9 passed
    （新增：编辑保存发 PUT 且刷新、取消不写盘）
  - `npx vitest run server/adminGating.test.js` → 44 passed（挂载表改动后鉴权矩阵不变）
  - `npx vitest run`（ui 全量）→ **174 files / 1311 passed**
  - `npx tsc --noEmit` ✅ ｜ `eslint`（FilesV2 / index.js / apiRouter.js / workspaceFiles / workspacePaths）✅
- 行为变更（需要知道）：
  1. `PUT /api/projects/:name/file` 现在拒绝写 `inbox/**`（400 `read_only_root`）。
     代码编辑器打开 inbox 内文件后保存会看到明确报错；这是有意的"上传件不可改写"。
  2. 同一接口原先对绝对路径只做 `startsWith` 前缀判断，现在逐段拒绝软链，软链目录内的写入会失败。
  3. 越界从 403 统一为 400 + `code`，前端按 `error` 文案展示，不影响既有调用方。
- 剩余：§7 可见性白名单 / 沙箱可写范围收窄（依赖 skills 结构冻结）。
- 未提交：本轮所有改动仍在工作区。

### 2026-11-12 · 决策变更：inbox 对用户本人可写

- 背景：第二批收尾时 `PUT /api/projects/:name/file` 按 agent 的规则拦了 `inbox/`，
  导致用户在代码编辑器里保存上传件会被 400。
- 决定：**inbox 只对 agent 只读**。`src/tool/builtin/filesystem/pathSafety.ts` 的
  `READ_ONLY_WORKSPACE_ROOTS`（agent 工具层）保持不变；UI 写入路径
  （`normalizeWritePath`）不再拦 `inbox/`，`FilesV2` 也不再隐藏 inbox 文件的「编辑」按钮。
- 理由：inbox 里是**用户自己的**上传件；改表头/补列是正常操作。agent 仍不得改写它，
  因为 agent 的写入会让"原始凭证"失去可追溯性。
- 验证：`npx vitest run server/utils/workspacePaths.test.js src/components/main-content-v2/FilesV2.test.tsx`
  → 23 passed（新增 inbox 可写 2 条、inbox 文件可编辑 1 条）

### 2026-11-12 · 可见性白名单评估结论 + 沙箱可写收窄清单

- 用户问题：能否做到"用户看不到脚本、也无法让 agent 念脚本"，同时不影响 agent 运行技能？
- 核查结论（代码事实）：
  - **UI 层本来就没有脚本入口**：`SkillsV2` 只调 `/api/skills/read|write`，
    `SkillManager.read()` 写死 `join(skillDir, "SKILL.md")`；`write()` 对 builtin/medical 直接
    `read_only` 403（`assertMutableScope`）。所以"UI 层脚本不可见"**无需改动**。
  - **跨用户隔离已有测试**：`tests/tool/path-safety-multiuser.spec.ts`（绝对路径、`../` 逃逸、软链）。
  - **真正的缺口只有一个**：bash 沙箱里整个 user home 可写，且 bash 绕过 `pathSafety`。
- 关于"agent 不念脚本"的技术定性：
  - 只要技能脚本还在 agent 沙箱内，"能执行"就等于"能 `cat`"（解释器必须可读；
    `chmod 0111` 对 `.sh/.py` 无效；bwrap 无 deny-read 原语）。**只靠文件权限做不到**。
  - 100% 方案只有"执行/读取分离"：沙箱不挂载 `skills/`，注册命令改由宿主进程执行，
    并脱敏 traceback（Python 默认会打印源码行）。成本 4–6d，主要花在五个技能的
    network/cache/env 重新接线。**本轮不做**（用户决定先搁置）。
- 本轮产出：`docs/plans/sandbox-write-scope-narrowing.md`（改造清单 W1–W8、回归用例
  A1–A10 / E1–E7 / N1–N4、残余风险、回滚开关 `multiUser.sandbox.narrowWrites`、2–2.5d 估时）。
- 未改任何代码，未提交。

### 2026-11-12 · 沙箱可写范围收窄 S1（接线 + 开关，默认关闭）

- 开关：`multiUser.sandbox.narrowWrites`，缺省 `false` → **行为与现状完全一致**（整个 home 可写）。
- 新增 `src/tool/builtin/bash/sandbox/writeScope.ts`：`resolveWriteRoots()` 是 bwrap argv /
  sandbox-exec profile / 启动自检 `grants()` 的**唯一口径**，避免三处不一致。
- 收窄档位（`true`）：home 整体只读，只放行「当前工作区 + `<home>/.cache` + `<home>/.tmp`」；
  越界、相对路径、home 本身一律丢弃。读权限不变。
- 接线：`bash.ts` 传 `writeRoots: [context.cwd]`；`commandRunner.ts` 读配置并打印
  `[sandbox] <kind> (ok), writes=narrow|home`。
- 顺带修复：`analysis.rejected` 审计用真实时钟分片，跨天后 `tests/tool/analysis-audit.spec.ts`
  必挂 → 改为跟随 `context.now`。
- 测试：`npx tsc --noEmit` ✅ ｜ `npm test` → **873 / 871 pass / 0 fail / 2 skipped** ｜
  `ui && npx vitest run` → **174 files / 1313 passed**。
- 未做：S2（Linux 真开 + E1–E7 技能回归）、S3（macOS）、S4（反向断言 N1–N4）。默认值保持 `false`。
- 未提交：改动仍在工作区。

### 2026-11-12 · 沙箱可写收窄 S3（macOS 真开 + E1–E7）

- 方法：临时用户 home + 真实 `pilotdeck.yaml`（只把 `narrowWrites` 改 `true`）+ `initializeSandbox`
  + `NodeShellCommandRunner`，不碰正在运行的 5170 服务。
- **抓到一个真缺陷并修复**：SBPL 读规则从来没单独列 `home`（兼容档位靠写规则 `file*` 顺带），
  收窄后 `home` 立刻不可读 → `cat ~/memory/x` EPERM、`analysis.sh run` 读不了 `inbox/`。
  修法：`readDirs` 显式加入 `home`，`grants().readOnly` 同步，补 2 条断言。
- 结果：E1–E7 全绿（pdf/docx/pptx/xlsx/analysis/html/diagram 都出产物）；
  反向用例 越界写 `memory|logs|projects|其他工作区|软链逃逸` 全部 EPERM，写 `exports|.cache|.tmp` 正常，
  读 `memory|skills` 正常；`narrowWrites: false` 对照组越界写全部成功。
- 未覆盖：`docx --render`（本机无 LibreOffice / 无 19400 渲染服务）、Linux bwrap（S2）。
- 测试：`npx tsc --noEmit` ✅ ｜ `npm test` → **873 / 871 pass / 0 fail / 2 skipped**。
- 默认值仍为 `false`；未提交。

### 2026-11-12 · 沙箱可写收窄 S4（W6 反向断言 + 自动化用例）

- 代码：`assertSandboxGrantsSafe()` 增加 `{ narrowWrites, writeRoots }`；收窄档位下可写授权必须
  「在 home 内、不等于 home、不覆盖 workspaces 根、只含声明的当前工作区、不碰 memory/logs/skills/.trash/projects」，
  命中即启动失败（fail-closed）。`initializeSandbox()` 已把开关传进去。
- 测试：`commandRunner.spec.ts` +2 条（合法组合通过 / 9 种越界逐一抛错）；
  新增 `tests/tool/builtin/bash/sandbox/writableScope.integration.spec.ts` 7 条真跑沙箱用例
  （A6/A7/A8/A9 + N1/N2/N3），无沙箱平台整组 skip。
- 结果：`npx tsc --noEmit` ✅ ｜ `npm test` → **882 / 880 pass / 0 fail / 2 skipped**；
  S3 harness 复跑仍全绿。
- 未做：S2（Linux bwrap 真机）、`docx --render` 链路；默认值仍 `false`；未提交。

### 2026-11-12 · 决策变更：数据分析产物改为「一轮一目录」（D9，设计已定未实现）

- 现象：2026-11-12 一轮对话实跑留下 **14 个平级目录 / 102 个文件**（`exports/analysis/` 下），
  其中 6 个是失败、重复或空跑；`find exports -name report.md` 为空；
  agent 回复末尾的产物卡片一次列出 25 个文件，用户在工作区里找不到对应关系。
- 根因：旧约定"一次运行一个目录"（2026-11-11 追加），且失败半成品留在 `tables/`；
  slug 只留 `[A-Za-z0-9._-]` 把中文过滤成拼音（`xiaohua`、`cat2`、`s1`）；
  `report.md` 只写在退出码表的一行里，模型稳定跳过（14/14 未生成）。
- 决定（设计书 §6 / §9 U4）：
  1. **一轮一目录**：`exports/<YYYYMMDD-HHMMSS>-<中文主题>/`，根目录按 `PILOTDECK_TURN_ID` 钉死，
     不再有 `analysis/` 中间层；跨轮不覆盖，同轮允许覆盖；
  2. **失败就地重试**：半成品留在原目录给 agent 读，下一次重试开始前删掉 `attempts[-1].produced`，
     成功时目录里只剩最终产物；不搬到 scratch、不新建目录；
  3. **`report.md` 由执行器出骨架**（标题 / 口径 / 表图索引 / 结论占位），agent 只补结论；
  4. 表图命名 `<序号>_<中文名>.csv`；子目录只给同轮"互不相关的第二件事"；
  5. 工作区列表按 `modified` 倒序（服务端 `files/list` 一处改动）。
- 待办：`run_analysis.py`（轮次绑定 / attempts / 精确清理 / report 骨架）、`SKILL.md`（6 处路径 +
  "失败不许换目录" + "半成品只能读不能抄"）、`tests/skills/data-analysis-runner.spec.ts`
  （`status: ok` 语义反转 + 新增轮次用例）、`exports/analysis/` 整包移入回收站（不碰根下 docx/pdf）。
- 实现（2026-11-12 同日完成）：
  - `run_analysis.py`：`PILOTDECK_WORK_DIR`/`PILOTDECK_TURN_ID` → `scratch/.../.analysis-root.json` 钉住根目录；
    `--out` 第一段改写回该目录、其余段保留为子目录；同名目录自动加 `-2`；
    运行前后快照算出 `produced`，失败写 `attempts[]` 并回 `staleFiles`，下次运行前删掉上次失败产物；
    成功追加 `steps[]`；`report.md` 生成骨架（`<!-- index:start/end -->` 之间每次成功刷新索引，
    正文与 `## 结论` 一字不动），`run.json.reportMissing` 标记结论是否还没写。
  - 无 `PILOTDECK_TURN_ID` 时（CLI / 测试）退化为旧语义：`--out` 原样使用、已有成功结果仍拒绝覆盖。
  - `SKILL.md`：路径 6 处改掉；新增「一轮一个目录」「失败就地重试不许换目录」「半成品只能读不能抄」
    「回答末尾给 `exports/<目录>/`」。
  - 测试：`data-analysis-runner.spec.ts` 14 → 18 条（换名被改写 / 跨轮开新目录 / 失败留半成品并清理 /
    report 骨架与索引刷新），原「已成功目录不许覆盖」用例在 standalone 模式下保持通过。
  - 迁移：`moveFileToTrash(工作区, 'exports/analysis')` → `.trash/exports/analysis.20261112T082826981Z`
    （1.49 MB，1 条记录，7 天自动释放）；`exports/` 根下 7 个 docx/pdf/pptx 未动。
- 测试：`npm test` → **899 tests / 897 pass / 0 fail / 2 skipped**。
- 未提交：改动仍在工作区。

### 2026-11-12 · D10：scratch 分档清理（回合结束即删本轮）

- 现象：`scratch/` 实测 11 MB，其中 `work/` 9.9 MB（38 张 png），`data/` 856 KB、`qa/` 40 KB、`docx/` 24 KB。
  一个 30 天的统一 TTL 会让"用完即弃"的回合目录压满 1 GiB，也会让"跨轮还用"的草稿被过早清掉。
- 决定：按目录分三档（不再一刀切）——
  1. `scratch/work/<session>/<turn>/`：**回合结束立刻删**（体积主体，跨轮价值≈0）；
  2. `scratch/tool-results/<turnId>-*`：回合结束删本轮文件；`refs/result-NNNN.txt` 无 turnId 前缀，留给 TTL；
  3. `scratch/qa|docx|data|tmp`：保留，`scratchTtlDays` **30 → 7 天**；`preview`、`.analysis-cache` 不动。
- 实现：
  - 新增 `ui/server/services/scratchTurnCleanup.js`：`safeScratchSegment()`（与 `AgentLoop.buildTurnEnvironment`
    的 `safeWorkPathSegment` 同一套 NFKC + 字符白名单）定位目录；删 `work/<session>/<turn>`，
    兜底再删 `work/<turn>`；空 session 目录顺手 `rmdir`；按 `<turn>-` 前缀删 tool-results 文件；
    符号链接跳过，所有路径经 `within(scratchRoot, target)` 校验，异常只 `log.warn`、**永不抛错**。
  - `pilotdeck-bridge.js`：新增 `scheduleTurnScratchCleanup()`（Set 去重、fire-and-forget），
    挂在 `turn_completed`（正常 / 失败 / abort 三条路径都会发），**不挂 SSE `done`**（客户端断线也会触发）。
  - `workspaceLimits.js`：`scratchTtlDays` 默认 7；新增 `cleanOnTurnEnd`（默认 `true`，
    yaml 写 `false` 可关，非布尔值回落默认）。
- 已知缺口：always-on / 定时任务的 `turn_completed`（`registerAlwaysOnNotificationForwarding`）没有 `projectKey`，
  无法定位工作区，未挂清理 → 这类会话的 `work/` 由 TTL 兜底（最长 7 天）。
- 测试：`scratchTurnCleanup.test.js` 8 条（删本轮留他轮 / 不碰四类草稿 / 前缀删 / 空 session 回收 /
  非空不删 / 软链不跟随 / 无 scratch 安静返回 / 段名一致）；`workspaceLimits.test.js` +2 条（默认 7 天与开关默认开 / yaml 关闭生效）。
  `npx vitest run scratchTurnCleanup scratchRetention workspaceLimits` → **3 files / 24 tests passed**。
- 未提交：改动仍在工作区。

### 2026-11-12 · D11：「立即清理 scratch」改成强制清理

- 现象：点「立即清理 scratch」返回"没有可清理的内容（最近使用过的会自动跳过）"，但目录里有 11 MB。
- 根因：按钮只是"现在跑一次自动清理规则"，三条闸门一条都不满足 ——
  ①TTL 7 天未到；②总量 11 MB ≪ 1 GiB；③`SCRATCH_CATEGORIES` 只有 4 类，
  `data`/`docx`/`tmp`/`qc` 和 `scratch` 根下的散文件根本不在扫描范围；
  另外 `work/` 以**会话**为单元，一个会话里所有回合同生共死，9.9 MB 的那一坨永远"最近用过"。
- 决定（A 方案）：用户手动点按钮 = 明确授权，语义改为"能删的全删"。
  - `force: true` 忽略 TTL 与容量；只保留 60 秒防抖窗（正在跑的回合）与 `.pinned`；
  - 必须同时带 `confirm: true`（缺 → 400 `confirm_required`），前端加二次确认弹窗，
    弹窗里写明体积、"exports/inbox/我的资料不受影响"、"不可恢复"；
  - 审计 `reason: 'manual'`；不带 body 的旧调用仍走自动规则（定时任务/脚本用）。
- 配套修的两个真问题：
  1. 扫描范围扩到 8 类目录 + `scratch/` 根下散落项（跳过隐藏项 `.analysis-cache` 等）；
  2. `work/` 改按**回合**拆单元（`work/<session>/<turn>` 各自独立），删空的会话目录顺手 `rmdir`；
  3. 目录的 `lastUsedAt` 改用子项 mtime 最大值 —— 目录 mtime 只在增删条目时更新，
     用它判过期会误判（实测：旧文件放进新目录，整个会话被当成"刚用过"）。
- 实测（本机 `general_med-mwbs19p9-fa8d27`）：30 个单元、共 10.88 MB，强制清理后全部释放；
  `exports/` 8 个报告目录、`inbox/`、`我的资料/` 不受影响。
- 测试：`scratchRetention.test.js` 8 → 15 条；`workspaceFiles.test.js` +2 条（force 缺 confirm 400 / force+confirm 真删）；
  `FilesV2.test.tsx` +1 条（先弹确认再提交 `{force:true,confirm:true}`）。
- 结果：`ui` → **175 files / 1333 tests passed**；根仓库 → **899 / 897 pass / 2 skipped**；`tsc --noEmit` ✅。
- 未提交。

### 2026-11-12 · D12：工作区面板拖拽移动 + 三处文案

- 需求：①除 `exports`/`inbox`/`scratch` 三个骨架根外，其余内容支持拖拽移动（进目录、进回收站）；
  ②去掉"可读/可写/只读"能力卡，换成三目录说明；③把"只有 scratch 会被自动清理…"改成"scratch 会定期自动清理"；
  ④用量条 `inbox` 与 `scratch` 换位。
- 后端：
  - `POST /:projectName/files/move` `{from, toDir}`：`rename` 原子移动；`toDir: ''` = 工作区根；
    拒绝骨架根（`pinned_root`）、拒绝移进 `scratch`（`scratch_is_disposable`）、
    同名 409、移进自己 400、跨设备 400；审计 `file.move`。
  - `POST /:projectName/files/trash` `{path}`：复用 `moveFileToTrash`（软删进 `.trash`，7 天可恢复），
    拒绝骨架根；审计沿用 `file.trash`。
  - 两个接口都复用 `normalizeNewPath` / `resolveInsideRoot` / `assertNoSymlinkOnPath`（`..`、隐藏名、软链逐段拒绝）。
- 前端：`TreeBranch` 增加 HTML5 拖拽（`dragstart` 冒泡要用 `stopPropagation`，否则父行会覆盖拖拽源）；
  目录行与"列表空白处"是落点，回收站标题行是软删除落点；拖拽中落点高亮；`exports/inbox/scratch` 根不可拖。
- 文案/布局：用量条 `总量 → inbox → scratch`；能力卡换成 `DirectoryLegend`（inbox/exports/scratch 各一句）；
  底部提示改"scratch 会定期自动清理；inbox 与 exports 不会"；目录标题右侧加"拖拽可移动"。
- 测试：`workspaceFiles.test.js` +6 条（移动成功 / 移到根 / 拒绝骨架与 scratch / 同名与移进自己 / 软删进回收站 / 拒绝删骨架）；
  `FilesV2.test.tsx` +2 条（拖到目录行发 move、拖到回收站发 trash），并更新原能力卡断言。
- 结果：`ui` → **175 files / 1343 tests passed**；`tsc -p ui` ✅。一次全量跑出过 1 条偶发失败，重跑即绿（与本轮改动无关，待观察）。
- 未提交。

### 2026-11-12 · D12 复盘：拖拽进回收站没反应 / 面板微调

- 现象：把「我的资料」拖到回收站没反应；用户以为是"拖拽没做出来"。
- 根因（两条叠加）：
  1. 5170 上的 node 服务是 17:08 启动的，早于路由改造 → `/files/move`、`/files/trash` 是 404。
     Vite HMR 让前端看起来是新的，但后端没重启，视觉上就是"拖了没反应"。
  2. 回收站的落点只有标题行那一条（约 20px 高），拖偏一点就落空。
- 处理：
  - 重启用新端口配置（`SERVER_PORT=3020 VITE_PORT=5170`）拉起 dev，`/files/*` 从 401（未登录）而不是 404 可证路由已生效。
  - 落点改为**整个回收站板块**（含展开后的列表），悬停时整块变红。
  - 新增拖拽蒙层：暗色背景 + 底部红色垃圾桶 `animate-bounce` + "松开鼠标，移入回收站"；
    `dragleave` / `drop` / `dragend` 三处都会收起，蒙层 `pointer-events-none` 不影响落点判定。
  - `draggable` 从外层 `div` 挪到行内 `button`（Chrome 下从按钮起拖更稳），仍保留 `stopPropagation` 防父行覆盖拖拽源。
- 同时按需求调整：
  - 删掉"只有 scratch 会被自动清理…"整句；scratch 说明改为"中间产物，会定期自动清理，也可手动立即清理"；
  - "立即清理 scratch" 按钮移到说明卡外面、卡片下方右对齐；
  - **允许**把内容拖进 `scratch`（去掉 `scratch_is_disposable` 400），成功后提示会被定期清理。
- 测试：`workspaceFiles.test.js` 26 条、`FilesV2.test.tsx` 13 条（新增"悬停出现提示层、拖完消失"断言）；
  全量 `ui` → **175 files / 1343 tests passed**；`tsc -p ui` ✅。
- 未提交。

### 2026-11-12 · D12 二次微调：落点范围 / 蒙层 / 提示自动消失

- 按反馈调整：
  1. "立即清理 scratch" 放回**说明卡上方**（用量条下、右对齐）；
  2. scratch 说明改为"中间产物，会自动清理，可手动立即清理"；
  3. 回收站落点扩到**面板底部整块**：`回收站板块 + 其下方空白` 都算（把该 `<section>` 设为 `flex-1 min-h-[96px]`，
     空白处也在它内部）；
  4. 拖拽蒙层改为**面板底部 40% 的由下往上灰色渐变**（`from-black/55 via-black/25 to-transparent`），
     `absolute` 于面板而非全屏；垃圾桶缩到 56px 居中；删掉"松开鼠标"文案；
  5. 顶部提示 4 秒自动消失（`NOTICE_TTL_MS`，错误提示同样处理）。
- 测试：`FilesV2.test.tsx` 14 条（新增"提示 4 秒后自动消失"；蒙层断言改为 `data-testid="trash-drop-overlay"`）。
  全量 `ui` 连跑 3 次 → **1344 tests 全绿**；`tsc -p ui` ✅。
- 备注：全量曾偶发 1 条失败，三次复跑均未复现，暂按 flake 观察。
- 未提交。

### 2026-11-12 · D12 三次微调：小字按钮 / 动态总量提示 / 头部图标按钮

- 按反馈调整：
  1. "立即清理 scratch" 从横排按钮改为 **scratch 进度条正下方的小字下划线按钮**，
     字号/颜色与 inbox 的"上传原件不会自动清理"一致，hover 变前景色（有按钮感），scratch 为空时禁用；
     顺带把 `UsageBar.note` 的类型从 `string` 放宽到 `ReactNode`，容器 `<p>` 改 `<div>`（`<p>` 里不能塞 `<button>`）。
  2. "仅为提示，超阈值不拦截写入" 改成**随工作区总量变化**的 4 档提示语
     （`totalRatio = 总占用 / 提示阈值`）：`<60%` 正常 / `≥60%` 留意大目录 / `≥80%` 建议清理 scratch 或删导出 /
     `≥95%` 建议立即清理并移出大文件；四档都保留"不拦截写入"或只给建议，永不阻断。
  3. 头部"上传文件"从文字按钮改成与"新建目录"同款的 8×8 图标按钮；
     "新建目录 / 上传文件 / 刷新"三个按钮都包一层 `Tooltip`，鼠标悬停在按钮**上方**弹主题气泡
     （`bg-foreground` 底 + `text-background` 字 + 同色箭头）。
     同时去掉三者的原生 `title`，避免原生 tooltip 与气泡叠加。
- 组件改动：`ui/src/shared/view/ui/Tooltip.tsx` 新增可选 `arrowClassName`（箭头颜色跟随自定义气泡），
  默认行为不变，其它调用点不受影响。
- 测试：`FilesV2.test.tsx` 16 条（新增"高占用时提示语变化"、"悬停出现头部气泡"；首条用例改为断言默认提示语）。
  全量 `ui` → **175 files / 1346 tests passed**；`tsc -p ui` ✅。
- 备注：全量偶发 1 条 `adminUsers.test.js` 自建 http server 的 `ECONNRESET` / `UND_ERR_SOCKET`，
  单跑该文件 17 条全绿、整包重跑亦全绿，判定为并发下的自连 flake，与本轮改动无关。
- 未提交。

### 2026-11-12 · D13：`.pilotdeck/tool-results` 生命周期（删会话即清 + 14 天兜底）

- 现象：每个工作区根下都出现 `.pilotdeck/tool-results/<会话ID>/`（图片 base64、长文本、大 JSON），
  用户在工作区看到的只是目录本身；这些是"超出内联预算"的工具结果副本，供历史消息回看与 agent `read_file` 回读。
- 问题：`sessionCleanup.js` 只清 transcript / inbox / case，**删会话不清它**；也没有 TTL，
  `users/1/.pilotdeck` 下还躺着 3 个 transcript 早已不存在的孤儿（约 0.9 MB）。
- 改动：
  1. `sessionCleanup.js` 增加**第 4 类** `toolResults`：删 `<workspace>/.pilotdeck/tool-results/<slug>/`，
     并只在空时收掉 `tool-results/`、`.pilotdeck/`（`.pilotdeck` 还可能是项目级 skills/commands 的载体）。
  2. 新增 `ui/server/services/toolResultsRetention.js`：启动跑一次 + 每 6 小时一次；
     - transcript 已不存在 → 删（1 小时宽限，避开"目录刚建、transcript 未落盘"）；
     - 最新 mtime 超过 `toolResultsTtlDays`（默认 14 天）→ 删；`refs/` 只走这条；
     - 扫 `<home>/.pilotdeck/tool-results` 与 `workspaces/**/.pilotdeck/tool-results`（最多 3 层）。
  3. `workspaceLimits.js` 新增 `toolResultsTtlDays`（默认 14，读 `workspace.quota.toolResultsTtlDays`）；
     `index.js` 启动时接上 `startToolResultsRetention()`。
- 数据清理：对 `users/1` 实跑一次 → 删掉 **16 个单元 / 5.7 MB**（0.9 MB 孤儿 + 4.8 MB 超过 14 天的旧缓存），
  剩余的是 14 天内仍在用的会话缓存与用户自己的 `.pilotdeck/plans/*.md`，未动。
- 测试：新增 `toolResultsRetention.test.js` 9 条（存活保留 / 孤儿删 / 宽限期 / TTL / retentionDays 覆盖 / refs 按 TTL /
  空容器回收但保留非空 `.pilotdeck` / 主目录级 / 目录不存在）；`sessionCleanup.test.js` +3 条（删缓存并回收空容器 /
  保留 skills / 无缓存时 false）。
- 结果：`ui` → **176 files / 1358 tests**，其中 1 条 `adminUsers.test.js` 自连 flake 失败，单跑 17 条全绿（同上一轮已知 flake）。
  `tsc -p ui` ✅。
- 未提交。

### 2026-11-12 · D14：删会话补齐侧车目录 / 回退备份 / 子任务 transcript

- 审计结论：删会话原来只清 transcript、inbox 批次、战创伤 case、`.pilotdeck/tool-results`，
  留下三类"删了还在"的东西：
  1. `<chats>/<会话>/`（`file-history` 编辑前备份 + `subagents` 子代理 transcript）；
  2. `<chats>/.rewind-backups/<会话>.<时间戳>.jsonl` —— 每次回退都写一份**整份对话**，
     实测 11 份 / 6.1 MB，无上限无 TTL（隐私 + 空间双风险，最大单份 2.0 MB）；
  3. 子任务会话的 transcript 在 `<父会话>/subagents/` 下，而删除接口把
     `relativeTranscriptPath` 丢掉了（`projects.js` 形参写成 `_options`），真删会删错位置。
- 改动：
  1. `sessionCleanup.js` 增加第 5 类 `sessionDir`（整目录删 `<chats>/<会话>/`）与
     第 6 类 `rewindBackups`（按 `<slug>.` 前缀精确匹配，不动别人会话的备份，删空后收掉目录）；
     并消费 `relativeTranscriptPath`：必须是 chat 目录内的 `.jsonl`，否则抛
     `INVALID_TRANSCRIPT_PATH`，绝不"猜一个位置删掉"。
  2. `projects.js` 的 `deleteSession` 不再吞掉 options，把 `relativeTranscriptPath` 透传下去。
  3. 新增 `ui/server/services/rewindBackupRetention.js`：启动跑一次 + 每 6 小时一次；
     **每会话只留最近 3 份**（按文件名里的时间戳排序，不依赖 mtime）+ **30 天过期**；
     清空后收掉 `.rewind-backups`；`index.js` 启动时接上 `startRewindBackupRetention()`。
- 数据清理：对 `users/1` 实跑 → 删 3 份 / 861 KB（`web:s_072f…` 4→3、`web:s_e98d…` 5→3），
  剩余 8 份 / 5.3 MB 均在保留策略内。
- 测试：`rewindBackupRetention.test.js` 7 条（文件名解析 / 每会话留 3 / 会话间互不影响 /
  30 天过期 / keep 覆盖 / 空目录回收 / 目录不存在）；`sessionCleanup.test.js` +4 条
  （侧车目录 / 只删本会话回退备份 / 子任务相对路径 / 拒绝越界路径）。
- 顺带修掉一个**既有**隐患：`sessionId` 之前不校验是否单段路径，`DELETE /sessions/..`
  （或 `%2e%2e`）会让 `path.join` 跳出会话目录，而接下来就是 `fs.rm(recursive)`。
  现在 `..`、`.`、含 `/` `\` 的 sessionId 一律 `INVALID_SESSION_ID`，删除路由回 400。
- 结果：`ui` → **177 files / 1370 tests passed**；`tsc -p ui` ✅。
- 未提交。

### 2026-11-12 · D15：删会话补齐 scratch 工作目录与记忆库 L0

- 逐项审计后还发现两类没被清：
  1. `<工作区>/scratch/work/<safeSegment(会话ID)>/` —— 本会话所有轮次的中间产物。
     正常回合结束会被 `scratchTurnCleanup` 删，但"没删成"的残留会一直留到 7 天 TTL。
  2. **记忆库 L0**：`<home>/memory/<类型>/<项目>/control.sqlite` 的 `l0_sessions`
     按 `session_key` 存**原始对话消息**。删会话以前完全不动它 →
     "会话删了，原文还在库里"。实测 `users/1` 里已有 **15 个已删会话的孤儿 session_key / 17 行**。
- 改动：
  1. `sessionCleanup.js` 增加第 7 类 `scratchWork`（映射函数与
     `AgentLoop.safeWorkPathSegment` 逐字符一致，有单测锁住）。
  2. 新增 `ui/server/services/sessionMemory.js`：
     - `purgeSessionMemoryRows()`：删会话时删 `session_key IN (id, id || '.pre-rewind')`；
       记忆库不存在 / 无表 / 文件损坏都只记日志，不让删会话半途而废；
     - `purgeOrphanSessionMemory()` + `startSessionMemorySweep()`：每天扫一次，
       删掉 transcript 已不存在的 L0 行（覆盖本功能上线前删除的会话与绕过接口的删除）。
  3. `projects.js` 的 `deleteSession` 在文件清理后调用记忆清理，返回里带 `memoryRows`。
  4. `index.js` 启动时接上 `startSessionMemorySweep()`。
- 数据清理：对 `users/1` 实跑 → 删 **17 行 / 15 个 session_key**（约 20 KB 原文 JSON）；
  复扫结果 **0 孤儿**。
- 记忆边界（写进设计书 §8.7.2）：L0（原文）与会话同生共死；L1/L2（提炼结论）
  是按项目存的长期记忆，删会话不动，要清走"清空项目记忆"。
- 测试：`sessionMemory.test.js` 7 条（只删本会话 / 含 `.pre-rewind` / 无库 / 无表 /
  非法项目 / 库损坏 / 孤儿扫描）；`sessionCleanup.test.js` +2 条（scratch 工作目录 /
  不碰别的会话）。
- 结果：`ui` → **178 files / 1379 tests passed**；`tsc -p ui` ✅。
- 未提交。

### 2026-11-12 · D16：删会话补齐回退影子 transcript（`.pre-rewind`）

- 审计最后一轮发现：`rewindSession` 早期把回退前的**整份对话**另存成
  `<chats>/<会话>.pre-rewind.jsonl`；对影子会话再回退还能叠出 `.pre-rewind.pre-rewind.jsonl`。
  会话列表靠 `isRecoveryArtifactSessionKey` 把它们当"恢复残留"藏起来，所以
  **界面上看不见，删会话也不会碰** —— 实测 `users/1` 里还有 **6 个影子文件 / 约 1.2 MB**，
  分布在 4 个项目。
- 改动：`sessionCleanup.js` 第 1 类之后增加 1a/1b —— 一次 `readdir(chatDir)`，
  按「同前缀 + 名字含 `pre-rewind`」删；`deleted.rewindShadows` 单独回报。
  `readdir` 只读一层 → 不会误伤 `<父会话>/subagents/`、`.rewind-backups/`，
  也不会碰 `<会话>-2.jsonl` 这种同前缀的别的会话（有单测）。
- 测试：`sessionCleanup.test.js` +2 条（删两层影子 / 不碰同前缀会话）→ 该文件 20 条。
- 顺带补上「运行中删除」：`DELETE /api/projects/:projectName/sessions/:sessionId` 在真正删文件前，
  若 `isSessionActiveViaGateway(sessionId)` 为真就先 `abortViaGateway` 掐掉这一轮。
  否则网关会在删除之后继续往 transcript / `scratch/work` / L0 写，会话"删了又冒出来"。
  取消失败只记日志不阻断删除。
- 结果：`ui` → **178 files / 1381 tests passed**；`tsc -p ui` ✅。
- 未提交。

### 2026-11-12 · D17：孤儿 case 目录清理 + 记忆边界定稿

- 决策：**L1/L2 提炼记忆保留**（按 `source_session_key` 精确删的方案否掉：结论可能已融合多会话）。
- 数据清理：`users/1` 下 `memory/trauma_med/<项目>/cases/` 里 **16 个孤儿 case 目录 / 2.68 MB**
  （对应会话早已删除、`chats/` 里没有 transcript，界面上无法进入）→ 已整目录删除；
  删后 `cases/` 只剩 8 个活会话的目录。
- 文档：设计书新增 **§8.7.3 删一个项目到底删什么**（归档语义 + 4 类删除 + 6 类保留 + 3 条待补）。
- 未提交。

### 2026-11-12 · D18：已归档账号的展示 / 恢复 / 到期清理

- 背景：删账号是软删除（行留着、home 搬到 `archives/users/`），但只能删不能看、不能回滚，
  归档也永不释放。
- 后端：
  - `services/archivedUsers.js`：`archivedStamp()` / `parseArchivedHome()`（互为逆运算，
    `<id>-` 横必须有，防止用户 1 吞掉用户 12）、`listArchivedHomes()`、`findArchivedHome()`、
    `getArchivedUserMaxAgeDays()`（读 `multiUser.retention.archivedUserMaxAgeDays`，默认 30）。
  - `services/archivedUsersRetention.js`：启动跑一次 + 每天一次；过期删目录 → 删账号行
    （session_names / push_subscriptions / user_notification_preferences / api_keys / user_credentials）；
    已恢复、活跃 home 已存在、目录删失败三种情况一律跳过。
  - `database/db.js`：新增 `userDb.purgeUser(id)`（事务内清 5 张依赖表 + users 行）。
  - `routes/adminUsers.js`：`GET /users` 增加 `archived` / `archivedAt` / `expiresAt` 与顶层
    `archivedUsers`；新增 `POST /users/:id/restore`（409 `HOME_EXISTS` / 404 `NOT_ARCHIVED`，
    恢复后 `token_version + 1` 并写审计 `user.restore`）；删除路由改用共享 `archivedStamp()`。
  - `index.js` 接线 `startArchivedUsersRetention()`。
- 前端：用户管理页主表过滤归档账号，新增「已归档账号」区块（用户名/角色/归档时间/到期时间/占用/恢复），
  恢复走二次确认；`api.admin.restoreUser`、hook 增加 `archivedUsers` 与 `restoreUser`；
  错误码 `HOME_EXISTS` / `NOT_ARCHIVED` 本地化；删除确认文案改成"归档 30 天后自动清除"。
- 测试：`archivedUsers.test.js` 9 条、`archivedUsersRetention.test.js` 7 条、
  `adminUsers.test.js` +5 条、`UsersSettings.test.tsx` +1 条。
- 结果：`ui` → **180 files / 1403 tests passed**；`tsc -p ui` ✅。
- 未提交（服务端改动需重启才生效）。

### 2026-11-12 · D19：删项目改真删 + 存储页收敛为项目视角

- 用户决策：项目归档这套"删了还在盘上占 30 天"的设计**整体下线**。
  - 侧边栏「删除项目」和存储页「删除项目」都变成**物理删除**；
  - 不再有归档 tab、不再留 `archives/projects`、不再有整包回收站（`.trash/groups`）；
  - 存储页保留**只读预览**（要能点开看"这 300 MB 是什么"）；
  - 破坏性操作前必须**输入项目名确认**；
  - 历史归档存量随本次上线**直接清掉**。
- 后端：
  - `utils/projectDelete.js`：`archiveAndDeleteProjectStorage()` → `purgeProjectStorage()`，
    真删 5 处（workspace / projects 类型目录 / 旧扁平 projects / memory / always-on），
    失败抛 `PROJECT_PURGE_FAILED` 并带 `stage` + `target`。
  - `projects.js#deleteProject(name, {force, confirmName})`：先校验手打名字（不符 400
    `CONFIRM_MISMATCH`）→ 掐运行中的 turn → 删网关 cron → 真删磁盘 → 清 `session_names`。
  - `routes/storage.js`：只剩 `GET /`（项目视角快照）与 `GET /preview`（只读）；
    删掉 `/delete`、`/trash*`、`/trash/groups*` 与 `deleteStorageTargets` / `groupTrash`。
  - `services/legacyProjectArchives.js`：启动清 `archives/projects` 与 `.trash/groups`，
    **不碰 `archives/users`**；`src/pilot/retention.ts` 移除 `pruneArchives` 与 `archiveMaxAgeDays`。
- 前端：
  - `StorageV2.tsx` 重写：四格总量 + 项目表格（类型/会话/占用/回收站/最后活动）
    + 展开看 exports/inbox/scratch 与只读文件树 + [删除项目]（输入项目名）。
  - `AppShellV2` 的「删除项目」弹窗加同名输入框，确认按钮在名字匹配前禁用；
    文案改成"工作区、对话、记忆、回收站全部永久删除"。
  - `api.deleteProject(name, {force, confirmName})`。
- 测试：`storage.test.js` 重写（项目快照 + 预览路径校验）、`StorageV2.test.tsx` 重写 5 条、
  新增 `projectDelete.test.js` 4 条、`legacyProjectArchives.test.js` 4 条、
  `storage.trash.test.js` 迁为 `services/trash.test.js`（9 条，去掉整包/存储页删文件）。
- 未提交；**服务端改动需重启才生效**。

### 2026-11-12 · D20：删项目弹窗收口 + 登录态到期体验

- 删项目弹窗（存储页 + 侧边栏）只留一句结论：`永久删除项目「X」？` + `这一步直接从磁盘删除，且无法恢复。`，
  不再罗列会话数 / 文件数 / 回收站清单 —— 该看的在展开的目录树里已经能看到。
- 登录态：排查"点战创伤医学就掉登录" → 不是该页面的问题，是 **7 天 JWT 到期**。
  日志里同一账号出现两枚 token：旧 token `iat=11-04 11:37 / exp=11-11 11:37`，
  点击发生在 11-12 21:06（已过期 33 小时），首个请求拿到 `401 INVALID_TOKEN`，
  前端 `authenticatedFetch` 按"会话结束"清掉登录态；随后用户重新登录（21:06:34 / 21:06:55）。
  `auth.db` 里 admin 的 `token_version` 仍是 7，说明**不是被踢下线**。
- 改动（前端，纯体验层）：
  - `auth/utils.ts` 新增 `readJwtExpiryMs()` / `isJwtExpired()`（只解码不验签）；
  - `AuthContext` 启动时先判 `exp`：已过期就直接按会话结束处理（写明"登录已失效"），
    **不再拿过期 token 去打一次必然 401 的请求**；
  - 新增"回到前台静默续期"：`visibilitychange` / `focus` 时若剩余寿命 < 24h，
    发一个轻量 `/api/auth/user`，借服务端的 `X-Refreshed-Token` 续期。
    长期挂着的标签页不会再"下一次点击才突然过期"。
- 测试：`auth/utils.test.ts` 5 条；`AuthContext.test.tsx` +2 条（过期不请求 / 前台续期）。
- 结果：`ui` → **183 files / 1413 tests passed**；`tsc -p ui` ✅。
- 未提交。

### 2026-11-12 · D21：`.pilotdeck` 整目录 14 天 TTL + 存储页不显示隐藏项 + 目录清单对齐工作区

- 用户要求（三条）：
  1. `.pilotdeck` 的**所有**内容都加 14 天 TTL（此前只有 `tool-results/` 有，`plans/` 无限留存）；
  2. 存储页不再显示 `.pilotdeck` 目录下的内容；
  3. 存储页每个项目展开后的目录，改成与**工作区页**一致 —— 三个规定目录 + 用户自建目录。
- 后端：
  - `services/toolResultsRetention.js` 重写：`findToolResultsRoots()` → `findPilotdeckRoots()`，
    返回 `{dir, scope}`：`<home>/workspaces/**/.pilotdeck` = `workspace`（**整目录都管**），
    `<home>/.pilotdeck` = `home`（只清 `tool-results`，因为单用户模式下它就是应用主目录本身）。
  - `sweepToolResults()` 保留原逻辑（孤儿 1 小时宽限 + TTL，`refs/` 只走 TTL）；
    新增 `sweepSiblings()`：`tool-results` 之外的任何子项（`plans/`、自建目录…）只按 TTL 删。
    `CONFIG_ENTRY_NAMES = {skills, commands, mcp.json, settings.json}` 不删（人工配置，非过程数据）。
    删空后依次收掉 `tool-results/` 和空的 `.pilotdeck/`。
  - TTL 沿用 `workspace.quota.toolResultsTtlDays`（默认 14），`startToolResultsRetention()` 签名不变，
    `index.js` 无需改。
  - `routes/storage.js#scanFiles()`：从"只跳过根级 `.trash`"改成**任何层级 `.` 开头一律跳过**
    （`.pilotdeck` / `.trash` / `.usage.json` / `.pinned`），既不进文件列表也不计入占用。
  - `routes/storage.js` 新增 `DEFAULT_TOP_LEVEL_DIRS = ['inbox','exports','scratch']` 与
    `readTopLevelFolders()`，项目条目多一个 `folders: [{name,fileCount,sizeBytes}]`：
    三个默认目录永远在（即使不存在/为空），再并入磁盘上的非隐藏顶层目录（空的自建目录也列）。
- 前端 `StorageV2.tsx`：
  - 删掉 `groupByTopLevel()`，改用后端 `folders`（缺字段时按文件路径兜底 + 补三个默认目录）；
  - 展开项目后是**目录行**（chevron + 目录图标 + 目录名 + 一句说明 + `N 个 · 大小`），
    点目录才展开该目录的文件列表，空目录显示"空目录"；
  - 顶部保留一行用量摘要，回收站条数/体积单独一行提示。
- 测试：
  - `toolResultsRetention.test.js` 5 → **14 条**（`plans/` 过期删除、自定义项删除、`skills/`+`mcp.json`
    60 天不删、清空后 `.pilotdeck` 被收掉、主目录级只清 `tool-results`）；
  - `storage.test.js` 5 → **8 条**（`.pilotdeck` 不进 `files[]`/不计占用；`folders` = 三个默认 + 自建，
    含空的 `scratch`、顶层散落文件也有一行）；
  - `StorageV2.test.tsx` 5 → **7 条**（目录默认折叠、空目录提示、自建目录分组、隐藏目录兜底不显示）。
- 结果：`ui` → **183 files / 1423 tests passed**；`tsc -p ui` ✅；`eslint` ✅；根 `tsc` ✅；根 `npm test` → 897 条、0 失败。
- 未提交；**服务端改动需重启才生效**。
