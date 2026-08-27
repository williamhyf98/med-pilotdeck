

# 系统内项目 + 项目类型改造 — 分期实现清单

/status: **P0.1 已完成；后续阶段待实施**（设计已定案，按阶段推进；每阶段必须自测通过后再开下一阶段）

日期：2026-08-27

相关文档：

- 文件布局（已实施）：`[workspace-layout-reorg.zh.md](./workspace-layout-reorg.zh.md)`
- 记忆与附件：`[memory-attachment-flow-guide.zh.md](./memory-attachment-flow-guide.zh.md)`

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
| 技能范围         | 仅**全局 + 类型级**；第一期 `med-trauma-stage-plan` → 仅战创伤                                               |
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


| 阶段     | 主题                          | 用户可见变化                                 | 风险    |
| ------ | --------------------------- | -------------------------------------- | ----- |
| **P0** | 项目元数据模型 + 系统内创建 API         | 可创建带类型的系统内项目；旧入口暂可并存                   | 低     |
| **P1** | 身份统一：gateway key = 系统项目 id  | 会话/记忆绑 id；文件仍走 `$WS`（`<typeKey>/<id>`） | 中     |
| **P2** | 去掉 general + 创建必选类型 + 禁聊空项目 | 必须建项目才能聊                               | 中     |
| **P3** | 侧栏：通用医学 / 战创伤医学             | Tab 与列表按类型分组                           | 中（UI） |
| **P4** | 类型人设（系统提示词）                 | 同模型下两套助手角色                             | 低～中   |
| **P5** | 技能：类型范围（内嵌）                 | `med-trauma-stage-plan` 仅战创伤可见/可调      | 中     |
| **P6** | 技能：自创归属 UI（多选）              | 技能页可配置全局/类型                            | 中     |
| **P7** | 删除：会话+记忆删，文件归档              | 删项目行为符合定案                              | 中     |
| **P8** | 下线关联仓入口与遗留文案                | 产品面干净                                  | 低     |
| **P9** | 文档 / 迁移说明 / 回归清单收口          | 交付可复制                                  | 低     |


**依赖顺序：** P0 → P1 → P2 → P3；P4 可与 P3 并行但建议 P3 后做；P5 → P6；P7 宜在 P1 稳定后；P8 最后；P9 贯穿但终检在末尾。

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

/status: **进行中（2026-08-27）** — 文档契约已修订；代码：gateway key → 系统项目 id，cwd 仍为 `$WS`。

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

**目标：** 无项目时不能进入聊天主流程；引导创建项目。

**范围：**

- 启动 / 进主界面：无 active 项目 → 空态 +「创建项目」  
- 移除或隐藏 general 虚拟项目注入  
- 创建表单：**名称 + 类型必填**

**不做：** 侧栏 Tab 改成两个医学类型（P3）；删关联仓按钮可延后到 P8。

**自测：**

- [ ] 清空/无项目状态下打开 UI → 无法发送聊天，有明确引导  
- [ ] 创建一个项目后可正常开 session、发消息  
- [ ] 不再出现名为 general 的默认可聊项  

---



### P3 — 侧栏信息架构（通用医学 / 战创伤医学）

**目标：** SidebarV2 原「项目 / 通用」改为「通用医学 / 战创伤医学」；各自下列该类型项目与其 sessions。

**范围：**

- Tab 文案与 `aria`  
- 列表按 `meta.type` 过滤  
- 当前选中项目切换时 session 列表正确  
- 空类型下列空态（「暂无项目，去创建」）

**不做：** 人设文案（P4）；技能过滤（P5）。

**自测：**

- [ ] 两侧各至少一个项目时，Tab 切换只显示对应类型  
- [ ] 在 A 类型项目下的 session 不会出现在 B 类型 Tab  
- [ ] 移动端侧栏同样正确（若适用）  
- [ ] 现有 Sidebar 相关单测更新并通过  

---



### P4 — 项目类型人设（系统提示词）

**目标：** 通用医学 / 战创伤医学使用不同角色说明，使助手行为可区分。

**范围：**

- 两套 prompt 模板（可先放 `$HOME` 或仓库 `prompts/` / 配置；实现时定一处）  
- Agent 建会话 / 每轮上下文时按当前项目 `type` 注入  
- 类型不可变 → 人设不随中途切换（无切换入口）

**不做：** 技能可见性（P5）。

**自测：**

- [ ] 同模型下，在两类型项目各问一句「你是谁/你擅长什么」→ 回答角色明显不同  
- [ ] 切换项目后新 session 使用对应人设；旧 session 不要求改写历史  

---



