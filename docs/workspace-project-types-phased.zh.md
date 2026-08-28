# 系统内项目 + 项目类型改造 — 分期实现清单

/status: **P0–P7 已完成（P7.1 除外）；下一步 P8**（设计已定案，按阶段推进；每阶段必须自测通过后再开下一阶段）

日期：2026-08-27

相关文档：

- 文件布局（已实施）：`[workspace-layout-reorg.zh.md](./workspace-layout-reorg.zh.md)`
- 记忆与附件：`[memory-attachment-flow-guide.zh.md](./memory-attachment-flow-guide.zh.md)`
- 系统提示词结构（中文试用）：`[system-prompt-anatomy.zh.md](./system-prompt-anatomy.zh.md)`

---

## 0. 定案摘要（实现时勿偏离）


| 项            | 定案                                                                                             |
| ------------ | ---------------------------------------------------------------------------------------------- |
| general 虚拟项目 | **取消**（P2）；必须先建项目才能聊天                                                                          |
| 创建项目         | 填写**名称** + **项目类型**（通用医学 / 战创伤医学）；**不再选外部路径**                                                  |
| 类型           | 创建后**不可改**；侧栏两个 Tab 按类型列出项目与 session（P3）                                                       |
| 类型目录键        | `general_med` / `trauma_med`（避免与旧虚拟 id `general` 撞名）                                           |
| 存储           | 会话 / 文件 / 项目记忆均在 `$PILOT_HOME`；按类型分子目录（见 §0.1）                                                 |
| 文件根          | `$PILOT_HOME/workspaces/<typeKey>/<projectId>/`；**不做外置文件根**                                    |
| 内部 id        | `<typeKey>-<suffix>`；展示名可中文                                                                    |
| 项目记忆         | `$PILOT_HOME/memory/<typeKey>/<projectId>/`（**直接用 projectId**，不用 hash）；用户画像仍在 `memory/global/` |
| 删项目          | 会话 + 项目记忆删除；文件归档保留                                                                             |
| 技能范围         | 仅**全局 + 类型级**；内嵌医学技能按附录 C 矩阵；自创技能归属编辑属 P6                                         |
| 旧「添加本地路径项目」  | **下线废弃**（P8）                                                                                   |


符号约定：

- `$REPO` = Git 仓库根  
- `$HOME` / `$PILOT_HOME` = Pilot 家目录（**不是**系统用户 `~`）  
- `typeKey` = `general_med`  `trauma_med`  
- `$WS` = `$HOME/workspaces/<typeKey>/<projectId>/`



### 0.1 类型化目录布局（P0 细则，2026-08-27 修订）

```text
$PILOT_HOME/
  projects/
    general_med/
      general_med-<suffix>/     # meta.json, .cwd → $WS, chats/
    trauma_med/
      trauma_med-<suffix>/
  workspaces/
    general_med/
      general_med-<suffix>/     # inbox, exports, scratch
    trauma_med/
      trauma_med-<suffix>/
  memory/
    global/                     # 用户画像，不按类型拆
    general_med/
      general_med-<suffix>/     # 项目记忆（control.sqlite + memory/）
    trauma_med/
      trauma_med-<suffix>/
```


| meta.type（API/UI）  | typeKey（目录与 id 前缀） | 中文    |
| ------------------ | ------------------ | ----- |
| `general_medicine` | `general_med`      | 通用医学  |
| `war_trauma`       | `trauma_med`       | 战创伤医学 |


**历史残留迁移（物理搬 + 改 meta/.cwd）：**

- 已创建的 `sys-*` 系统项目：按原类型改名为 `general_med-*` / `trauma_med-*` 并迁入对应子树  
- 其余残留（旧 `workspaces/general`、路径型 `projects/Users-…`、挂在 PILOT_HOME 上的 chats、旧 `memory/workspaces/<hash>` 等）→ **一律归入通用医学**  
- 旧 general 虚拟对话 → **收成一个**系统项目（如展示名「历史通用对话」、id `general_med-legacy-…`）  
- 脚本：`node scripts/migrate-typed-projects.mjs [--pilot-home PATH] [--dry-run]`（幂等）

---



## 1. 实施原则（保证系统始终可用）

1. **一次只做一个阶段**；阶段内可拆 PR，但合入前必须完成本阶段自测清单。
2. **先加能力、再切入口、最后删旧路**：例如先支持「系统内项目 + 类型」，侧栏仍能打开旧数据；再关 general / 关选路径；最后清遗留 API。
3. **每阶段结束时**：`npm run build`（或现场等价构建）+ 启动 + 手工冒烟通过；有回归测试的模块一并跑。
4. **不在同一提交里**同时大改：侧栏信息架构 + 技能过滤 + 删除归档 + 去掉 general。
5. 旧会话若仍挂在「原 general / 原路径项目」上：迁移或「只读可见」策略在 **P0/P1** 写清，避免用户一升级就打不开历史。

推荐环境变量（调试用，可选，实现时再定名）：

- `PILOTDECK_ALLOW_LEGACY_GENERAL=1`：过渡期临时允许 general（仅开发）  
- 正式交付默认关闭

---



## 2. 阶段总览


| 阶段       | 主题                          | 用户可见变化                                 | 风险    |
| -------- | --------------------------- | -------------------------------------- | ----- |
| **P0**   | 项目元数据模型 + 系统内创建 API         | 可创建带类型的系统内项目；旧入口暂可并存                   | 低     |
| **P1**   | 身份统一：gateway key = 系统项目 id  | 会话/记忆绑 id；文件仍走 `$WS`（`<typeKey>/<id>`） | 中     |
| **P2**   | 去掉 general + 创建必选类型 + 禁聊空项目 | 必须建项目才能聊                               | 中     |
| **P3**   | 侧栏：通用医学 / 战创伤医学             | Tab 与列表按类型分组                           | 中（UI） |
| **P4**   | 类型人设（系统提示词）                 | 同模型下两套助手角色                             | 低～中   |
| **P5**   | 技能：类型范围（内嵌）                 | 两类型仅显示并读取各自 med-tools Skill            | 中     |
| **P6**   | 技能：类型归属（现有 Skills 页）     | 左栏按归属分三组，可改项可拖拽；解析 MCP 跟 `med-medical` 走 | 中     |
| **P7**   | 删除：会话+记忆删，文件归档              | 删项目行为符合定案                              | 中     |
| **P7.1** | （后续）工作区/归档磁盘占用管理页           | 可查看并手动清理 `$WS` 与 archives 占用（暂不实现）     | 中（UI） |
| **P8**   | 下线关联仓入口与遗留文案                | 产品面干净                                  | 低     |
| **P9**   | 文档 / 迁移说明 / 回归清单收口          | 交付可复制                                  | 低     |


**依赖顺序：** P0 → P1 → P2 → P3；P4 可与 P3 并行但建议 P3 后做；P5 → P6；P7 宜在 P1 稳定后；**P7.1 磁盘管理页不阻塞主线，可在 P7 后任意插入**；P8 最后；P9 贯穿但终检在末尾。

---



## 3. 分阶段详单



### P0 — 项目元数据与「系统内创建」

/status: **P0.1 已完成（2026-08-27）** — 新建走 `general_med` / `trauma_med` 分型布局；迁移脚本已落地并可幂等重跑。

**目标：** 引入项目类型与注册表，创建时不再要求用户选路径；磁盘上为每个项目准备好按类型分桶的 `$WS`、会话目录与项目记忆。

**已实现（P0 + P0.1）：**

- `POST /api/projects/create-system`：`displayName` + `type`（`general_medicine` | `war_trauma`）
- UI：侧栏「+」→ 名称+类型对话框；「从本地路径添加（旧）」仍可用
- id：`general_med-<suffix>` / `trauma_med-<suffix>`
- 目录：`projects|workspaces|memory` / `<typeKey>` / `<projectId>`
- 迁移：`node scripts/migrate-typed-projects.mjs [--pilot-home PATH] [--dry-run]`

**P0.1 目标布局：** 见 §0.1。

**自测（P0.1）：**

- [x] 新建通用医学 → id 形如 `general_med-…`，目录在 `projects/general_med/…`、`workspaces/general_med/…`（记忆目录可在首次记忆写入时创建）  
- [x] 新建战创伤 → `trauma_med-…` 与对应子树  
- [x] 跑迁移脚本后：原 `sys-*` 已改名前缀；旧 general/路径残留进入 `general_med`；用户画像仍在 `memory/global`  
- [x] 迁移后打开原会话/文件仍可用（或明确在「历史通用对话」项目下）— 需 UI 冒烟确认