### P5 — 内嵌技能类型范围（第一期矩阵）

**目标：** 内嵌技能带固定 `scopeTags`（全局 / 类型）；`med-trauma-stage-plan` 仅战创伤。

**范围：**

- Skill 元数据或 registry：声明 `availability: global | war_trauma | general_medicine | …`  
- Agent `skillsList` / `read_skill` / UI 列表：按**当前项目类型**过滤  
- 通用医学项目中：不可见、不可调用 `med-trauma-stage-plan`  
- 战创伤项目中：可见可调；办公 skills + 其余 med skills 仍全局

**不做：** 用户自创归属编辑 UI（P6）；可先读死配置。

**自测：**

- [ ] 战创伤项目：技能列表含 `med-trauma-stage-plan`，且能 `read_skill` / 按 skill 走通一轮（或至少工具可见）  
- [ ] 通用医学项目：列表无该项；模型若硬调应被拒绝或找不到  
- [ ] 全局技能（如 docx/pdf）两类型都在  

---



### P6 — 自创技能归属（前端多选）

**目标：** 技能页统一列表；用户对**自创**技能多选：全局 / 通用医学 / 战创伤；内嵌只展示不可改。

**范围：**

- 自创 skill 的归属持久化（建议 `$HOME/skills/<slug>/` 旁 meta，或统一 registry）  
- SkillsList / 详情：内嵌显示「系统：全局|战创伤」只读；自创可编辑多选  
- 过滤逻辑与 P5 共用一套「当前项目类型 → 可见集合」

**不做：** 项目实例级绑定。

**自测：**

- [ ] 新建自创 skill，只勾「通用医学」→ 仅在通用医学项目可见  
- [ ] 再勾「战创伤」→ 两类型都可见  
- [ ] 勾「全局」→ 任意项目可见（与多选语义一致，实现时定义：全局是否隐含全类型）  
- [ ] 内嵌 skill 无编辑归属入口  

**产品微约定（实现时写进 UI 文案）：**  
「全局」= 所有项目类型可用；与「同时勾选两个类型」等价时可只保留全局开关 + 类型多选互斥，避免三种状态打架——**实现 P6 前在 UI 上选定一种交互，本清单不强制。**

---



### P7 — 删除项目：会话与记忆删除，文件归档

**目标：** 删除行为符合定案。

**范围：**

- 删项目时：  
  - 删除 `$HOME/projects/<typeKey>/<id>/chats/`（及 session 索引）  
  - 删除 `$HOME/memory/<typeKey>/<id>/`  
  - 将 `$WS`（`$HOME/workspaces/<typeKey>/<id>/`）**移动/复制**到 `$HOME/archives/projects/<id>-<timestamp>/`（名称可微调）  
  - 从项目 registry / 侧栏移除
- UI：确认文案写清「对话与项目记忆将删除；已生成文件会归档保留」

**不做：** 归档浏览器完整产品（可仅磁盘归档 + 日志路径）。

**自测：**

- [ ] 删前：有 session、有记忆条目、有 exports 文件  
- [ ] 删后：侧栏无项目；chats 与项目记忆不可再加载  
- [ ] 归档目录存在且含原 exports/inbox 内容  
- [ ] 删除失败（磁盘满等）不出现「半删」无提示状态  

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


| 阶段  | 状态           | 完成日期       | 备注                                                               |
| --- | ------------ | ---------- | ---------------------------------------------------------------- |
| P0  | **P0.1 已完成** | 2026-08-27 | 系统内创建 + 类型化嵌套布局 + `migrate-typed-projects`；侧栏 Tab/去 general 仍属后续 |
| P1  | **进行中**      | 2026-08-27 | gateway key = 系统项目 id；cwd/文件仍 `$WS`；嵌套扫描已补                       |
| P2  | 待开始          |            |                                                                  |
| P3  | 待开始          |            |                                                                  |
| P4  | 待开始          |            |                                                                  |
| P5  | 待开始          |            |                                                                  |
| P6  | 待开始          |            |                                                                  |
| P7  | 待开始          |            |                                                                  |
| P8  | 待开始          |            |                                                                  |
| P9  | 待开始          |            |                                                                  |


---



## 附录 C — 第一期技能矩阵（P5）


| Skill                                           | 范围         |
| ----------------------------------------------- | ---------- |
| 办公五件套（pdf/docx/pptx/spreadsheets/diagram-maker） | 全局         |
| med-tools 下除下列外的 med-*                          | 全局         |
| `med-trauma-stage-plan`                         | **仅战创伤医学** |


后续类型专属技能在本表追加，勿在未更新本表时改过滤逻辑。