**不做（仍属后续阶段）：** 改侧栏 Tab 文案；强制删 general 入口（P2）；技能过滤；删除归档语义。

---



### P1 — 路径与身份统一（系统项目 id）

/status: **已完成（2026-08-27）** — gateway key = 系统项目 id；cwd/文件仍 `$WS`；记忆不再写 `memory/workspaces/<hash>`。

**目标：** 会话、记忆、Gateway runtime 全部以**系统项目 id** 为身份键；文件读写仍走 `$WS`。不再用外部绝对路径（关联仓 / 旧路径项目 cwd）当 gateway key。

**前置（P0.1 已满足，P1 勿重做）：**

- id 形态：`general_med-*` / `trauma_med-*`（不再出现新建 `sys-*`）
- 物理布局见 §0.1：`projects|workspaces|memory/<typeKey>/<projectId>/`
- 目录解析复用：`resolveTypedProjectDir` / `resolveWorkspaceDataRoot` / `resolveTypedProjectMemoryDir`
- `.cwd` 继续指向 `$WS`（用于 `$WS → id` 反查）；**不要**为了改身份键去改布局层

**身份契约（实现时写死）：**


| 用途                           | 键 / 路径                                              |
| ---------------------------- | --------------------------------------------------- |
| Gateway / session / 项目记忆 key | **系统项目 id**（如 `general_med-…`）                      |
| Agent cwd、上传、文件树、exports     | `$WS` = `$HOME/workspaces/<typeKey>/<projectId>/`   |
| 会话落盘                         | `$HOME/projects/<typeKey>/<projectId>/chats/`       |
| 项目记忆落盘                       | `$HOME/memory/<typeKey>/<projectId>/`（不用 path hash） |
| `.cwd`                       | 仍写 `$WS`；关联仓路径**不参与身份**（可读附加工作目录可另议，入口下线属 P8）       |


**范围：**

- 改 `resolveGatewayProjectKey`：对系统项目返回 **id**，不再返回 `$WS` / 关联仓绝对路径  
- 同步 `resolveWorkspaceId` / `resolveAgentCwd` / `resolveProjectStorageId`：裸 id 优先按 typed id 解析，禁止 `path.resolve(裸 id)` 落到错误相对路径  
- `listWebProjects` / `getProjects` / gateway `listSessions`：对外 `projectKey` 以 id 为准；`fullPath` 可继续暴露 `$WS` 给文件 API  
- 补齐仍只扫**平铺** `projects/`* 的遗漏点（如 session 全量列表、聊天搜索、bridge session 索引），一律走嵌套 `<typeKey>/<id>`  
- 双份 helpers 同步：`src/pilot/paths.ts` ↔ `ui/server/utils/pilotPaths.js`  
- 更新 `tests/pilot/workspace-paths.spec.ts` 等契约（今日仍有「gateway key === `$WS`」旧断言）

**不做：** 强制关掉 general UI（P2）；技能类型过滤（P5）；重写 create/migrate 布局；复活 `sys-`* 或 flat `projects/<id>/` 假设。

**自测：**

- [x] 在新系统项目中发一轮消息 → jsonl 落在 `$HOME/projects/<typeKey>/<id>/chats/`；刷新后消息仍在  
- [x] 上传附件 → 仅 `$WS/inbox/<batch>/`（已在 `general_med` / `trauma_med` 项目下冒烟确认）  
- [ ] 文档 skill 产物 → `$WS/exports/`  
- [x] 项目记忆写入 `$HOME/memory/<typeKey>/<id>/`；虚拟 general 归入 `general_med-legacy-general`（不再写 `memory/workspaces/<hash>`）  
- [x] 侧栏打开迁移后的系统项目，上传/提问可用  
- [x] 路径单测：`resolveGatewayProjectKey($WS|id) === id`，`resolveAgentCwd(id) === $WS`；create/migrate 回归通过  
- [x] `npm run build` + 完整 UI 冒烟（含发消息落 chats、exports；重启后确认记忆不再写 `memory/workspaces/`）通过  

**回滚注意：** 本阶段改 key 算法时，旧绝对路径输入须能映射回 id（`.cwd` 反查或迁移元数据）；见附录 A。

---



### P2 — 取消 general，强制先建项目

/status: **已完成（2026-08-27）** — 已去掉 virtual `general` 注入；无项目空态引导创建；侧栏不再默认 General Tab。

**目标：** 无项目时不能进入聊天主流程；引导创建项目。

**范围：**

- 启动 / 进主界面：无 active 项目 → 空态 +「创建项目」  
- 移除或隐藏 general 虚拟项目注入  
- 创建表单：**名称 + 类型必填**  
- 迁移项目 `general_med-legacy-general`（「历史通用对话」）仍作为普通系统项目可见可聊

**不做：** 侧栏 Tab 改成两个医学类型（P3）；删关联仓按钮可延后到 P8。

**自测：**

- [ ] 清空/无项目状态下打开 UI → 无法发送聊天，有明确引导  
- [x] 创建一个项目后可正常开 session、发消息  
- [x] 不再出现名为 general 的默认可聊项  
- [x] 若磁盘有 `general_med-legacy-general`，侧栏仍可见且可聊  

---



### P3 — 侧栏信息架构（通用医学 / 战创伤医学）

/status: **已完成（2026-08-27）** — Tab 改为「通用医学 / 战创伤医学」；列表按 `projectType`（及 id 前缀回退）过滤；列表头改为「新建项目」；项目行提供打开文件面板入口。

**目标：** SidebarV2 原「项目 / 通用」改为「通用医学 / 战创伤医学」；各自下列该类型项目与其 sessions。

**范围：**

- Tab 文案与 `aria`  
- 列表按 `meta.type` 过滤  
- 当前选中项目切换时 session 列表正确  
- 空类型下列空态（「暂无项目，去创建」）  
- 列表头仅保留「新建项目」；项目行「文件」入口（打开 Files 面板），顶栏「文件」按钮迁出

**不做：** 人设文案（P4）；技能过滤（P5）。

**自测：**

- [x] 两侧各至少一个项目时，Tab 切换只显示对应类型  
- [x] 在 A 类型项目下的 session 不会出现在 B 类型 Tab  
- [ ] 移动端侧栏同样正确（若适用）  
- [x] 现有 Sidebar 相关单测更新并通过  
- [x] 侧栏项目行可打开对应项目文件列表；顶栏不再放「文件」按钮  

---



### P4 — 项目类型人设（系统提示词）

**目标：** 通用医学 / 战创伤医学使用不同角色说明，使助手行为可区分。

**状态：已完成（2026-08-28）。**

- 两套完整 01 prompt 模板位于 `src/context/prompt/systemPromptCopy.ts`
- 每轮按类型化 cwd 选择通用医学 / 战创伤医学人设；未知或旧工作区按通用医学处理
- 类型不可变 → 人设不随中途切换（无切换入口）
- 两套人设各含「适用范围与引导」段：问到另一类型的问题时仍尽力作答，同时提示用户新建对应类型项目的对话可获得更好答案（同一话题只提示一次，不得拒答）

**不做：** 技能可见性（P5）。

**自测：**

- [x] 同模型下，在两类型项目各问一句「你是谁/你擅长什么」→ 回答角色明显不同
- [x] 切换项目后新 session 使用对应人设；旧 session 不要求改写历史

---



### P5 — 内嵌技能类型范围（第一期矩阵）

**状态：已完成（2026-08-28）。** 内嵌 med-tools 技能与对应 MCP 工具按项目类型过滤；办公五件套两类型均可见。自创技能归属仍属 P6。

**策略源：** `src/pilot/projectTypePolicy.ts`（Skill 与 MCP 两张表；非 med-tools 一律放行）。

**内嵌医学 Skill 归属：**

| Skill | 通用医学 | 战创伤医学 |
| --- | --- | --- |
| `med-medical` | ✓ | ✓ |
| `med-case-report` | ✓ | — |
| `med-trauma-assist` | — | ✓ |
| `med-trauma-stage-plan` | — | ✓ |

**MCP 工具归属**（与 Skill 对齐；`med_tools_health` 两端都保留）：

| MCP 工具 | 通用医学 | 战创伤医学 |
| --- | --- | --- |
| `mcp__med-tools__med_parse_medical` | ✓ | ✓ |
| `mcp__med-tools__med_tools_health` | ✓ | ✓ |
| `mcp__med-tools__med_trauma_rag_query` | — | ✓ |
| `mcp__med-tools__med_trauma_rag_status` | — | ✓ |
| `mcp__med-tools__med_trauma_stage_plan` | — | ✓ |

**过滤落点（同一套函数）：**

| 表面 | 文件 | 行为 |
| --- | --- | --- |
| Agent `<available-skills>` | `PromptAssembler.buildSystemContext` | 按类型化 cwd 过滤技能目录 |
| `read_skill` 列举 / 加载 | `createLocalGateway` | 隐藏技能按名称也读不到 |
| Skills 管理页面 | `SkillManager` / `SkillsV2` | P6 起全量读取并按归属分三栏；对话可见性仍按类型过滤 |
| 发给模型的 tools schema | `AgentLoop` | 通用医学看不到战创伤 MCP |
| 工具执行 | `ToolRuntime` | 即使硬调也被 `permission_denied` |

办公五件套（`pdf` / `docx` / `pptx` / `spreadsheets` / `diagram-maker`）与其它非 med-tools 技能**两类型均可见**。用户自创（`$PILOT_HOME/skills/`）与项目实例技能（`$WS/.pilotdeck/skills/`）本阶段不过滤。

**不做：** 用户自创归属编辑 UI（P6）。

**自测：**

- [x] 战创伤项目：提示词技能目录含 `med-trauma-assist` / `med-trauma-stage-plan`；通用医学不含（`tests/context/prompt-project-type.spec.ts`）
- [x] Skills 管理页显示完整归属，Agent 与 `read_skill` 仍按类型过滤（`tests/extension/skills/skill-manager-builtin.spec.ts`）
- [x] 通用医学模型工具清单不含战创伤 RAG / 分阶段方案；执行期硬拦（`prompt-project-type` + `tests/tool/med-tools-skill-gate.spec.ts`）
- [x] 全局办公 skills 两类型都在（`isSkillAvailableForProjectType` 对非 med-tools 恒 true）

---



### P6 — 技能类型归属（现有 Skills 页）

**状态：已完成（2026-08-28）。**

**目标：** 在**现有**技能页（左列表 + 右详情，`SkillsV2`）里配置「这个技能在哪类项目对 Agent 可见」。不新开页面。左侧改为按归属分三个子列表；可改归属的技能支持拖拽换栏。

**谁可改 / 谁只展示（已定案）：**


| 技能 | 默认归属 | 详情页 | 拖拽 |
| --- | --- | --- | --- |
| 办公五件套（`builtin`：pdf / docx / pptx / spreadsheets / diagram-maker） | 全局 | 只读标签「全局」 | 否 |
| `med-medical`（DICOM / 多格式附件解析） | 全局（两类型，与 P5 默认一致） | **可改**勾选 | **可** |
| 其余 med-tools（`med-case-report`、`med-trauma-assist`、`med-trauma-stage-plan`） | 仍按附录 C | 只读标签 | 否 |
| 自创 `user`（`$PILOT_HOME/skills/<slug>/`） | 未配置时视为全局 | **可改**勾选 | **可** |
| `project`（`$WS/.pilotdeck/skills/`） | 本阶段**忽略** | — | — |


**左侧三个子列表（按归属分组，取代现在的 builtin / user / medical 分栏）：**

1. **全局技能**
2. **通用医学技能**
3. **战创伤医学技能**

每条技能只出现在**一个**子列表里（不重复）：

- 归属为全局（含「两个类型都勾」，落盘 `["global"]`）→ 只在「全局技能」
- 仅通用医学 → 只在「通用医学技能」
- 仅战创伤医学 → 只在「战创伤医学技能」

只读技能同样进对应子列表（办公 → 全局；`med-case-report` → 通用医学；两条战创伤技能 → 战创伤），但不能拖。三个子列表在 Skills 页**始终都显示**（不随当前打开的项目类型把某一栏藏掉）。Agent 提示词 / `read_skill` / 工具 schema **仍按当前项目类型过滤**。

**拖拽（仅可改归属的技能）：**

- 从子列表 A 拖到子列表 B，松手即更新归属并落盘；左侧所在栏与右侧勾选一起变。
- 拖到「全局技能」→ `["global"]`
- 拖到「通用医学技能」→ `["general_medicine"]`（不再是全局，也不再含战创伤）
- 拖到「战创伤医学技能」→ `["war_trauma"]`
- 拖到自己所在列表：无操作。只读技能不可拖起。
- 拖拽与详情勾选是同一数据：勾选变化后行移到对应子列表；拖拽后详情勾选跟上。

**勾选交互（右详情）：**

- 三个选项：**全局** / **通用医学** / **战创伤医学**。
- 「全局」与两个类型**互斥**：勾全局 → 清掉两个类型；勾任一类型 → 清掉全局。两个类型可以同时勾。
- 两个类型都勾 ≡ 全局；落盘 `["global"]`，行回到「全局技能」。
- 至少保留一项。办公 / 其余 med-tools：只显示只读标签，无勾选、无拖拽。

**MCP（已定案：跟 `med-medical` 走）：**

- `mcp__med-tools__med_parse_medical` 的模型可见性与执行许可 = `med-medical` 对当前类型是否可用。
- 其余 MCP 仍按附录 C 死表（RAG / 分阶段方案仅战创伤；不随 UI 改）。
- `med_tools_health` 保持两类型可用（体检工具，不跟解析归属走）。
- 不把 `med-medical` 的归属写进插件目录里的 `SKILL.md`（插件更新会覆盖）。

**持久化：**

- `med-medical`：`$PILOT_HOME/skill-availability.json` 覆盖表，缺省 = 附录 C（全局）。
- 自创 user：SKILL.md frontmatter `availability`（导入/复制跟着走）；缺省 = 全局。

```yaml
---
name: my-intake-note
description: …
availability:
  - general_medicine
---
```

合法值：`global` | `general_medicine` | `war_trauma`。形状只能是 `["global"]` 或 1～2 个类型。

**实现：**

- 归属模型与 med-tools 覆盖存储：`src/pilot/skillAvailability.ts`
- 策略入口：`src/pilot/projectTypePolicy.ts`
- Skill CRUD / frontmatter 写回：`src/extension/skills/SkillManager.ts`
- RPC：`skill_set_availability`；REST：`POST /api/skills/availability`
- 现有页面三栏、详情勾选、原生拖拽：`ui/src/components/main-content-v2/SkillsV2.tsx`
- 自创 skill 的 `availability` 随 PluginRuntime contribution 进入提示词过滤；修改后主动 `reloadExtensions`

**过滤：** P5 的 `isSkillAvailableForProjectType` / `isToolAvailableForProjectType` 已扩展：只读技能继续读固定矩阵；`med-medical` 与自创分别读覆盖表/frontmatter。提示词目录、`read_skill`、Agent 工具列表和执行期均生效。Skills **管理列表**按归属分三栏全量展示。

**不做：** 新页面；办公与其余 med-tools 的归属编辑或拖拽；项目实例技能的类型绑定；创建后改项目类型。

**自测：**

- [x] 左侧三栏：办公在全局；`med-case-report` 在通用医学；战创伤两条在战创伤；只读项不可拖
- [x] `med-medical` 归属可写覆盖表；`med_parse_medical` 的 schema 与执行许可同步（`tests/pilot/skill-availability.spec.ts`）
- [x] 自创 skill 的 frontmatter 归属可写回，旧无字段按全局（`skill-manager-builtin.spec.ts`）
- [x] 当前类型的提示词技能目录过滤自创 skill（`prompt-project-type.spec.ts`）
- [x] 三栏归组、至少一项、双类型归一为全局（`SkillsV2.availability.test.ts`）
- [x] 后端构建、UI 构建、相关 ESLint 与 16 个后端用例通过

---



### P7 — 删除项目：会话与记忆删除，文件归档

/status: **已完成（2026-08-27）** — 删项目：typed chats/meta + 项目记忆删除；`$WS` 归档到 `archives/projects/<id>-<ts>/`；确认文案已更新。

**目标：** 删除行为符合定案。

**范围：**

- 删项目时：  
  - 删除 `$HOME/projects/<typeKey>/<id>/chats/`（及 session 索引）  
  - 删除 `$HOME/memory/<typeKey>/<id>/`  
  - 将 `$WS`（`$HOME/workspaces/<typeKey>/<id>/`）**移动/复制**到 `$HOME/archives/projects/<id>-<timestamp>/`（名称可微调）  
  - 从项目 registry / 侧栏移除
- UI：确认文案写清「对话与项目记忆将删除；已生成文件会归档保留」

**不做（本阶段已交付部分）：** 完整「归档/工作区磁盘管理」产品页（见下方 **P7.1，暂不实现**）。本阶段仅磁盘归档 + 删除 API 返回归档路径即可。

**自测：**

- [x] 删前：有 session、有记忆条目、有 exports 文件（单测 fixture）  
- [x] 删后：侧栏无项目；chats 与项目记忆不可再加载（目录已删）  
- [x] 归档目录存在且含原 exports/inbox 内容  
- [x] 删除失败（磁盘满等）不出现「半删」无提示状态（归档失败则整体失败；后续步骤失败会带归档路径提示）  



#### P7.1 — 工作区 / 归档磁盘占用管理页（需求已登记，**暂不实现**）

/status: **待开始（仅需求）** — 挂在 P7 之后；不阻塞 P4–P6 / P8。

**入口：** 设置或侧栏提供一个按钮；点击后打开独立管理页（非聊天主流程）。

**页面展示：**

1. **在用项目** `$WS`：列出当前系统中每个项目对应的 `workspaces/<typeKey>/<id>/` 下文档（至少到文件级；可按项目分组），并显示**每个文件占用大小**、每个项目小计。
2. `archives/` **残留**：同样列出 `archives/projects/<id>-<timestamp>/` 下文档及各自大小、每个归档包小计。
3. **合计**：上述全部内容的总占用（可读单位：KB/MB/GB）。

**交互：**

- 用户可在该页**手动删除**选中的文档（或整包归档 / 某项目下的文件）；删除成功后**占用数字与合计实时刷新**。  
- 删除应有确认；失败需提示，避免静默半删。  
- 不要求本页承担「删项目」全流程（P7 已覆盖）；本页侧重磁盘清理与可见占用。

**不做（P7.1 仍可延后细化）：** 跨机器配额策略、自动清理策略、回收站二次恢复 UI。

---



### P8 — 下线关联仓 / 选路径入口

**目标：** 产品面不再出现「添加本地文件夹作为项目」。

**范围：**

- 移除或隐藏「添加项目路径」类 UI 与 API  
- 文案 / 帮助 / onboarding 残留清理  
- 代码中 `resolveLinkedRepoPath` 若仅服务旧关联仓，改为系统项目解析或删除死路径

**自测：**

- [ ] UI 无添加外部路径入口  
- [ ] 创建项目只有名称 + 类型  
- [ ] 回归：P2～P7 主路径仍通  

---



### P9 — 文档与交付收口

**目标：** 同事/服务器按文档可升级，不靠口头。

**范围：**

- 更新本清单状态与「升级步骤」  
- 简短说明：旧 general 会话如何处理（迁移或只读）  
- 与 `workspace-layout-reorg.zh.md` 交叉链接

**自测：**

- [ ] 另一人仅凭文档能在干净 `$PILOT_HOME` 上走通：建两类项目 → 聊天 → 上传 → 删项目见归档  

---



## 4. 每阶段「最小冒烟」模板（复制使用）

完成任一阶段后，至少执行：

```bash
# 1) 构建
npm run build

# 2) 启动（按现场脚本）
./scripts/stop-local.sh && ./scripts/start-local.sh
# 模型检查失败时仅调试可用：SKIP_LLM_CHECK=1 ./scripts/start-local.sh

# 3) 按该阶段「自测」勾选

# 4) 若本阶段改了 TS 路径/网关：相关 node:test / vitest 跑通
```

**停止条件：** 任一项自测失败 → 修当前阶段，**禁止**开启下一阶段。

---



## 5. 明确不在本期做的事

- 外置文件根 / 关联仓存上传与 exports  
- 附加只读资料目录（可作为**以后**可选增强，单独立项）  
- 项目实例级技能绑定  
- 创建后修改项目类型  
- 保留 general 虚拟聊天  
- 删项目时把文件一并物理删除（定案为归档）  
- 把 `plugins/med-tools` 合并进根目录 `skills/`

---



## 附录 A — 旧数据过渡（P1/P2 必读）

**P0.1 已做（物理迁移，可幂等重跑）：**

- `sys-*` → `general_med-*` / `trauma_med-*` 并入 `projects|workspaces/<typeKey>/…`
- 旧 `workspaces/general` + home-slug chats → 单一系统项目 `general_med-legacy-general`（展示名「历史通用对话」）
- 旧路径型项目 → 归入 `general_med`（保留 `legacyLinkedPath` 元数据；**身份已是系统 id**）
- 用户画像仍在 `memory/global/`

脚本：`node scripts/migrate-typed-projects.mjs [--pilot-home PATH] [--dry-run]`

现网可能仍有（P1/P2 需兼容，勿静默删除）：

- 运行期再次创建的 `$HOME/workspaces/general/`（旧 general 虚拟路径在 P2 关掉前可能被 `ensureWorkspaceLayout` 重建；**真实历史文件已在 legacy 项目** `$WS`）
- API/UI 仍传入的**绝对路径** projectKey（迁移前缓存、旧前端、关联仓路径）

建议策略（P1 写死）：

1. **推荐：** `resolveGatewayProjectKey` 对绝对路径做 `.cwd` / 迁移元数据反查 → 系统项目 id；会话继续读 `projects/<typeKey>/<id>/chats/`。P2 再关 general 入口。
2. **可接受补充：** 无法反查的裸路径仅只读告警，不写入新 session。

禁止：无说明地直接删用户 chats。

---



## 附录 B — 阶段状态跟踪


| 阶段   | 状态           | 完成日期       | 备注                                                                               |
| ---- | ------------ | ---------- | -------------------------------------------------------------------------------- |
| P0   | **P0.1 已完成** | 2026-08-27 | 系统内创建 + 类型化嵌套布局 + `migrate-typed-projects`；侧栏 Tab/去 general 仍属后续                 |
| P1   | **已完成**      | 2026-08-27 | gateway key = 系统项目 id；cwd/文件仍 `$WS`；嵌套扫描已补；记忆归 typed 目录                          |
| P2   | **已完成**      | 2026-08-27 | 取消 virtual general；无项目不可聊；引导创建                                                   |
| P3   | **已完成**      | 2026-08-27 | 侧栏 Tab：通用医学 / 战创伤医学；列表头新建项目；项目行打开文件面板                                            |
| P4   | **已完成**      | 2026-08-28 | 按类型化 cwd 选择两套完整 01 人设；未知/旧工作区回退通用医学                                              |
| P5   | **已完成**      | 2026-08-28 | 内嵌 Skill/MCP 矩阵见附录 C；提示词目录、`read_skill`、Skills 页面与工具执行同步过滤                     |
| P6   | **已完成**      | 2026-08-28 | Skills 左栏三组（全局/通用/战创伤）+ 详情勾选；可改项可拖拽；解析 MCP 跟 `med-medical` |
| P7   | **已完成**      | 2026-08-27 | 删项目：chats+记忆删除；`$WS` → `archives/projects/<id>-<ts>/`；确认文案；**P7.1 磁盘管理页仅登记暂不实现** |
| P7.1 | 待开始（仅需求）     |            | 工作区/归档占用列表 + 手动删除 + 合计刷新；见 §P7.1                                                 |
| P8   | 待开始          |            |                                                                                  |
| P9   | 待开始          |            |                                                                                  |


---



## 附录 C — 内嵌技能与 MCP 矩阵（P5）

**Skill（`MED_TOOLS_SKILLS`）：**

| Skill | 范围 |
| --- | --- |
| 办公五件套（pdf / docx / pptx / spreadsheets / diagram-maker） | 全局（两类型） |
| `med-medical` | 通用医学 + 战创伤医学 |
| `med-case-report` | 仅通用医学 |
| `med-trauma-assist` | 仅战创伤医学 |
| `med-trauma-stage-plan` | 仅战创伤医学 |

**MCP（`MED_TOOLS`，仅 `mcp__med-tools__*` 受限）：**

| 工具 | 范围 |
| --- | --- |
| `med_parse_medical` / `med_tools_health` | 通用医学 + 战创伤医学 |
| `med_trauma_rag_query` / `med_trauma_rag_status` / `med_trauma_stage_plan` | 仅战创伤医学 |

执行期另有 skill gate（`src/tool/medToolsSkillGate.ts`）：工具可见后仍须先 `read_skill` 对应配方。类型过滤在 gate **之前**，通用医学项目里战创伤工具不会进入 gate。

P6 仅允许改 `med-medical` 的类型归属；改完后 `med_parse_medical` 跟该技能走。其余行仍是系统默认，不可在 UI 改。自创技能不进本表。