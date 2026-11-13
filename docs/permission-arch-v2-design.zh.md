# 权限架构 v2 设计书（个人工作区）

> 状态：**第一批范围已评审通过（2026-11-09）**，2026-11-11 重排为「两条轨道 + 三个门」。
> 进度与顺序见 [plans/permission-arch-v2-todo.md](./plans/permission-arch-v2-todo.md)，决策见 §17
> 分支：`feat/permission-arch-v2`
> 适用范围：离线内网（医院服务器）单机部署，多用户登录模式
> 本文只覆盖本轮要做的范围，明确"不做什么"见第 13 节
> **本轮硬约束**：配额只告警、永不阻断（§8.0）；第一批不改动 `skills/**`（§18）

---

## 0. 一句话目标

让用户在离线、安全的前提下，看得见、管得住自己的个人工作区；
让 Agent 只能在这**一个工作区目录**里干活（`inbox` 只读），且前端只呈现一条稳定的执行路径。

三条原始诉求（需求方原话归纳）：

1. 用户能在离线安全的情况下完成他想完成的任务。
2. Agent 只能访问当前会话的工作区目录（根目录之下全部可读写，`inbox` 只读），外加显式登记的 skill、服务与安全命令；不创建工作区之外的文件、不联网下载。
3. 前端呈现稳定的操作，不出现"报错 → 换方法 → 再报错"。

---

## 1. 现状盘点（已核实）

| 能力 | 当前状态 | 位置 |
|---|---|---|
| 工作区目录布局 | 已有 | `src/pilot/paths.ts` → `ensureWorkspaceLayout()` |
| 路径安全校验（用户家目录边界） | 已有，多用户模式强制 | `src/tool/builtin/filesystem/pathSafety.ts` |
| 文件工具越界拒绝 | 已有 | 同上 `resolvePilotDeckWorkspacePath()` |
| 文件工具的可写范围 | 已是**整个工作区**（`context.cwd` = 工作区根） | 同上；仅 `.git`/`node_modules`/`dist` 写保护 |
| 工作区内写入免确认 | 直接 `passthrough` | `src/tool/builtin/filesystem/writePermissions.ts` |
| 删除工具 | 没有，Agent 用 `bash rm` | — |
| 存储接口（列表/预览/删除） | 已有，且**已有前端页面在用** | `ui/server/routes/storage.js` + `ui/src/components/main-content-v2/StorageV2.tsx`（`activeTab === 'storage'`） |
| 命令危险模式拦截 | 已有（curl/wget/pip install/rm -rf / 等） | `src/tool/builtin/bash/permissions.ts` |
| 操作系统级沙箱 | 已有（Linux bwrap / macOS sandbox-exec） | `src/tool/builtin/bash/sandbox/` |
| 沙箱可写范围 | **整个用户目录**，不是会话工作区 | `sandbox/bwrap.ts`、`sandbox/sandboxExec.ts` |
| scratch 配额 | 有定义但**无调用方** | `src/security/policy/resourceLimits.ts`（默认 1 GiB） |
| 用户磁盘用量统计 | 已有且已接线：`GET /api/admin/users` 返回 `storageBytes`，设置页「用户」已有"存储"列（60s 缓存） | `ui/server/services/storageUsage.js` + `ui/server/routes/adminUsers.js:37` + `ui/src/components/settings/view/users/index.tsx:194` |
| 配置读写 / 热重载 | 已有，管理员专用 | `ui/server/routes/config.js` + `pilotdeckConfigReloader.js` |
| 审计日志 | 没有 | — |

结论：**大部分基础设施已经存在，本轮以"接线 + 补齐"为主，不做架构推倒重来。**

---

## 2. 核心契约：`TaskScope`

整个设计只有一个概念上的单一事实来源，路径校验、配额、清理、页面展示都从它派生。

```ts
// src/workspace/types.ts（新增）
export type TaskScope = {
  /** 工作区根目录：<PILOT_HOME>/workspaces/<type>/<workspaceId> */
  root: string;
  /** 工作区稳定标识，前端只认它，不认绝对路径 */
  workspaceId: string;
  /** 唯一边界：root 之下全部可读写，唯一例外是只读根 */
  readOnlyRoots: readonly ["inbox"];
  /** 系统保留命名的**顶层**点号项，Agent 不得创建/写入/删除 */
  reserved: readonly [".trash", ".usage.json", ".pinned", ".tmp"];
  /** 自动清理只作用于这些目录，其余一律不自动删 */
  gcRoots: readonly ["scratch"];
  /** 软删除区 */
  trash: string;      // <root>/.trash
  /** 用量记账 */
  usageFile: string;  // <root>/.usage.json
};
```

约束：

- `root` 必须是 realpath 后的真实目录，符号链接一律拒绝。
- **除 `readOnlyRoots` 与 `reserved` 外，`root` 下任何位置都可读写**，包括用户或 Agent 新建的任意层级目录。
- 所有对外暴露的路径都是**相对 `root` 的路径**；绝对路径只出现在服务端日志。
- Agent 与前端共用同一个 `WorkspaceService`，不允许各写一套。

---

## 3. 目录规范

```
<PILOT_HOME>/workspaces/<type>/<workspaceId>/
├── inbox/                    只读输入（用户上传、病例批次）
│   └── <batchId>/
│       └── derived/
├── exports/                  约定：最终交付物（非强制）
├── scratch/                  约定：中间过程（唯一允许自动清理的目录）
│   ├── qa/                   预留（当前无写入方）
│   ├── work/                 中间产物，按 turn 分目录
│   ├── preview/              预览/渲染中间件
│   └── tool-results/         工具输出落盘
├── <用户新建的任何目录>/        自由使用，与 exports 同级
├── .trash/                   系统保留：软删除区（保留 7 天）
├── .usage.json               系统保留：用量记账
└── .pinned                   系统保留：保护清单
```

| 位置 | 可读 | 可写 | 自动清理 | 前端可见 |
|---|---|---|---|---|
| `root` 下一切（含用户新建目录） | 是 | 是 | 否 | 是 |
| `inbox` | 是 | **否**（仅上传通道） | 永不 | 是 |
| `exports` | 是 | 是 | 永不 | 是 |
| `scratch` | 是 | 是 | **是**（按第 8 节） | 是 |
| `.trash` | 通过"回收站"视图 | 否 | 7 天后物理删除 | 独立视图 |
| `.usage.json` / `.pinned` / `.tmp` | 否 | 否 | — | 否 |

说明：`exports` / `scratch` 是**默认落位约定**，不是边界；
用户把产物放到自建目录同样合法，Agent 必须配合。

---

## 4. 第 5 条：产物落位与路径校验

### 4.1 落位规则

| 产物类型 | 默认位置 | 说明 |
|---|---|---|
| 最终交付物（PDF/DOCX/PPTX/XLSX/图片） | `exports/` | 用户可直接下载 |
| 中间产物（抽帧、分页、转码） | `scratch/work/<session>/<turn>/` | 回合结束即删（D10） |
| 工具结果落盘 | `scratch/tool-results/` | 可被配额清理 |
| 预览中间件 | `scratch/preview/` | 可被配额清理 |
| 用户显式指定目录（含自建目录） | 任意层级，只要在 `TaskScope.root` 内 | 越界直接拒绝 |

### 4.2 校验流程（服务端，不依赖提示词）

```
输入：相对路径或绝对路径
1. 拒绝空值、含 \0
2. resolve → realpath（父目录必须存在且不是符号链接）
3. 必须 startsWith(scope.root)          → 否则 policy_denied
4. 命中 scope.reserved（顶层点号项）      → 否则 policy_denied
5. 写操作且目标在 scope.readOnlyRoots 下  → 否则 policy_denied（inbox 只读）
6. 写操作目标已存在且内容不同 → needs_confirmation（见第 6 节）
7. 命中 .git / node_modules / dist 等保留名 → policy_denied
```

复用现有实现：`resolvePilotDeckWorkspacePath()` 已覆盖 2/3/7，
本轮补 4（系统保留命名）、5（inbox 只读）与 6（覆盖确认）。
**不需要**做"三个目录白名单"——那会把现有的整工作区能力收窄。

### 4.3 文件名规范化

- 统一 NFC 归一化（防止 macOS/Linux 重名）
- 去掉首尾空白与 `..` 段
- 同名冲突自动追加 `(1)`、`(2)`（沿用 commit `8b15da9` 的做法）
- 保留扩展名，长度上限 120 字符（超出截断中间部分）

---

## 5. 第 1 条：前端工作区页面

### 5.1 位置

**复用现有的「项目文件」右侧面板，不新增标签页。**
入口保持原样：对话页里项目名旁边的文件夹图标，点击后从右侧滑出。

| 事项 | 现状 | 本轮改动 |
|---|---|---|
| 面板组件 | `ui/src/components/main-content-v2/FilesV2.tsx` | 改造为工作区视图 |
| 挂载位置 | `ui/src/components/main-content/view/MainContent.tsx`（`aria-label="项目文件"` 的 `<aside>`） | 标题改「工作区」，其余结构保留 |
| 开关 | `activeTab === 'files'`，关闭时 `setActiveTab('chat')` | 不变 |
| 宽度 / 动画 | `FILES_PANEL_WIDTH`、`pd-side-panel-enter/exit` | 不变 |
| 移动端 | 全屏覆盖 | 不变 |
| 数据源 | `useFileTreeData` → `GET /api/projects/:name/files` | 复用，补用量字段 |
| 渲染 | `flattenFiles()` 拍平成列表 | 改为层级树 + 懒加载 |
| 上传 | `POST /api/projects/:name/files/upload`（支持 `targetPath`） | 默认落 `inbox/` |

数据源核对：`GET /api/projects/:name/files` 内部是
`extractProjectDirectory(projectName)` → 工作区根目录，`getFileTree(root, 10)`，
返回的已是相对路径。**也就是说这个面板现在列的就是整个工作区**，
不需要新建一套接口。

### 5.1.1 前置改造（两处必须先改，否则会出事）

1. **`DELETE /api/projects/:name/files` 目前是硬删除**
   （`fsPromises.rm(..., { recursive: true, force: true })` / `unlink`）。
   第 6 节承诺的"删除进回收站、7 天可恢复" 必须建立在这个接口先改成
   **移入 `.trash`** 之上。改造完成前，前端不要暴露删除按钮。
2. **`validatePathInProject()` 只做字符串前缀判断**
   （`resolved.startsWith(root + sep)`），不解析符号链接。
   工作区内放一个指向外部的软链即可绕过边界，改为统一调用
   `resolvePilotDeckWorkspacePath()`。

### 5.2 内容

```
┌─ 工作区 ─────────────────────────────┐
│ [能力卡片]                            │
│  可读：整个工作区（inbox 只读）         │
│  可写：除 inbox 与系统保留项外全部       │
│  技能文档只读 · 实现代码不可见          │
├──────────────────────────────────────┤
│ 工作区 4.2 GB / 提示 5 GB  ████░░░░░░ │
├──────────────────────────────────────┤
│ inbox    (3)                     只读 │
│   └ 2026-11-09_病例批次/               │
│ exports  (12)                         │
│   └ 病例报告.pdf       2.1 MB   预览  │
│ 我的资料  (8)                          │
│   └ 会诊记录/                          │
│ scratch  (34)   420 MB / 1 GB  ███░░  │
│   └ work/ ...                         │
│ 回收站   (2)                          │
└──────────────────────────────────────┘
```

### 5.3 功能边界（第一版只做这些）

| 操作 | 支持 | 说明 |
|---|---|---|
| 列出整棵工作区树（任意层级） | 是 | 名称、大小、修改时间；按需懒加载 |
| 预览 | 是 | pdf / docx / xlsx / 图片 / 文本 |
| 下载 | 是 | 仅 `exports`、`scratch` |
| 上传到 `inbox` | 第二批 | 走现有上传通道 |
| 删除 | **是（第一批，2026-11-11 改为第一批）** | 进 `.trash`，7 天内可恢复；硬删除不允许 |
| 就地编辑文件内容 | 否 | 避免与 Agent 抢写 |
| 新建目录 | 第二批 | 任意层级，限 `root` 内 |
| 操作自建目录中的文件 | 是 | 与 `exports` 同等对待 |

### 5.3.1 第一批交付：最小可见版（2026-11-09 确认，2026-11-11 修订）

**第一批以"看得见"为主；唯一允许的写操作是「删除」，且必须建立在软删除（§6.3）落地之后。**

纳入范围：

| 元素 | 要求 |
|---|---|
| 面板标题 | 「项目文件」→「工作区」 |
| 能力卡片 | 三行：可读＝整个工作区；可写＝除 `inbox` 与系统保留项；技能文档只读、实现代码不可见 |
| 工作区总量条 | 数值 / 提示阈值；超阈值变黄。**纯提示** |
| `scratch` 条 | 数值 / 提示阈值；超阈值变黄。**纯提示** |
| **`inbox` 条（2026-11-11 新增，D-2）** | 数值 + 占工作区百分比；**纯提示**。理由：`inbox` 是唯一"永不自动清理"且最容易暴涨（DICOM 批次）的目录，必须单列 |
| 目录树 | 层级树 + 懒加载，显示名称、大小、修改时间 |
| 预览 | pdf / docx / xlsx / 图片 / 文本 |
| **删除（2026-11-11 新增）** | 仅 `kind: 'file'`；走软删除入 `.trash`（7 天）；**禁止删除系统保留项**；删除后提示"已移入回收站，7 天内可恢复" |

**明确不做**（第一批不出现，且**不置灰、不显示**，避免"点了没反应"）：

上传、下载以外的写操作、新建目录、回收站恢复按钮、就地编辑。

理由：写操作是唯一能造成数据损失的入口。删除之所以能在第一批开放，是因为它**先有 `.trash` 兜底**
（§6.3 的 7 天保留），属于"可撤销"动作；其余写操作（新建/恢复/编辑）仍留到第二批。

> 说明（2026-11-12 更新）：`StorageV2.tsx`（`activeTab === 'storage'`）已按"项目视角"重构，
> 见 §5.6。它不再删单个文件，也不再保留归档 tab —— 文件级删除只属于工作区页的回收站。
>
> **实现注记（2026-11-12，第二批）**：本节的"明确不做"里，四项已开放：
> ①**新建目录**——`FilesV2` 头部按钮 + 弹窗，支持多级路径（父目录必须已存在，否则 404），
> 同名 409，隐藏名/保留项/`..`/软链 400；②**回收站区**——列表、逐项恢复、清空（二次确认）；
> ③**scratch 立即清理**；④**就地编辑**——文本预览弹窗里「编辑」→ 保存/取消，
> 保存走既有的 `PUT /api/projects/:name/file`（该接口按新规则收紧：相对路径、无 `..`、
> 无隐藏段/保留项、逐段拒绝软链；二进制 Office/PDF 仍 415）。
> **`inbox/` 对人类本人可写**（2026-11-12 决定）：它只对 **agent** 只读
> （`pathSafety.ts` 的 `READ_ONLY_WORKSPACE_ROOTS` 仍然生效）；文件主人是用户本人，
> 在上传件上改表头、补一列属于正常操作，没有理由在页面上拦他。
> 仍未做：§7 的可见性白名单/沙箱收窄（等 skills 结构冻结）。
> 工作区用量条下新增一行说明：「只有 scratch 会被自动清理」，避免用户误以为 `exports` 也会被回收。

### 5.4 接口

| 方法 | 路径 | 状态 | 说明 |
|---|---|---|---|
| GET | `/api/projects/:name/files` | 复用 | 工作区树，补 `size`/聚合大小 |
| POST | `/api/projects/:name/files/upload` | 复用 | `targetPath` 默认 `inbox` |
| DELETE | `/api/projects/:name/files` | **改造** | 硬删除 → 移入 `.trash` |
| GET | `/api/workspace/:id/usage` | 新增 | 工作区总量、`scratch` 用量、配额上限 |
| POST | `/api/workspace/:id/mkdir` | 新增 | 新建目录（任意层级） |
| POST | `/api/workspace/:id/trash/restore` | 新增 | 从回收站恢复 |
| POST | `/api/workspace/:id/scratch/clean` | 新增 | 手动清理 scratch |

> **实现注记（2026-11-12，第二批）**：实际路径沿用现有面板的 `projectName` 命名，
> 与上表略有出入（语义一致，未额外引入 `workspaceId` 解析层）：
> `POST /api/projects/:projectName/files/mkdir`、`GET /api/projects/:projectName/trash`、
> `POST /api/projects/:projectName/trash/restore`、`POST /api/projects/:projectName/trash/empty`
> （必须 `confirm:true`）、`POST /api/projects/:projectName/workspace/scratch/clean`。
> 路径校验规则抽在 `ui/server/utils/workspacePaths.js`（相对路径、无 `..`、无隐藏段、保留项、
> ≤16 层、≤120 字符/段、逐段拒绝软链），单测 11 条。
> 第二批收尾时这组路由从 `index.js` 搬到 `ui/server/routes/workspaceFiles.js`
> （工厂函数注入 `extractProjectDirectory`），由 `apiRouter.js` 与 `projectsRoutes`
> 挂在同一条 `requireUser` 链上；`workspaceFiles.test.js` 用临时工作区跑完整 HTTP 断言。

所有接口用 `workspaceId` + 相对路径，**不返回绝对路径**（复用现有 `pathSanitization`）。

### 5.5 验收标准

1. 新建会话 → 页面能看到三个默认目录与能力卡片
2. Agent 生成 PDF 到 `exports` → 页面可见且可预览
3. 删除文件（第二批）→ 进回收站，7 天内可恢复
4. 页面任何位置都看不到服务器绝对路径
5. 只读用户能看不能改（按钮禁用 + 后端 403）

### 5.6 「设置 → 存储」页：项目视角（2026-11-12 重构）

这一页只回答两个问题：**每个项目占多少**、**要腾空间时怎么整包删**。

| 区块 | 内容 |
|---|---|
| 顶部四格 | 总占用 / 当前文件 / 回收站（7 天后释放）/ 在用项目数 |
| 项目清单 | 项目名（+ 项目 id）、类型、会话数、占用、回收站条数、最后活动、[查看]、[删除项目] |
| [查看] 展开 | 顶部一行用量摘要（exports / inbox / scratch / 回收站）；下面是**与工作区页一致的目录清单**：`inbox / exports / scratch` 三个规定目录（即使为空也显示）+ 用户自建目录，逐个目录点开看只读文件列表 |
| 文件预览 | `GET /api/storage/preview?typeKey=&groupId=&path=`，只允许落在**在用项目**工作区内；图片 / PDF / 文本，文本截断 512 KB。**只读，不提供任何写操作** |
| [删除项目] | 列出将删内容（会话数、文件数、exports/inbox/scratch 分布、回收站、记忆/定时任务）→ **输入项目名确认** → `DELETE /api/projects/:id?force=true&confirmName=...` |

**刻意不做**：

- 归档 tab（项目归档已下线，见 §8.7.3）；
- 从这一页删单个文件（文件级删除只属于工作区页的回收站，避免两套删除语义）；
- 勾选 + 批量操作（唯一动作就是"整包删项目"）。

**为什么保留预览**：管理员排查"这 300 MB 到底是什么"时必须能点开看一眼，
否则只能靠猜。预览是纯只读，不构成写入口。

**接口收敛**：`ui/server/routes/storage.js` 现在只剩 `GET /`（快照）与 `GET /preview`。
`/delete`、`/trash`、`/trash/restore`、`/trash/groups*` 全部移除；
`deleteStorageTargets` / `groupTrash` 服务一并下线（`.trash/groups` 的存量由启动清理兜底）。

**不显示隐藏项**：`scanFiles()` 对任何层级 `.` 开头的条目一律跳过，
所以 `.pilotdeck/`、`.trash/`、`.usage.json` 之类既不进文件列表，也不计入占用。
目录清单由后端随项目一起下发（`folders: [{name,fileCount,sizeBytes}]`），
口径和工作区页一致 —— 前端不需要自己从文件路径猜目录。

---

---

## 6. 第 3 条：删除 / 覆盖确认与软删除

### 6.1 原则

**不打断是默认，打断要有理由。** 大多数删除走软删除、零弹窗；
只有"不可恢复"或"覆盖会丢内容"的操作才确认。

| 操作 | 是否确认 | 理由 |
|---|---|---|
| 删除 → 进 `.trash` | 否（可撤销） | 可恢复，打断无收益 |
| 清空回收站 | 是（列出数量与总大小） | 不可恢复 |
| 覆盖已存在且内容不同的文件 | 是（列出清单） | 会丢内容 |
| 移动/重命名到已存在目标 | 是 | 同上 |
| 批量操作 | 是，一次汇总确认 | 不逐个弹 |

### 6.2 覆盖快照

覆盖前把旧版本存入 `scratch/tool-results/snapshots/<turnId>/`，
复用 `src/tool/builtin/filesystem/writeSnapshots.ts`。前端可"查看上一版"。

### 6.3 回收站

- 位置：`<root>/.trash/<原相对路径>.<时间戳>`
- 保留：**7 天（2026-11-09 确认，按 7 天执行；仍做成可配，默认 7）**
- 覆盖快照（6.2）同样按 **7 天**，与回收站保持一致的用户心智："一周内都能反悔"
- 恢复：前端"恢复"按钮 → 原路径；原路径已被占用时提示改名
- 清理：后台任务每天一次物理删除过期项（写审计）

**实现方式（2026-11-11 确认，不采用硬删除）**

| 项 | 决定 |
|---|---|
| 删除动作 | `rename()` 到 `.trash/<相对路径>.<时间戳>`，**绝不允许 `fs.rm` 直接删** |
| 改造对象 | `ui/server/routes/storage.js` 的 `deleteTarget()`：`kind: 'file'` 分支由 `fs.rm` 改为 `move` |
| 前端入口 | 删除按钮只展示"移入回收站"语义；**不出现"永久删除"字样**（永久删除只存在于回收站清空，属第二批） |
| 禁止目标 | `.trash` / `.usage.json` / `.pinned` / `.tmp` 及其子路径一律 400 |
| 兜底 | 磁盘满导致 `rename` 失败时，返回可读错误并写审计；**不得退化为 `rm`** |
| 硬删除残留 | 现有 `/api/storage/delete` 的 `kind: 'workspace'` / `kind: 'archive'` 仍为硬删除，第二批再收口 |

**实现注记（2026-11-12，第二批）**

- `kind: 'workspace'` 已收口：不再是 `fs.rm`，而是**逐顶层条目** `moveFileToTrash`
  （跳过 `RESERVED_WORKSPACE_ENTRIES`），随后重建 `inbox/exports/scratch` 三个默认目录。
  整包删除因此变成"一组可恢复条目"，而不是不可撤销的硬删。
- 目录也是一个回收站条目：`listTrash` 用"是否带时间戳后缀"区分条目与中间层，
  带后缀的目录按单元递归计量大小、整体恢复/整体清除；不带后缀的才继续下钻。
- 唯一不可恢复入口是 `POST …/trash/empty`（必须 `confirm: true`），一次清除本工作区
  `.trash` 下全部条目，逐条写审计 `trash.purge`（`reason: manual`，`meta.kind` 区分文件/目录）。
- 过期清理（7 天）与手动清空共用同一段 `purgeEntries`，避免两条路径的审计字段各写一套。
- 前端 `FilesV2` 的「回收站」区：条目数/大小/7 天说明、逐项「恢复」、
  「清空」→ 二次确认（显示 N 项 + 合计大小 + "永久删除，无法恢复"）。

---

## 7. 第 2 条：可见性白名单

### 7.1 分层

| 内容 | 用户可见 | 实现方式 |
|---|---|---|
| `SKILL.md`、`reference/*.md`、工具 schema | 只读可见 | 白名单扩展名 |
| 技能脚本（`scripts/*.sh`、`*.py`） | 不可见 | 不进列表，直接 404 |
| 个性化记忆（`memory/`） | 只读可见 | 单独入口 |
| 内置技能实现（`src/`、`dist/`） | 不可见 | 不在任何可读根内 |
| 其他用户的任何内容 | 不可见 | `pathSafety` 已强制 |

### 7.2 实现要点

- 白名单**在服务端判定**，不依赖提示词约束。
- 展示 `SKILL.md` 时加说明头："这是给助手的操作说明，不是给你的建议"。
- 记忆只读：页面只能看，修改一律走 Agent（有审计）。

---

## 8. 工作区配额与清理

### 8.0 硬性决策：配额只告警，永不阻断（2026-11-09 评审通过）

**任何情况下都不得因为"空间不足"拒绝用户的工作。**

- 超限的后果只有一种：页面上多一条提示、审计里多一条记录。
- Agent 仍然可以继续读写，任务不得中断。
- 不存在"硬上限拒绝写入"这种语义；代码里也不要预留这样的分支，
  否则下一个人一定会把它接上去。

理由（业务侧）：医院场景下"写不进去"等于当场阻断工作，
而磁盘满是可以事后处理的事故 —— **可恢复的告警优于不可恢复的阻断**。

因此下列设计中的"拒绝写入""quota_exceeded 阻断"一律作废，改为纯提示。
`quota_exceeded` 这个错误码**不再存在**，相关失败统一走 `warn` 提示。

### 8.1 结论先说

**大小决定"提示什么"，时间决定"先清谁"，保护窗决定"谁不能清"。**

- 只用时间（TTL）：一次导入 30 个 DICOM 批次涨到 40 GB，30 天没到期 → 磁盘满、全系统挂。
- 只用大小（LRU）：上午 900 MB 的中间结果被下午 800 MB 的新任务挤掉，用户回头"继续上次分析"就失败。

### 8.2 默认值

| 项目 | 默认值 | 超限行为 |
|---|---|---|
| 单会话 `scratch` 上限 | **1 GiB** | **只告警**；后续开启清理时自动清（见 8.4 前置条件） |
| `scratch` 提示阈值 | **80%**（819 MB） | 只告警 |
| 单会话工作区总量 | **5 GiB** | **只告警，永不拒绝写入** |
| 单用户全部工作区总量 | **20 GiB** | 只告警，永不拒绝写入 |
| `exports`、用户自建目录 | 不单独设限、永不自动清理 | — |
| `scratch` TTL 兜底 | **7 天未访问即清**（每 6 小时扫描一次） | 自动清理 |
| 保护窗 | **最近 10 分钟**内被读写的不动 | — |

> **关键约束**：自动清理只作用于 `scratch/`。
> `exports/` 与用户自建目录**永远不会被自动删除** —— 否则用户的文件夹会"自己消失"，
> 这是比磁盘满更难解释的事故。它们超限时**只告警**，既不删也不拦。
>
> 补充：`scratch` 的自动清理在**第二批**上线。第一批只做"看得见"（用量展示 + 告警）；
> 第二批起 UI 才可以出现"会自动清理"这类文案。

分层上限（决定清理顺序）：

```
tool-results  <= 256 MB   最先清（可重跑得到）
preview       <= 256 MB   次之（可再生）
work          占剩余       再次之
qa            最后         当前无写入方，属预留
```

### 8.3 清理单元

**按任务单元删，不按单文件删。** 一个任务产出 3–5 个互相依赖的中间文件，
按文件 LRU 会删一半留一半，后续命令直接失败 —— 又是一次"莫名其妙的报错"。

```ts
type EvictionUnit = {
  dir: string;        // scratch/work/<session>/<turn>/ 或 scratch/preview/<name>/
  bytes: number;
  lastUsedAt: number; // 目录内最大 mtime（由 .usage.json 校正）
  category: 0 | 1 | 2 | 3;
  protected: boolean;
};
```

若目录未按 turn 划分（历史数据），按 mtime 5 分钟聚簇视为一个单元。

### 8.4 算法

```
1. used = Σ unit.bytes（排除保护集）
2. used <= softLimit → 结束
3. 按 (category 升序, lastUsedAt 升序) 排序
4. 从队首整目录删除，直到 used <= softLimit
   - 已达 hardLimit：同步执行（写入方等待）
   - 仅超软阈值：投递后台队列
5. 删后仍 > hardLimit → **只记审计并保持告警**，本次写入照常进行（不得拒绝）
6. 写审计记录
```

保护集（永不入选）：

- 目录级：`inbox/`、`exports/`
- 最近 10 分钟被读/写的单元
- `.pinned` 中的单元
- 当轮正在被引用的路径（`WorkspaceService` 访问日志判定）

### 8.5 记账

`atime` 在 `relatime`/`noatime` 挂载下不可靠，因此不使用它。

- 所有读写经 `WorkspaceService`，顺带更新 `<root>/.usage.json`：

```json
{
  "scratch/work/2026-11-09T08:12": {
    "bytes": 94371840,
    "lastAccessedAt": "2026-11-09T09:01:00Z",
    "pinned": false
  }
}
```

- 每 6 小时全量校准一次（walk 真实目录），修正漂移。
- 复用 `src/security/policy/resourceLimits.ts` 的 `measureScratchBytes()`。

### 8.6 边界情况

| 情况 | 处理 |
|---|---|
| 单文件即超上限 | 照常写入，页面提示"该文件较大"；不"先写后删"，也**不拒绝** |
| 正在被当前回合读取 | 跳过，不清理 |
| 两个回合并发写 | 每工作区一把文件锁，串行化清理 |
| 清理时文件已消失 | 忽略 `ENOENT`，继续 |
| 符号链接 | 不跟随、不计入（`lstatSync`） |
| `exports` 占满磁盘 | 不自动清理、不拦截，告警 + 提示用户手动处理 |
| 真实磁盘写满（ENOSPC） | 由文件系统报错，系统原样抛出；**这属于环境故障，不是配额策略**，不要伪装成"配额超限" |

### 8.7 用户可见

工作区页面需要**两条**进度条，因为两者语义不同：
工作区总量只告警、`scratch` 上限后由系统清理；两者都**不阻断**任何操作。

```
工作区  4.2 GB / 提示 5 GB   ████░░░░░░   （超过 5 GB 变黄，仅提示）
├─ exports        3.1 GB    不自动清理
├─ scratch        820 MB / 1 GB   ████████░░   [立即清理]   ← 上限后由系统清理
│   ├─ work          640 MB
│   ├─ preview        90 MB
│   └─ tool-results   90 MB
└─ 我的资料         280 MB    不自动清理
回收站  2 项 / 45 MB         [清空]
```

规则：

| 元素 | 行为 |
|---|---|
| 工作区总量条 | 超过 5 GB 变黄**仅提示**；**永不自动删、永不拒绝写入** |
| `scratch` 子条 | 80% 变黄提示；上限后由系统清理（不在第一批交付） |
| 每个目录行 | 显示聚合大小（懒加载时异步计算，服务端缓存 60 秒） |
| 悬停提示 | 清理上线后写"scratch 会自动清理；其他目录不会"；上线前写"仅提示，不会自动删除" |
| 管理动作 | `[立即清理]` 只清 scratch（**强制**，二次确认）；`[清空回收站]` 需二次确认；可按大小排序看 Top 5 |

实现要点：

- 数值来自 `WorkspaceService` 的增量记账 + 6 小时全量校准，页面**不实时 walk 目录**
- 文件增删后只失效对应目录的缓存项
- 90% 以上时提示"建议把大文件移出或删除"
- 清理完成后轻提示："已清理 12 个文件，释放 320 MB"
- **告警文案不得出现"无法继续""请先清理"这类阻断性措辞**，只说"占用偏高，可考虑清理"

#### 8.7.1 `<工作区>/.pilotdeck/tool-results/`（会话级缓存，不归 scratch 管）

工具结果超过内联预算时，agent loop 会把完整内容落到
`<工作区>/.pilotdeck/tool-results/<会话ID>/`（图片 base64、长文本、大 JSON），
上下文里只留预览 + 路径；`refs/result-000N.*` 是给 `read_file` 的别名副本。

它的生命周期**跟会话走，不跟回合走**，所以不能进 scratch（那里回合结束就清）：

| 时机 | 行为 |
|---|---|
| 会话还活着 | 保留。历史消息的"查看完整结果"要回读它；agent 也可能 `read_file` 回读 |
| 删会话 | **立即删** `tool-results/<会话ID>/`（`sessionCleanup.js` 第 4 类），并把变空的 `tool-results/`、`.pilotdeck/` 收掉（仅在空时，避免误删项目级 `skills/`、`commands/`） |
| 会话不删但超过 `toolResultsTtlDays`（默认 14 天）没动过 | 兜底清理，启动时 + 每 6 小时扫一次 |
| transcript 已不存在（孤儿） | 立即清（1 小时宽限，避开"目录刚建、transcript 还没落盘"的窗口） |

实现：`ui/server/services/toolResultsRetention.js`；配置项写在 `workspace.quota.toolResultsTtlDays`。
两处都是旁路任务，失败只记日志，不影响服务启动。

#### 8.7.2 删一个会话到底删什么（完整清单）

用户点"删除会话"时的语义是**这个会话的东西都别再留着**，所以清单必须是穷举的，
漏一类就是一个"删了还在"的隐私问题和空间问题。

| # | 内容 | 位置 | 时机 |
|---|---|---|---|
| 1 | 对话记录 | `<home>/projects/<类型>/<项目>/chats/<会话>.jsonl` | 删除时 |
| 1b | 回退影子副本 | 同目录 `<会话>.pre-rewind.jsonl`、`<会话>.pre-rewind.pre-rewind.jsonl` | 删除时 |
| 2 | 该会话的暂存上传 | `<工作区>/inbox/<会话>/` | 删除时（仅战创伤：上传时带了 sessionId；通用医学见下） |
| 3 | 战创伤 Case State | `<home>/memory/<类型>/<项目>/cases/<caseSlug>/` | 删除时（仅战创伤） |
| 4 | 工具结果缓存 | `<工作区>/.pilotdeck/tool-results/<会话>/` | 删除时（兜底 14 天） |
| 5 | 会话附属目录 | `<chats>/<会话>/`（`file-history` + `subagents`） | 删除时 |
| 6 | 回退备份 | `<chats>/.rewind-backups/<会话>.<时间戳>.jsonl` | 删除时（兜底：每会话留 3 份 / 30 天） |
| 7 | 本会话的 scratch 工作目录 | `<工作区>/scratch/work/<safeSegment(会话ID)>/` | 删除时（兜底：回合结束清理 + 7 天 TTL） |
| 8 | 记忆库原始对话（L0） | `<home>/memory/<类型>/<项目>/control.sqlite` 的 `l0_sessions`，连同 `<会话>.pre-rewind` 影子行 | 删除时（兜底：每天扫一次孤儿行） |
| 9 | 会话名 | SQLite `session_names` | 删除时 |
| — | `exports/…` | `<工作区>/exports/` | **永久保留**（用户成品，删会话不动它） |
| — | 项目级提炼记忆（L1/L2） | 同目录 `memory/*.md` + 索引 | **按设计保留**（结论属于项目，不属于某次对话） |
| — | 通用医学的 `inbox/<批次>/` | `<工作区>/inbox/`（按上传批次命名，如 `1790003782658-3899324f`） | **不随会话删除**（= 用户自己的"我的资料"） |
| — | 审计 / telemetry / logs | `<home>/system/audit`、`telemetry/`、`logs/` | **不删**（合规留痕，属于系统而非会话） |
| — | 剪贴板附件临时目录 | `os.tmpdir()/pilotdeck-chat-attachments/<用户>/` | **不按会话删**（按用户 + 7 天 TTL） |

关于记忆的两层要分清：

- **L0**（`l0_sessions.messages_json`）是**原文**，按 `session_key` 一行行存，删会话必须清；
- **L1/L2** 是从 L0 提炼出的项目级事实（"这个项目的患者多为高龄"这类），
  没有到会话的溯源字段，也不该因为删掉一次对话就把项目知识抹掉。
  用户要清这些，走"清空项目记忆"（`routes/memory.js` 的 `clearAllMemoryData`）。

  （2026-11-12 用户确认：**保留**。按 `source_session_key` 精确删的方案不采用 —— 提炼结论可能
  已经融合了多个会话的内容，按会话删会删出半截事实。）

子任务会话（`background_task`）的 transcript 在
`<chats>/<父会话>/subagents/<id>.jsonl`，按 `sessionId` 推不出来，
所以删除接口必须消费前端传来的 `relativeTranscriptPath`；该路径只允许落在
项目 chat 目录内且必须是 `.jsonl`，否则整次删除报错，不做"猜一个位置删掉"。

另外 `sessionId` 必须是**单段路径**（非空、不是 `.` / `..`、不含 `/` `\`）：
上面每一项都是 `path.join(..., sessionId)` 再加 `fs.rm(recursive)`，
一个 `DELETE /sessions/%2e%2e` 就足以把整个工作区删掉。非法时返回 400 `INVALID_SESSION_ID`。

1b 的来由：`rewindSession` 早期把回退前的整份对话另存成 `<会话>.pre-rewind.jsonl`，
**就放在 `chats/` 里**；对影子会话再回退还会叠出 `<会话>.pre-rewind.pre-rewind.jsonl`。
会话列表靠 `isRecoveryArtifactSessionKey` 把它们藏起来，结果是**界面上看不见、删会话也不会碰** ——
每次回退都在磁盘上永久留一份完整对话副本。现在删除时按「同前缀 + 名字含 `pre-rewind`」一并清掉
（`readdir` 只读一层，不会碰 `<父会话>/subagents/` 与 `.rewind-backups/`），
同前缀的其它会话（如 `<会话>-2.jsonl`）不受影响，有单测锁住。

关于第 2 类只对通用医学"半生效"这件事，要说清楚：上传接口在没有 `sessionId` 时
（通用医学聊天框就是这样）用 `<时间戳>-<随机>` 当目录名，落成 `inbox/<批次>/` ——
它跟会话没有可推导的对应关系，删会话时也无从匹配。这不是漏做，而是语义上更合理：
`inbox` 在界面上就是用户的"我的资料"，同一批 CSV 往往要在后续多个会话里复用，
删一次对话就带走用户的原始数据反而是灾难。要清就走工作区的删除/回收站。
战创伤上传时带 `sessionId`，目录就是 `inbox/<会话>/`，所以能且会跟着会话一起删。

**运行中删除**：删除前若该会话在本机登记为 active，会先 `abortViaGateway` 掐掉这一轮。
不掐的话网关会在文件删完之后继续把 transcript / `scratch/work` / L0 写回来，
用户看到的就是"会话删了又冒出来"。取消失败只记日志、不阻断删除（尾部写入由
14 天 TTL 与每日孤儿扫描兜底）。

实现：`ui/server/utils/sessionCleanup.js`（1、1b、2–7，返回逐项 `deleted` 标记，含 `rewindShadows`）、
`ui/server/services/rewindBackupRetention.js`（第 6 类兜底）、
`ui/server/services/sessionMemory.js`（第 8 类 + 每日孤儿扫描）、
`ui/server/index.js` 删除路由负责第 9 类。

**实现注记（2026-11-12，第二批）**

- 参数来源：`ui/server/services/workspaceLimits.js` 读 `pilotdeck.yaml` 的 `workspace.quota`，
  60 秒缓存；缺配置 / YAML 损坏 / 非法值一律逐项回落默认值（**绝不因配置写错而启动失败**）。
- 清理执行：`ui/server/services/scratchRetention.js`。**只遍历 `scratch/<四类>`**，
  以"单元"为单位整目录删（`scratch/work/<turnId>/` 不会被删一半）；
  先按 `scratchTtlDays` 清过期，再在总量 > `scratchMaxBytes` 时按
  `tool-results → preview → work → qa` + `lastUsedAt` 升序清到 `max * softRatio` 以下。
- 保护：`protectRecentMinutes` 内动过的单元不清；工作区根 `.pinned`
  支持 JSON 数组与逐行两种格式，按前缀保护（`scratch/work/turn-1` 保护其子路径）。
- 时机：启动即跑一次，之后每 6 小时一次（`unref`，不阻塞退出）；
  页面「立即清理」走同一个 `cleanScratch`，只是带 `force: true`（见下）。
- 审计：每条删除写 `scratch.clean`（`target` / `reason: expired|over-limit` /
  `meta.category` / `meta.bytes`），失败写 `scratch.clean_failed`；清理失败只记日志，不影响服务。
- `inbox` / `exports` / 用户自建目录**永不被自动清理**，只有工作区总量条着色。

**实现注记（2026-11-12，scratch 分档清理 D10）**

`scratch` 里混着两种寿命完全不同的东西，用同一个 TTL 处理会两头不讨好：
回合目录（`work/<session>/<turn>/`）体积大、跨轮价值≈0；而 `qa` / `docx` / `data` / `tmp`
是跨轮还要接着用的草稿。因此按目录分三档：

| 目录 | 策略 | 理由 |
|---|---|---|
| `scratch/work/<session>/<turn>/` | **回合结束立刻删** | 中间产物主体（实测 11 MB 里 9.9 MB 在这）；下一轮不会再用 |
| `scratch/tool-results/<turnId>-*` | **回合结束删本轮文件** | 与回合一一对应；`refs/result-NNNN.txt` 无 turnId 前缀，留给 TTL |
| `scratch/qa` `docx` `data` `tmp` | **保留，TTL 30 → 7 天** | 跨轮复用的草稿（例如上一轮写好的 spec），清早了要重做 |
| `scratch/preview`、`.analysis-cache` | 不动 | 纯缓存，由各自的 TTL/覆盖逻辑管理 |

- 触发点：`pilotdeck-bridge.js` 的 `turn_completed` 事件（正常结束 / 失败 / abort 三条路径都会发）。
  **不用 SSE `done`** —— 那是传输层结束，客户端断线也会触发，会误删还在跑的回合。
- 执行：`ui/server/services/scratchTurnCleanup.js`，fire-and-forget；路径全部经
  `within(scratchRoot, target)` 校验，符号链接不跟随；任何异常只记 `log.warn`，**永不阻断回合结束**。
- 开关：`workspace.quota.cleanOnTurnEnd`（默认 `true`）。设为 `false` 时只保留 TTL 兜底，
  适合排障期需要回看中间产物的场景。
- 已知缺口：`registerAlwaysOnNotificationForwarding` 里的 `turn_completed`（定时任务 / always-on 会话）
  没有挂清理 —— 那里没有 `projectKey`，无法定位工作区。这部分靠 TTL 兜底，
  表现为"这类会话的 `work/` 最长留 7 天"。

**实现注记（2026-11-12，立即清理改成强制模式）**

第一版的「立即清理」只是"现在跑一次自动规则"，于是刚生成的数据（未满 7 天、总量远没到 1 GiB）
一条都不会删，返回"没有可清理的内容"——按钮名和实际效果不符。改为两档语义：

| 调用方式 | 行为 |
|---|---|
| `POST …/scratch/clean`（无 body） | 跑一次自动规则（TTL + 容量），非破坏性。保留给定时任务/脚本 |
| `POST …/scratch/clean` `{force:true, confirm:true}` | **立即清理**：不看 TTL、不看容量，能删的全删 |

强制模式的边界：

- 仍保护 **最近 60 秒**内部有写入的单元（正在跑的回合），以及工作区根 `.pinned`；
- 不碰 `exports` / `inbox` / 用户自建目录 / `.trash`；
- 缺 `confirm: true` 直接 400 `confirm_required`，前端必须二次确认；
- 审计 `reason: 'manual'`。

同时补了三处覆盖漏洞：

1. 扫描目录从 4 类扩到 8 类：`tool-results` `preview` `work` `qa` `tmp` `qc` `docx` `data`；
   `scratch/` 根下散落的文件/目录（`_t1.txt`、技能自建的 `arch_diagram/`）也纳入，隐藏项除外。
2. `work/` **按回合拆单元**：`work/<session>/<turn>/` 各自独立删，不再"整个会话同生共死"；
   回合删完若会话目录空了，顺手 `rmdir`（骨架 `scratch/work` 保留）。
3. 目录的 `lastUsedAt` 改为**子项 mtime 最大值**，空目录才用目录自身 mtime。
   目录 mtime 只反映"最后增删条目"，文件被覆盖时不变；拿它做过期判断两个方向都会误判。

**实现注记（2026-11-12，工作区面板：拖拽移动 + 文案）**

拖拽移动（`FilesV2` 目录树）：

| 规则 | 说明 |
|---|---|
| 不可拖 | `exports` / `inbox` / `scratch` **只有骨架本身**不可拖，里面的文件/目录照常可拖 |
| 可落点 | 任意已存在的目录行、列表空白处（= 工作区根）、**面板底部整块**（回收站板块 + 它下方所有空白） |
| `scratch` | 允许拖入（用户的明确动作）；前端在成功后提示"scratch 会被定期自动清理" |
| 拒绝操作 | 目标已有同名项（409）、把目录拖进自己（400）、跨文件系统（400） |
| 效果 | 目录内移动走 `rename`（原子）；拖到回收站走 `.trash`（7 天自动释放，可恢复） |

- 接口：`POST /:projectName/files/move`（`{from, toDir}`）与 `POST /:projectName/files/trash`（`{path}`），
  都复用 `normalizeNewPath` + `resolveInsideRoot` + `assertNoSymlinkOnPath`，逐段拒绝 `..`/隐藏名/软链。
- 审计：`file.move`（`reason: drag-move`，`meta.to`）与既有的 `file.trash`。
- 回收站反馈：拖到该区块时整块变红，面板底部浮起**由下往上的灰色渐变蒙层**（只覆盖面板底部 40%，
  最深在底部 `from-black/55` → `to-transparent`），中央是一个小的红色垃圾桶（`animate-bounce`）。
  没有文案。移出或松开（`dragleave` / `drop` / `dragend`）即消失；蒙层 `pointer-events-none` 不挡落点。
- 只做前端拖拽，不提供"剪切/粘贴"；拖拽过程中同名列高亮为落点。

文案与布局：

- 用量条顺序改为 **工作区总量 → inbox → scratch**；
- 原"可读 / 可写 / 只读"能力卡换成三个默认目录的一句话说明
  （inbox 上传原件只读、exports 成品、scratch "中间产物，会自动清理，可手动立即清理"）；
- "立即清理 scratch" 是 **scratch 进度条正下方的小字下划线按钮**（与 inbox 那行"上传原件不会自动清理"
  同字号同颜色，hover 变前景色，鼠标移上去能看出是按钮）；
- 工作区总量那条的说明随占用变化（4 档：正常 / 60% / 80% / 95%），只给建议，
  **任何一档都不拦截写入**；
- 头部"新建目录 / 上传文件 / 刷新"三个按钮统一成 8×8 图标按钮，悬停时在按钮**上方**弹一个
  贴合主题的气泡（前景色底 + 背景色字 + 同色小箭头），气泡本身不吃鼠标事件；
- 原底部提示"只有 scratch 会被自动清理…"删除（信息已并入说明卡）。
- 面板顶部提示（成功/失败）**4 秒后自动消失**，不再常驻。

> 实现细节：气泡复用 `ui/src/shared/view/ui/Tooltip.tsx`。该面板根节点有 `overflow-hidden` +
> `backdrop-blur-sm`，普通 `absolute` 气泡会被裁掉，所以必须走 portal + `position: fixed`。
> 为此给 `Tooltip` 加了可选 `arrowClassName`（箭头颜色跟随自定义气泡），默认行为不变。

#### 8.7.3 删一个项目到底删什么（2026-11-12 定稿：真删）

删项目 = **物理删除，不留归档、不进回收站**。
实现分两层：`ui/server/projects.js` 的 `deleteProject()` 负责编排，
`ui/server/utils/projectDelete.js` 的 `purgeProjectStorage()` 只做文件系统删除
（刻意不 import gateway / DB，方便单测直接加载）。

**顺序是刻意的：先能失败的，后不可逆的。**

| 步 | 动作 | 失败时 |
|---|---|---|
| 0 | **校验 `confirmName`**：必须等于项目展示名（也接受项目 id / 调用方传入的名字），不符抛 `CONFIRM_MISMATCH` → HTTP 400 | 什么都不做 |
| 1 | 读 `chats/*.jsonl` 得到会话列表（`.pre-rewind` 影子副本不算独立会话），对**在跑**的会话逐个 `abortViaGateway()` | 只记日志，继续（不能因为掐不动就留着项目） |
| 2 | 删网关里绑到该 `projectKey` 的定时任务（5s 超时，best-effort） | 只记日志，继续 |
| 3 | `purgeProjectStorage()` 删磁盘（见下表 5 处） | 抛 `PROJECT_PURGE_FAILED`，带 `stage` + `target`，**明确"删到哪一步断了"** |
| 4 | `sessionNamesDb.deleteNamesForSessions()` 清 `session_names` 行 | 只记日志（磁盘已经没了，名字行是最后一点痕迹） |

磁盘上删的 5 处：

| # | 内容 | 路径 |
|---|---|---|
| 1 | 工作区（exports / inbox / scratch / `.trash` / `.pilotdeck` 全部） | `workspaces/<类型>/<项目>/` |
| 2 | 项目身份与会话（`meta.json`、`.cwd`、`chats/*`、file-history、subagents、rewind 备份） | `projects/<类型>/<项目>/` |
| 3 | 旧扁平布局（历史遗留，存在才删） | `projects/<项目ID>/` |
| 4 | 项目记忆（L0 `control.sqlite` + L1/L2 markdown + `cases/`） | `memory/<类型>/<项目>/` |
| 5 | 常驻任务（`runs/`、`run-history.jsonl`、锁） | `always-on/projects/<项目>/` |

也就是说，**删项目 = 记忆、对话、成品文件全部真的没了**（和删会话相反：删会话只删 L0，保留 L1/L2）。

仍然不动的：

| 内容 | 状态 |
|---|---|
| 审计 / telemetry / logs / `router/events.jsonl` | 不动（合规留痕，与项目无关） |
| 外部关联仓库（`app.addProjectManually` 注册的宿主机路径） | **一个字节都不动**，只解除注册 |
| `archives/users`（账号归档） | 不动，属于另一套生命周期（§9.2.2） |

**为什么前端要"输入项目名"**：这是唯一不可恢复的破坏性操作，勾选框点两下就没了太轻。
两处入口（侧边栏「删除项目」、存储页「删除项目」）都要用户手打展示名，
服务端再核一遍——不信任前端。

**历史存量的收尾**：项目归档下线后，`<home>/archives/projects/` 与整包回收站
`<home>/.trash/groups/` 都没有写入方了，留着就是"没入口也没人删"的死数据。
`ui/server/services/legacyProjectArchives.js` 在服务启动时清空这两处（不跟符号链接，
`archives/` 变空则收掉父目录，`archives/users` 天然保留）。
`src/pilot/retention.ts` 同时移除了 `pruneArchives` 阶段与 `archiveMaxAgeDays` 配置。

> 结论口径：对用户要说的是"**删项目后，工作区文件、全部对话、项目记忆、定时任务都没了，无法恢复**"。
> 不再有"30 天内可从归档找回"这回事。

#### 8.7.4 删除阶梯与全部自动清理清单（2026-11-12）

系统的"删"现在是**两级阶梯 + 一个例外**：

| 级 | 层 | 位置 | 保留 | 恢复粒度 |
|---|---|---|---|---|
| 1 | 回收站（文件级） | `<工作区>/.trash/<原相对路径>.<stamp>` | 7 天 | 单文件 / 单目录，原路径恢复 |
| 2 | 物理删除 | — | — | 不可恢复 |
| 例外 | 删项目 | 直接物理删除（§8.7.3） | **0** | 不可恢复 |

为什么删项目**不**进回收站：

- 回收站治的是**手滑**：短期、逐项、可放回原位，粒度到单个文件。
- 删项目是**意图明确**的整体动作。整包进回收站会一次产生几百个条目，
  页面既没法按项目整体恢复，也和"要腾空间"的初衷相反（回收站照样占盘）。
- 所以把"难回头"这件事前移到**输入项目名确认**上，而不是靠一层可恢复的垫子。

> 历史：项目归档（`archives/projects`，30 天）与整包回收站（`.trash/groups`，7 天）
> 已于 2026-11-12 下线，存量在服务启动时清空（`legacyProjectArchives.js`）。

全部自动清理 / 轮转一览（`*` = 有配置项）：

| 对象 | 位置 | 周期或 TTL | 触发 | 用户可见 |
|---|---|---|---|---|
| 工作区回收站 | `<工作区>/.trash` | 7 天 | 服务启动 + 每天 | 是（工作区面板） |
| 已归档账号 | `<root>/archives/users` | 30 天\*（`archivedUserMaxAgeDays`） | 服务启动 + 每天 | 是（设置 → 用户 → 已归档账号） |
| `scratch` 四类 | `<工作区>/scratch/{work,preview,qa,tool-results}` | TTL 7 天\* + 上限 1 GiB\* | 启动 + 每 6 小时；也可手动"立即清理" | 是 |
| 回合目录 | `scratch/work/<会话>/<轮次>/`、`scratch/tool-results/<轮次>-*` | 回合结束即删\* | agent 回合收尾 | 是（间接） |
| 工作区 `.pilotdeck` **整目录** | `<工作区>/.pilotdeck/**`（`tool-results/`、`plans/`、任何自建子项） | 14 天\*；其中 `tool-results/<会话>` 若是孤儿再给 1 小时宽限 | 启动 + 每 6 小时 | 否 |
| 回退备份 | `<chats>/.rewind-backups/<会话>.<ts>.jsonl` | 每会话留 3 份 + 30 天 | 启动 + 每 6 小时 | 否 |
| 记忆库 L0 孤儿行 | `memory/<类型>/<项目>/control.sqlite` | 每天一次 | 启动 + 每天 | 否 |
| 粘贴附件临时目录 | `os.tmpdir()/pilotdeck-chat-attachments/<用户>`、`<home>/.tmp/chat-attachments` | 7 天\* | 服务启动；retention 每日 | 否 |
| 日志轮转 | `<home>/logs/*.log` | 20 MB × 保留 5 份\* | 主服务进程每天 | 否 |
| 删会话 | 见 §8.7.2（10 类） | 立即 | 用户点删除 | 是 |
| 删项目 | 见 §8.7.3（5 处全删，不留归档） | 立即 | 用户点删除 + 输名确认 | 是 |

**没有**自动过期的：

- `exports/`（用户成品）、`inbox/`（我的资料）；
- 审计日志 `<home>/system/audit`、`telemetry/queue.jsonl`（有 2000 条队列上限）、
  `router/events.jsonl`（仅在 `PILOTDECK_ROUTER_DEBUG=1` 时写，无轮转）；
- `system/migration/history/**` 迁移备份；

`.pilotdeck` 的例外项（**不** TTL）：`skills/`、`commands/`、`mcp.json`、`settings.json` ——
这四个是人工配置而不是过程数据，工作区里通常不存在，真有人手工放进去就保留。
另外 `<home>/.pilotdeck`（单用户模式下就是应用主目录本身）只清 `tool-results`，
不去碰其它内容。

> `.pilotdeck/` 是什么（用户问过，记在文档里省得再解释）：
> 工作区里的隐藏目录，存**过程性**数据 —— `tool-results/<会话>/` 是超出内联预算的
> 大工具输出（图片 base64、长文本、大 JSON）的落盘缓存，`plans/` 是计划模式的草稿。
> 它不在工作区面板里显示（`.` 开头的目录一律隐藏），也不是用户的成品目录；
> 删会话时如果它空了会被一并收掉；否则**整个目录按 14 天 TTL** 清
> （用户要求"`.pilotdeck` 的所有内容都加 14 天 TTL"）。

两处"配置项在、逻辑没接线"的，别被误导：

- `workspace.quota.snapshotRetentionDays`（覆盖快照 7 天）：§6.2 的覆盖快照尚未落地，
  实际覆盖保护走的是 `<chats>/<会话>/file-history`，随会话一起删；
- `multiUser.retention.*` 这组（logs / 附件 / 归档）由 **`src/cli` 的主服务进程**
  `startRetentionTimer` 启动，不归 `ui/server` 管；只跑 `ui/server`（纯前端开发态）时这组不生效。

---

## 9. 管理员配置页面

### 9.1 定位

在「设置」中新增一页 **工作区与配额**，仅管理员可见。
天然复用现有配置链路：`/api/config` 已是管理员专用（`apiRouter.js` 的 `requireAdminChain`），
且已有原子写、备份、`reloadPilotDeckConfig()` 与广播。

### 9.2 页面字段

| 字段 | 类型 | 默认 | 校验 |
|---|---|---|---|
| 单会话 scratch 上限 | 数字（MB/GB） | 1024 MB | >= 64 MB |
| 软阈值比例 | 滑块 | 80% | 50%–95% |
| 单会话工作区告警值 | 数字 | 5 GB | >= 1 GB |
| 单用户总量告警值 | 数字 | 20 GB | >= 1 GB，且 >= 单会话告警值 |
| scratch TTL | 数字（天） | 7 | 1–365 |
| 保护窗 | 数字（分钟） | 10 | 0–1440 |
| 覆盖快照保留 | 数字（天） | 7 | 1–90 |
| 影像类会话覆盖值 | 数字 | 2 GB | 同单会话上限 |

> **没有"拒绝写入值"这个字段。** 配额在 8.0 已定为纯告警，
> 页面上任何"超限后禁止写入"的开关都不得出现。

页面同时展示（只读）：

- 当前全用户实际占用（来自 `storageUsage.js`，60 秒缓存）
- 占用 Top 5 工作区
- 最近 24 小时的清理记录（次数、释放字节）

### 9.2.1 各用户目录占用总览（管理员必看）

**需求方明确要求**：管理员要能一眼看到每个用户个人目录（`<PILOT_HOME>/users/<id>`）占了多少空间，
用于判断"是不是该提醒某个用户清理"。

现状：这条链路**后端已经通了**，本轮以"补齐展示"为主，不要重复实现：

| 已有 | 位置 |
|---|---|
| 单用户目录字节数（`lstat` 遍历、不跟随软链、60s 缓存、永不抛错） | `ui/server/services/storageUsage.js` → `getUserStorageBytes()` |
| `GET /api/admin/users` 已返回 `storageBytes` 字段（并发计算） | `ui/server/routes/adminUsers.js:37` |
| 设置页「用户」表格已有"存储"列 | `ui/src/components/settings/view/users/index.tsx:194` |

本轮要补的是**管理视角**，不是重复统计：

| 项 | 要求 |
|---|---|
| 合计 | 页头显示"全部用户合计 X GB"，并显示用户数 |
| 排序 | "存储"列可点击排序（升/降），默认按占用降序，便于一眼看到 Top |
| 占比 | 每行附"占全部用户的比例"（如 12.3%），比绝对数字更容易判断是否异常 |
| **`inbox` 占比（2026-11-11 新增）** | 每行增加"其中 inbox / 上传原件"列：`<inbox 字节>` + 占该用户比例。理由：inbox 是唯一不自动清理、又最容易暴涨的部分，管理员判断"该提醒谁清理"只能看这一列 |
| 阈值着色 | 超过 `单用户总量告警值` 的行标黄；**只着色，不提供"停用账号"之类的快捷操作** |
| 刷新 | 沿用 60s 缓存；提供手动刷新按钮，点击时调用 `invalidateStorageCache()` 后重取 |
| 归档用户 | 已归档（archived）用户的目录同样计入合计，但单独标灰，避免"总和对不上" |
| 越权 | 普通用户访问 `/api/admin/users` 必须 403（已有 `requireAdminChain`，加测试锁定） |

验收：

1. 管理员打开设置 →「用户」，能看到每个用户的目录占用、排序、占比、合计。
2. 某用户写入 1 GB 文件后，60 秒内该行数字更新。
3. 普通用户请求 `/api/admin/users` 返回 403。
4. 某用户上传 500 MB 到 `inbox` 后，`inbox` 列数字同步上涨，且**与总量列口径一致**（合计 ≤ 总量）。

> **实现注记（2026-11-11）**：本文条已落地。`storageUsage.js` 一次遍历同时产出
> `bytes` / `inboxBytes`（只认 `workspaces/<id>/inbox` 与 `workspaces/<typeKey>/<id>/inbox`），
> 新增 `listArchivedUserBytes()` 把 `archives/users/<id>-<stamp>` 计入合计并在行上标「已归档」，
> `getUserTotalWarningBytes()` 读 `workspace.quota.userTotalMaxBytes`、缺配置回落 20 GiB。
> `GET /api/admin/users` 增加 `inboxBytes` / `archivedBytes` / `storage{}`，`?refresh=1` 清缓存后重算。
> 前端列数 7 → 9（新增「占比」「其中 inbox」），存储列表头可切换升/降序（默认降序）。
> 未做：配额编辑表单（留第二批）。

#### 9.2.2 已归档账号：单独展示 + 恢复 + 到期清理（2026-11-12）

删账号是**软删除**：`users` 行留着（`is_active = 0`），home 搬到
`<root>/archives/users/<id>-<stamp>/`。这一步以前只有"删除"，没有"看"和"回滚"，等于挖了个坑。

现在补齐三件事：

| 事项 | 实现 |
|---|---|
| 单独展示 | `GET /api/admin/users` 每行带 `archived` / `archivedAt` / `expiresAt`，另有顶层 `archivedUsers`（按归档时间从新到旧）。页面主表只留在用账号，下方「已归档账号」独立一张表：用户名、角色、归档时间、到期时间、占用、[恢复账号] |
| 恢复 | `POST /api/admin/users/:id/restore`：`archives/users/<id>-<stamp>` → `users/<id>`，`is_active = 1`，`token_version + 1`（旧登录态全部失效），写审计 `user.restore` |
| 到期清理 | `services/archivedUsersRetention.js`：启动跑一次 + 每天一次；超过 `multiUser.retention.archivedUserMaxAgeDays`（默认 **30 天**）就删目录 + 删行（含会话名 / API key / 推送订阅 / 通知偏好 / git 凭据） |

恢复与清理都宁可**拒绝**也不猜：

- 活跃 home 已存在 → 恢复回 409 `HOME_EXISTS`；
- 找不到归档 → 404 `NOT_ARCHIVED`；
- 清理时若账号已被恢复（`is_active = 1`）或活跃 home 已存在 → **跳过**，只记日志；
- 目录删失败 → 保留账号行，下次再试（不能出现"目录没了、行还在"之外的半套状态）。

> 注意与**删项目**的区别：项目归档已于 2026-11-12 下线，删项目就是物理删除（§8.7.3），
> 没有可恢复的中间态；只有账号归档还保留 30 天窗口，且必须连 SQLite 行一起删，
> 否则用户名永远占着、页面永远挂着一个不可恢复的灰行。

### 9.3 交互与安全

| 事项 | 处理 |
|---|---|
| 调低告警阈值 | 二次确认，并提示"预计 X 个会话将变为告警状态"（不提"清理"，因为不删也不拦） |
| 保存 | `PUT /api/config`，原子写 + 保留上一版备份 |
| 生效 | `reloadPilotDeckConfig()` + **广播给所有在线 gateway** |
| 校验失败 | 前端即时提示 + 后端 400，错误信息指出具体字段 |
| 普通用户 | 只读看到自己会话的配额与用量，不可改、看不到全局数值 |
| 审计 | 记录：操作人、字段、旧值、新值、时间 |

### 9.4 必做项（容易被忽略）

> **当前 `POST /api/config/reload` 只通知当前用户的 gateway**（`getPilotDeckGateway()`）。
> 多用户部署下，管理员保存后其他用户的 gateway 可能仍用旧配额。
> 本轮必须补：`gatewayPool` 暴露 `reloadAll()`，或在保存后逐用户广播 `reload_config`。

验收：A 管理员改配额 → B 用户（已在线）刷新页面即看到新上限，无需重启。

### 9.5 配置落点

```yaml
workspace:
  quota:
    scratchMaxBytes: 1073741824
    scratchSoftRatio: 0.8
    userTotalMaxBytes: 21474836480
    scratchTtlDays: 7
    cleanOnTurnEnd: true      # 回合结束即删本轮 work/ 与 tool-results；排障时可临时改 false
    protectRecentMinutes: 10
    snapshotRetentionDays: 7
    overrides:
      imaging: { scratchMaxBytes: 2147483648 }

multiUser:
  retention:
    archivedUserMaxAgeDays: 30   # 已归档账号保留期；过期删归档目录 + 账号行
    attachmentMaxAgeDays: 7      # 粘贴附件临时目录
    logMaxBytes: 20971520
    logKeep: 5
```

YAML 覆盖 `DEFAULT_RESOURCE_LIMITS`；代码默认值保持可运行（无配置也能启动）。

> `cleanOnTurnEnd` 目前只走 YAML（管理员页面不暴露），属于排障开关，不是日常配额。

---

## 10. 命令边界（第 4 条的 A/B 档）

### 10.1 不做的事

不改模型可见的工具集、不改任何 `SKILL.md`、不改 `bash/permissions.ts` 的正则。

逐条确认现有能力不受影响：

| 能力 | 是否受影响 | 原因 |
|---|---|---|
| Agent 读取 `SKILL.md` / `reference` | 不受影响 | `skills/` 只读挂载；`pathSafety` 对读操作有 `<appRoot>/skills` 白名单 |
| Agent 执行 skill 脚本 | A 档不受影响；B 档按 10.3 配套后不受影响 | 脚本在只读目录，执行本身不需要写权限 |
| 调用远程服务（模型、业务接口） | 不受影响 | 走 Gateway 进程内 `src/network/fetch.ts` + `serviceRegistry`，不经过 bash 沙箱 |
| MCP / plugins | 不受影响 | `<appRoot>/plugins` 只读挂载 |
| bash 里的 `curl` / `wget` | 仍被拒绝 | 现有黑名单，刻意保留（防止绕过服务白名单） |

### 10.2 A 档：确认沙箱真的在生效（0.5 天）

- Gateway 启动日志应出现 `[sandbox] bwrap (ok)` 或 `[sandbox] sandbox-exec (ok)`
- 探测失败时：多用户模式**拒绝启动**（已有），单用户模式**显式告警并禁止联网**（需补）
- 补启动自检：`grants().writable` 不得包含 `system/`、`pilotdeck.yaml`、其他用户目录（已有 `assertSandboxGrantsSafe`）

### 10.3 B 档：可写范围收窄（1–2 天）

现状：`writable = grantForms(userHome)` —— 整个用户目录可写。

目标：

```
--ro-bind  <userHome>          <userHome>
--bind     <scope.root>        <scope.root>
--ro-bind  <appRoot>/skills    <appRoot>/skills
--ro-bind  <appRoot>/.runtime  <appRoot>/.runtime
```

macOS 的 SBPL profile 同步调整（`writeDirs` 换成 `scope.root` + 必要临时目录）。

**前置动作（必做）**：把现有 8 个 skill 各跑一遍真实任务，记录实际写入路径。
这份清单是"可写白名单"的唯一依据，不要凭推测写。

风险：若某 skill 往 `~/.cache` / `~/.config` / `/tmp` 之外写东西，收窄后会失败。
缓解：`grants.ts` 的 `skillCacheEnv()` 已把 PDF/DOCX/PPTX/XLSX 缓存重定向到
`<appRoot>/.runtime/cache/xdg/*`（只读预置），需实测确认完整。

**已核实的三个具体点**：

1. 4 个文档 skill 的运行时是预置只读的：`pdf` 的 venv 内有 `python3.12`，
   `docx` 的 venv 内有 `python3.13`；`skillCacheEnv()` 已把
   `PDF_SKILL_CACHE` / `DOCX_SKILL_CACHE` / `PPTX_SKILL_CACHE` /
   `SPREADSHEET_SKILL_CACHE` 指向 `<appRoot>/.runtime/cache/xdg/*`，
   且 `pdf.sh` 自身拒绝现场安装，因此不会触发 pip。
2. `frontend-slides/scripts/export-pdf.sh` 使用 `mktemp -d`，依赖 `TMPDIR`；
   macOS 下沙箱把 `TMPDIR` 设为 `<userHome>/.tmp`，收窄后不可写 → 会失败。
3. macOS 下沙箱把 `XDG_CACHE_HOME` 设为 `<userHome>/.cache`
   （fontconfig / node 缓存），收窄后同样不可写。

因此 B 档必须配套：

- 把 `XDG_CACHE_HOME` / `TMPDIR` 重定向到 `<scope.root>/scratch/.sys-cache`、`scratch/.sys-tmp`
- 这两个目录登记为可写，并纳入 `scratch` 配额
- `HOME` 仍指向 userHome（只读），避免脚本读到不存在的家目录

网络出口不在本节处理：`selectSandbox()` 的 `network` 默认是 `true`，但
**在 macOS 上该配置完全不生效**（见 10.5）。离线断网必须先修 10.5，再谈可写范围。

### 10.4 为什么暂不做类型化工具（A+）

| 项 | 量级 |
|---|---|
| 10 个文件工具 + 5 个文档工具 | 13–18 天 |
| 8 个 `SKILL.md` 与入口重写 | 3–5 天 |
| 全量回归 | 5 天 |
| 合计 | **3–4 周**，且是破坏性接口变更 |

重新评估的触发条件（满足任一）：

1. 命令被拒率 > 10%
2. 单任务平均重试次数 > 2
3. 出现实际越界写入事故

### 10.4.1 只接线「注册命令白名单」，不做全量类型化（2026-11-11 决定）

**背景**：`src/security/policy/`（709 行）已经写好了完整的 `registered_only` 命令策略，
但**全仓没有任何消费者**（`grep commandPolicy` 在 `src/security/policy/` 之外为 0 命中）。
其中 `TaskReadRoot = inbox|scratch|exports`、`TaskWriteRoot = scratch|exports`、
按 id 白名单 + 选项白名单 + 超时，正好是 `data-analysis` 需要的"唯一口子"。

**决定**：把 `PolicyStore` 接进 `classifyBashPermission()`，只做"白名单内放行 / 白名单外拒绝"
两件事，**不重写任何 skill 接口**（与 10.4 的 A+ 区分开）。

| 项 | 内容 |
|---|---|
| 接线点 | `src/tool/builtin/bash/permissions.ts` → `classifyBashPermission()`：`HARD_DENY` 之后、`ask` 之前插一层策略判定 |
| 判定顺序 | ①`HARD_DENY`（不变）→ ②**注册命令命中且选项/读写根/超时全部合规 → allow** → ③只读命令（`isReadOnlyShellCommand`）→ passthrough → ④其余 → ask |
| 白名单来源 | `<PILOT_HOME>/system/security/command-policy.yaml`（`PolicyStore` 已有 revision 乐观锁与软链拒绝） |
| 首条注册命令 | `data-analysis.run`（契约见 `data-analysis-skill-design.zh.md` §2），参数 `--script/--input/--out`，`inputRoots=[inbox,scratch,exports]`、`outputRoots=[exports]`、`timeoutMs=600000` |
| 失败语义 | 策略文件非法 → **fail-closed**：不放行，回落 `ask`，并写审计 |
| 明确不做 | 不把 `ls/cat/git` 等只读命令纳入白名单（它们走第 ③ 步）；不登记任何可写出网命令 |

**验收**：`data-analysis` 单条命令**零弹窗**通过；把命令改成 `python3 /tmp/x.py` 仍然 `ask`；
策略 YAML 写坏后 Gateway 不放行且审计有记录。

#### 10.4.2 实现落点与实测（2026-11-11 完成）

| 文件 | 作用 |
|---|---|
| `src/security/policy/skillCommandSpecs.ts`（新） | 非文档类技能的命令表面，id 形如 `data-analysis.run`；只登记运行入口，**不登记 `bootstrap-runtime`** |
| `src/security/policy/parseCommandPolicy.ts` | 注册表新增 `data-analysis.run`（读 `inbox,scratch,exports` / 写 `exports` / 上限 30 min）与 `data-analysis.check` |
| `src/security/policy/registeredCommands.ts`（新） | 匹配器：只认 `skills/<skill>/scripts/*.sh <subcommand>`；选项逐字命中、**不支持 `--flag=value`**；路径型选项做根校验（拒绝 `..` 与绝对路径逃逸） |
| `src/security/policy/commandPolicyRuntime.ts`（新） | 按策略文件 **mtime** 缓存快照：管理员改 YAML 后自动生效，无需重启；解析失败**不缓存成允许** |
| `bash/sandbox/networkPolicy.ts` | 抽出 `simpleInvocationTokens()`，让"能不能出网"与"能不能免弹窗"共用同一分词口径 |
| `bash/permissions.ts` + `bash.ts` | `classifyBashPermission(command, {cwd, env})`：`HARD_DENY` → **注册命令合规 → allow** → 只读 → `ask` |

**三档结果（已实测）**

| 情况 | 结果 |
|---|---|
| 已登记 id + 选项/路径全合规 | `allow`，零弹窗，审计 `bash.registered_allowed` |
| 已登记 id + **路径越根**（如 `--out inbox/x`） | `deny`，不可点通过，审计 `bash.denied`（`registered-violation:*`） |
| 未登记 id / 选项未登记 / `--flag=value` / 命令形状不认识 / 策略文件坏 | **回落** `ask` 或只读判定，审计 `policy.invalid`（仅策略坏时） |

> **行为变化（需要知道）**：`DOCUMENT_COMMAND_SPECS` 里已登记的 `pdf/docx/pptx/spreadsheets/diagram` 子命令，
> 只要选项合规、输出落在 `scratch|exports`，现在也**不再弹窗**。这是 §10.4.1 的直接结果；
> 若某个子命令不想自动放行，在 `system/security/command-policy.yaml` 里把它的 `enabled` 设为 `false` 即可（无需改代码）。

### 10.5 网络出口策略（B 方案，2026-11-10 确认）

**目标**：macOS（开发）与 Linux（交付）两端都真正断网，同时不破坏现有 skill 与工具调用。

#### 10.5.1 三个已核实的事实

| # | 事实 | 证据 |
|---|---|---|
| N1 | Linux 上 `network: false` **真生效** | `bwrap.ts:78` 加 `--unshare-net`；回归 `bwrap.spec.ts:76` |
| N2 | macOS 上 `network: false` **完全不生效**（配置根本没传进去，profile 写死） | `sandboxExec.ts:14-19` 无 `network` 字段；`sandboxExec.ts:63` 写死 `(allow network*)`；`sandboxExec.spec.ts:46` 还断言它必须存在 |
| N3 | `network` 默认值 = `true`（**不隔离**） | `parseMultiUserConfig.ts:89`，且 `.pilotdeck.yaml` 未显式配置 |

2026-11-10 在 macOS 上用仓库生成的真实 profile 实测：`sandbox-exec` 内
`connect 127.0.0.1` 返回 `0`（成功）；把规则换成 `(deny network*)` 后返回 `1`（EPERM）。
这证明 N2 —— 当前 macOS 侧的网络限制处于「配了但没生效」状态。

#### 10.5.2 全仓扫描：谁真的需要出网

| 类别 | 位置 | 需要网络 |
|---|---|---|
| 文档渲染 | 6 个文件 / 12 处调用（`office-renderer-client.mjs`、`docxlib/{render,convert}.py`、`pptx/lib/{render,convert}.mjs`、`spreadsheet_cli.mjs`） | 是，目的地唯一：`10.31.112.13:19400` |
| 本机回环 | `skills/frontend-slides/scripts/export-pdf.sh:199` | 连本机 `127.0.0.1:<临时端口>`，**`--unshare-net` 下仍可用**（已实测，见 10.5.7） |
| `pdf` / `diagram-maker` / 其余 skill | — | 否（`pdf_cli.py:184` 甚至主动拒绝远程图片） |
| 网关进程内（模型、med-tools MCP、`office_to_pdf`、UI 预览、IM 渠道） | `src/**`、`ui/server/**` | 是，但**不经 bash 沙箱**，不受本策略约束 |

#### 10.5.3 B 方案（已确认，不做 A）

| 技能分组 | Linux（交付 / node12） | macOS（开发） |
|---|---|---|
| `data-analysis`（待实现） | `none` | `none` |
| `docx` / `pptx` / `spreadsheets` | `open`（过渡） | `allowlist`（**端口级** `*:19400`，见 10.5.9） |
| `frontend-slides` | `none` | `none` |
| `pdf` / `diagram-maker` / 未匹配命令 | `none` | `none` |

**明确不做**：Unix socket 转接口、netns + veth、Linux 端口级白名单、渲染链路网关化重构。

原因：Linux 的 `--unshare-net` 是二元的，做不到「只放一个端口」；要做只能上 UDS 或 netns，
两者都是 2–3 天量级，且会引入新的出口面。B 方案先用「按技能分组」把风险收敛到
`data-analysis` 这个真正需要硬保证的技能上。

#### 10.5.4 必须补的两件事

| # | 事项 | 说明 |
|---|---|---|
| 1 | macOS 让 `network` 真正生效 | 三态 `none` / `allowlist` / `open`；参数真正传入 `SandboxExecConfig` 与 `buildSandboxProfile` |
| 2 | 启动网络自检 | 在沙箱内实跑 4 条探针；`none` 档下任一可达 → **拒绝启动**（fail-closed） |

`allowlist` 在无实现平台上必须**启动报错**，不得静默降级为 `open` —— 这正是 N2 的教训。

~~第 3 条：`frontend-slides` 回环兜底~~ —— 10.5.7 实测证明不需要，已删除。

#### 10.5.5 启动自检的探针定义

| # | 探针 | `none` 期望 | `allowlist` 期望 |
|---|---|---|---|
| N1 | 沙箱内自起监听后**自连** `127.0.0.1` | **成功**（保证 skill 内自起服务可用，见 10.5.7） | 成功 |
| N2 | 连**宿主**已在监听的 `127.0.0.1:<端口>` | 失败（宿主回环隔离） | 失败 |
| N3 | 连 `10.31.112.13:19400` | 失败 | **成功**（反向断言，防「过严把功能弄坏」） |
| N4 | 连 `1.1.1.1:443` | 失败 | 失败 |
| N5 | `gethostbyname('example.com')` | 失败 | 失败 |

⚠️ N1 必须**期望成功**：若写成「连 127.0.0.1 必须失败」，在 `--unshare-net` 下会因为
「端口没人监听」返回 `ECONNREFUSED` 而假通过，实际上什么都没验证。

#### 10.5.6 已知残余风险

| 风险 | 说明 |
|---|---|
| AF_UNIX 不受 `--unshare-net` 限制 | 任何 bind 进沙箱的 socket 都是一条出口；未来若上 UDS 代理，必须按技能排除 |
| 网关侧能出网 | 模型、med-tools、`office_to_pdf` 都在沙箱外，本策略管不到，只能靠审计 |
| 断网 ≠ 本地安全 | S1–S3、S5–S8、S10–S12 与网络无关，仍依赖 §4 路径校验与单一入口 |

#### 10.5.7 node12 实测记录（2026-11-10）

环境：node12，bubblewrap **0.6.1**，`bwrap --unshare-net`，宿主 `lo` flags = `0x9`（UP）。

| 探针 | 宿主机 | 沙箱内 | 结论 |
|---|---|---|---|
| 宿主已起的 `127.0.0.1:45999` | `exit=0` | `exit=111`（ECONNREFUSED） | 沙箱有自己的回环，看不到宿主端口 |
| 沙箱内自起的 `127.0.0.1:45998` | — | **`exit=0`** | **回环可用** |
| `10.31.112.13:19400` | — | `exit=101`（ENETUNREACH） | 内网被断 |
| `1.1.1.1:443` | — | `exit=101` | 公网被断 |
| `gethostbyname('example.com')` | 可解析 | 失败（`gaierror`） | DNS 被断 |

**两条修正**：

1. `--unshare-net` 之后 `127.0.0.1` **仍然可用**（此前担心的「lo 默认 DOWN」在 bwrap 0.6.1 上不成立）。
   → `frontend-slides/export-pdf.sh` 自起自连的模式**不受断网影响**，可直接归 `none`。
2. Linux 侧的断网效果与预期一致：内网、公网、DNS 全部不可达。**B 方案可以直接落地。**

#### 10.5.8 配置写法与实现状态（2026-11-10，第 1 步已完成）

```yaml
multiUser:
  sandbox:
    network: none           # none | open（allowlist 尚未实现，配了会启动报错）
    networkOpenSkills:      # 这些 skill 允许出网，其余一律按 network 处理
      - docx
      - pptx
      - spreadsheets
    networkAllow: []        # 预留给 allowlist（第 3 步）
```

| 项 | 状态 | 位置 |
|---|---|---|
| `network` 三态解析（兼容 `true`/`false`） | ✅ 已实现 | `parseMultiUserConfig.ts` |
| 按命令里的 `…/skills/<name>/` 判定技能 | ✅ 已实现 | `sandbox/networkPolicy.ts` |
| 命中多个技能时**要求全部在白名单内**，否则落回全局 | ✅ 已实现（fail-closed） | 同上 |
| 白名单只对**单条简单命令**生效（允许 `cd <dir> &&` 前缀；含 `| ; & >` 或 `$(` 一律不放行） | ✅ 已实现 | 同上 |
| bwrap 每次调用可覆盖网络 | ✅ 已实现（`wrap()` 新增 `network`） | `sandbox/bwrap.ts` |
| 启动自检 + fail-closed | ✅ 已实现 | `sandbox/netProbe.ts`、`commandRunner.ts` |
| `allowlist` 显式报错（不静默降级） | ✅ 已实现 | `sandbox/networkPolicy.ts` |
| macOS 三态真正生效 | ✅ 已实现（2026-11-11） | `sandbox/sandboxExec.ts` |
| 端口级 allowlist | ⬜ 第 3 步 | — |

**node12 验证记录（2026-11-10，bwrap 0.6.1）**：

| 场景 | 结果 |
|---|---|
| `network: none` + bwrap | ✅ 自检通过（86 ms），内网/公网/DNS 均不可达 |
| `network: none` + `kind: none`（沙箱被关） | ✅ **拒绝启动**：`宿主回环端口可达；DNS 可解析` |

第二条是关键：沙箱失效时不会「假装断网」，而是启动即失败。

**为什么必须卡「单条简单命令」**：`bash skills/docx/scripts/docx.sh make && python3 evil.py`
里只出现 `docx` 一个技能名，若只看技能名就会把整条复合命令都放行 —— 等于给任意代码开了出口。
这条规则是 2026-11-10 在 node12 实测时发现的真实漏洞。

#### 10.5.9 macOS 三态实测与实现（2026-11-11）

环境：macOS 15.6.1 (24G90)，`/usr/bin/sandbox-exec`，node v22.23.2。

**SBPL 事实（全部实测）**：

| # | 事实 | 证据 |
|---|---|---|
| N6 | `remote ip` **只接受 `*` 或 `localhost`**，写数字 IP 直接报错 | `(remote ip "10.31.112.13:19400")` → `host must be * or localhost in network address`；`tcp` 写法同样失败 |
| N7 | 只能做**端口级**白名单：`(allow network-outbound (remote ip "*:19400"))` | 连 19400 通、连 `1.1.1.1:443` EPERM |
| N8 | 回环必须**出站+入站两条**，只给出站时 `listen` 仍 EPERM | 只配 outbound → 自起服务 `listen-err:EPERM`；补 `(allow network-inbound (local ip "localhost:*"))` 后成功 |
| N9 | 沙箱内**主机名解析全死**，`dns.lookup('localhost')` 也是 ENOTFOUND | `fetch('http://localhost:p')` 失败、`fetch('http://127.0.0.1:p')` 成功 → 沙箱内必须用 IP 字面量 |
| N10 | `remote unix-socket` 各种写法均**无法生效** | literal/subpath/裸路径三种写法实测仍 EPERM |
| N11 | macOS 无法隔离宿主回环（没有 netns） | 甲方案放行回环后，沙箱可连宿主 `127.0.0.1:<port>` |

**落地口径（甲方案）**：

```
none      : (deny network*) + localhost 出站 + localhost 入站
allowlist : 同上 + 每个端口一条 (allow network-outbound (remote ip "*:<port>"))
open      : (allow network*)
```

`networkAllow` 里的 `host` 字段在 macOS 上**不生效**（N6），只取端口；启动日志打印 `allowPorts=...` 以免误解。

**已知让步与风险**：

| 项 | 说明 |
|---|---|
| 宿主回环不再隔离（N11） | 启动自检的「宿主回环可达」在 darwin 上不计为泄漏（`networkIsolationLeaks({allowHostLoopback})`），否则永远无法启动 |
| 端口级 ≠ IP 级（N7） | `*:19400` 允许连任意主机的 19400，只是 DNS 被断，IP 字面量仍可外发 |
| `frontend-slides` 另有两个障碍 | chromium 需要 `(allow mach-register)`（否则 `bootstrap_check_in` FATAL）；脚本运行时还会 `npm install playwright`（离线 `ENOTCACHED`）。两者都与网络档无关，另案处理 |

---

## 11. 审计日志

### 11.1 记录内容

JSONL，只追加，按天分片：`<PILOT_HOME>/system/audit/<YYYY-MM-DD>.jsonl`

```json
{"ts":"2026-11-09T09:01:02Z","userId":1,"workspaceId":"general_med-xxx","turnId":"...",
 "op":"file.write","path":"exports/病例报告.pdf","bytes":2190344,"result":"ok",
 "meta":{"overwrote":true,"snapshot":"scratch/tool-results/snapshots/turn-123/a.pdf"}}
```

事件类型：`file.read`、`file.write`、`file.move`、`file.delete`、`trash.restore`、
`quota.evict`、`quota.exceeded`、`config.change`、`sandbox.denied`、`policy.denied`。

### 11.2 约束

- **不记录文件内容**，只记录路径与字节数（医疗数据最小化原则）
- 写入失败不能影响主流程（失败只打日志）
- 保留 180 天，按天轮转
- 管理员页面可按用户/日期/操作类型检索

---

## 12. 错误语义

统一四类，前端表现完全不同：

| 类 | 含义 | Agent 应做什么 | 前端表现 |
|---|---|---|---|
| `invalid_input` | 参数/路径格式错 | 按提示修正后重试 | 不显示，内部重试 |
| `needs_confirmation` | 需要用户点头 | 停下等待 | 一次确认弹窗 |
| ~~`quota_exceeded`~~ | **已作废**（见 8.0）。空间占用不作为错误，只作为提示；任务照常继续 | 无需处理，正常干活 | 黄色提示条：「占用偏高，可考虑清理」，不打断输入 |
| `policy_denied` | 越界/违规 | **立即终止本轮** | 一条明确说明 |

- 每条错误必须包含：`code`、`message`、`hint`（怎么改）、`path`（相对路径）
- 禁止出现"权限不足"这类无信息量的文案

---

## 13. 本轮不做

| 项 | 理由 | 何时再做 |
|---|---|---|
| 类型化工具替代 bash（A+，全量） | 3–4 周，破坏 skill 接口 | 观察指标达标（见 10.4） |
| ~~注册命令白名单接线~~ | **已于 2026-11-11 移出本表**：只接线不做全量，见 10.4.1 | 已纳入第一批 |
| 可复现导出（记录 skill 版本+参数哈希） | 牵涉全部 skill | 出现"两次生成结果不一致"的实际问题 |
| 只读 / 紧急模式 | 贯穿文件、bash、前端、API | 医院审计期间要求全系统只读时 |
| 文件内容级密级/水印 | 与权限架构正交 | 单独立项 |
| Linux 端口级网络白名单（UDS 转接口 / netns） | `--unshare-net` 是二元的；UDS 要重写两套 HTTP 客户端 | 需要「office 类技能也零出网」时（见 10.5.3） |
| 渲染链路网关化（新增 render/convert 工具） | 9 处调用点 + 3 个 skill 的 CLI 契约重写 | 需要彻底移除 skill 的出网依赖时（见 10.5.3） |

---

## 14. 验收标准（总）

| # | 场景 | 期望 |
|---|---|---|
| 1 | 点项目名旁的文件夹图标 | 右侧滑出原「项目文件」面板，标题为「工作区」，显示三个默认目录 + 能力卡片 |
| 2 | Agent 写 `exports/x.pdf` | 页面可见、可预览、可下载 |
| 3 | Agent 写 `../outside.txt` | `policy_denied`，无文件产生 |
| 4 | 用户点删除 3 个文件（第一批，2026-11-11 改） | 进 `.trash`（7 天），提示"已移入回收站"；批量操作一次汇总确认；**不得真删** |
| 5 | 覆盖同名文件 | 弹一次汇总确认，旧版本可查 |
| 6 | `scratch` 到 85% | 页面变黄提示，任务**不受影响** |
| 7 | `scratch` 到 105% | **仍然照常写入**，只提示 + 记审计；清理上线后改为"清最旧非保护单元"，仍不拒绝 |
| 8 | 管理员把告警阈值改成 512 MB | 所有在线用户 1 分钟内生效，无需重启 |
| 9 | 管理员把告警阈值调到低于当前用量 | 二次确认 + 显示"预计 X 个会话将变为告警"（不涉及删除或拦截） |
| 10 | 普通用户访问 `/api/config` | 403 |
| 11 | 页面任意位置 | 无绝对路径泄漏 |
| 12 | 审计日志 | 上述操作均有记录，可按日期检索 |
| 13 | 沙箱收窄后跑 8 个 skill | 全部成功（或只用已登记的可写路径） |
| 14 | Agent 在 `root` 下新建 `我的资料/` 并写入 | 成功；前端树出现该目录且可浏览 |
| 15 | Agent 写 `inbox/x.txt` | `policy_denied`（inbox 只读） |
| 16 | Agent 写 `.trash/...` / `.usage.json` | `policy_denied`（系统保留） |
| 17 | `scratch` 超出提示阈值（清理未上线） | **不清理、不拦截**，只变黄提示；用户自建目录与 `exports` 完好无损 |
| 18 | 该面板顶部 | 同时显示工作区总量条、`scratch` 条与 `inbox` 条（三条），数值与记账一致 |
| 19 | 目录行 | 显示聚合大小；新增文件后 60 秒内更新 |
| 20 | 点击"立即清理" → 确认 | **强制**清空 `scratch`（TTL/容量都不看），用户目录与 `exports` 不变；60 秒内写入的与 `.pinned` 保留 |
| 21 | 管理员打开设置 →「用户」 | 看到每个用户目录占用、可按大小排序、显示占比与全用户合计 |
| 22 | 普通用户请求 `/api/admin/users` | 403 |
| 23 | 任意一次超阈值写入 | 写入成功，仅页面提示 + 审计留痕（**不得出现拒绝**） |
| 24 | `data-analysis` 脚本里 `socket.connect('127.0.0.1', x)` | 失败（`none` 档） |
| 25 | `data-analysis` 脚本里 `socket.connect('10.31.112.13', 19400)` | 失败（`none` 档） |
| 26 | 文档类 skill 向 `10.31.112.13:19400` 取渲染结果 | 成功（Mac `allowlist`；Linux `open`） |
| 27 | 故意把策略配成 `none` 但沙箱未断网 | **Gateway 拒绝启动**并给出明确原因 |

---

## 15. 工期与顺序（2026-11-11 起移出本文档）

**本文档只保留"是什么 / 为什么 / 边界"。** 所有步骤、顺序、工期、打勾与实测结论统一维护在
[plans/permission-arch-v2-todo.md](./plans/permission-arch-v2-todo.md)；
数据分析技能的细节在 [data-analysis-skill-design.zh.md](./data-analysis-skill-design.zh.md)。

这样拆开的原因：设计文档要稳定，进度表天天变；混在一起会让"顺序"看起来反复被推翻。

| 原编号 | 现位置 |
|---|---|
| 15.1 第一批（两条轨道 + 三个门） | todo §1、§2、§3 |
| 15.2 第二批 | todo §5 |
| 15.3 依赖 skills 完成 | todo §5 末三行 |
| 15.4 全量参考工期 | todo §5 末尾"参考总量" |
| 15.5 网络出口策略（**已完成**） | todo §4.1（留档 + 实测结论） |
| 15.6 数据分析技能 B 轨 | todo §3.2 + `data-analysis-skill-design.zh.md` §2–§6 |

**一句话顺序（记住这一句就够）**：门 0（审计 + 路径三条，2d）→ 之后 A 轨（用户看得见 / 能删 / 知道 inbox 多大）与 B 轨（agent 能安全跑分析脚本）并行，唯一交汇点是门 0 和 B0。

| 门 | 含义 |
|---|---|
| 门 0 | 审计骨架 + 路径校验三条（所有人前置） |
| 门 1 | 删除能进 `.trash`、可恢复 |
| 门 2 | 前端工作区页 + 管理员总览可交付 |
| 门 3 | 数据分析技能可交付（12 条安全用例全绿） |

---

## 16. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 另一个进行中的 skill 改造（`skills/_shared` 等） | 与沙箱收窄、落位规则冲突 | 沙箱收窄排最后；落位规则先兼容旧写法 |
| 沙箱收窄后某个 skill 写入失败 | 任务失败率上升 | 先跑实测清单，再逐个登记可写路径 |
| 配额清理误删 | 用户丢中间结果 | 只清 `scratch`；保护窗 + pinned + 回收站；全程审计 |
| 多用户 gateway 未重载配额 | 管理员改了但用户看不到 | 9.4 的 `reloadAll()` 为必做项 |
| 记账漂移 | 实际占用与显示不符 | 每 6 小时全量校准 |
| 把告警写成阻断 | 医生当场无法保存工作，比磁盘满更严重 | 8.0 已明令禁止；代码不得预留 `assert`/拒绝分支；代码评审时专门检查 |
| **「配了但没生效」**（网络开关静默失效） | 以为已断网，实际全开；macOS 现状即如此 | 启动自检 + `allowlist` 无实现时启动报错（10.5.4） |
| Linux 上 office 类技能仍可出全网 | 数据面留了口子 | 已知并接受（B 方案）；需要收口时再做 UDS / netns |
| **`inbox` 只读只在文件工具层生效，bash 仍可删/改 `inbox`**（2026-11-11 记录） | Agent 可通过 `rm`/`mv`/`cp` 破坏用户上传原件；路径校验（§4.2 第 5 条）只覆盖 `write_file`/`edit_file`/`office_to_pdf` | 已知残留风险。硬门只能靠 §10.3 B 档收窄沙箱可写范围（`bwrap.ts:71` 的 `--bind $PILOT_HOME`、`sandboxExec.ts:103` 的 `allow file* subpath userHome` 目前都是整个 home 可写），而 B 档排在 skills 冻结之后。缓解：①审计记录所有 `bash` 写命令；②提示词明令禁止改动 `inbox`；③回收站可兜底恢复 |
| 注册命令白名单接线后，正常命令被误拒率上升 | 用户任务卡住、体感变差 | §10.4.1 只把**新登记的命令**纳入白名单，其余仍走原有 `ask`/只读放行；上线前用 8 个 skill 的回归清单逐条实测；策略文件非法时 fail-closed 到 `ask` 而非直接拒绝 |
| 软删除把文件 `rename` 进 `.trash` 后占用并未立即释放 | 用户以为"删了但空间没变"，磁盘仍紧张 | 页面文案统一为"移入回收站（7 天后自动释放）"；用量条分开展示"工作区总量"与"回收站占用"；每日清理任务写审计 |
| 硬删除残留（`kind:'workspace'` / `kind:'archive'`） | 删整个工作区/归档仍不可恢复 | §15.2 已列为第二批；在此之前前端不暴露这两个入口 |

---

## 17. 评审决策记录

### 2026-11-09

| 编号 | 决策 | 影响范围 |
|---|---|---|
| D-P1 | **配额只告警，永不阻断**。超限不影响任何写入，Agent 任务照常继续 | 第 8 节全部、"拒绝写入值"字段、`quota_exceeded` 错误码、§12 |
| D-P2 | **回收站保留 7 天**；覆盖快照同为 7 天 | §§6.2、6.3 |
| D-P3 | **管理员必须能看到各用户个人目录占用**（排序、占比、合计） | §9.2.1（后端链路已有，本轮补管理视图） |
| D-P4 | **第一批前端只做"最小可见版"**：能力卡片 + 两条用量条 + 树 + 预览；上传/删除/新建/恢复**一律不显示** | §5.3.1 |
| D-P5 | **第一批不含任何 `skills/**` 改动**，沙箱收窄与可见性白名单延后到 skills 冻结之后 | §§15.2、15.3、18 |

### 2026-11-10

| 编号 | 决策 | 影响范围 |
|---|---|---|
| D-P6 | **网络出口采用 B 方案**：Linux 上 office 类技能归 `open`、`data-analysis` 归 `none`；macOS 上 office 类走 `allowlist 10.31.112.13:19400` | §10.5.3 |
| D-P7 | **必须补启动网络自检**：`none` 档下 4 条探针任一可达即拒绝启动（fail-closed） | §§10.5.4、10.5.5、14（24–27） |
| D-P8 | **明确不做** UDS 转接口 / netns / 渲染链路网关化，全部进 §13 | §§10.5.3、13 |
| D-P9 | macOS 的 `network` 配置目前**完全不生效**，属既有缺陷，必须与断网一起修 | §§10.5.1、16 |

### 2026-11-11

| 编号 | 决策 | 影响范围 |
|---|---|---|
| D-P10 | **删除继续走软删除**（`rename` 进 `.trash`，7 天自动清），**不做硬删除**；但删除按钮**提前到第一批** | §§5.3、5.3.1、6.3、14（4）、15.1（A1/A2）、15.2 |
| D-P11 | **`inbox` 体积单列**：工作区页加第三条用量条；管理员总览加"其中 inbox"列 | §§5.3.1、9.2.1、15.1（A2/A3） |
| D-P12 | **接线 `src/security/policy` 的注册命令白名单**（只接线，不做全量类型化），`data-analysis.run` 为第一条登记命令 | §10.4.1、15.1（B0）、§13 |
| D-P13 | `inbox` 只读在 bash 层**尚未成立**，作为已知残留风险入表，不在第一批修 | §16 |
| D-P14 | 第一批改为**两条轨道 + 三个门**（P0 审计+路径三条 → 门 0 → A 轨居中/ B 轨并行） | §15.1、15.2、15.4、15.6 |
| D-P15 | 取消原第 3 步「统一路径校验 `validatePathInProject`」：本仓库无此函数，且 `assertPathInUserHome` 已覆盖 | §15.1 尾注 |

---

## 18. 与 skills 优化的并行边界

两条线同时进行时，按**文件**划界，不按"模块"划界。

| 线路 | 正在改动的路径 |
|---|---|
| skills 优化（`docs/skills-optimization-plan.zh.md`） | `skills/**`、`skills/_shared/**`、`tests/skills/**`、`tests/skill-e2e/**`、`scripts/check-skill-tokens.mjs`、`docs/design-theme-tokens.zh.md`、`docs/skills-optimization-plan.zh.md` |
| 权限架构（本文） | `src/workspace/**`（新增）、`src/audit/**`（新增）、`src/tool/builtin/filesystem/**`、`src/security/policy/**`、`ui/server/**`、`ui/src/components/main-content-v2/**`、`ui/src/components/settings/**` |

**仅有的三处交集**及处理方式：

| 交集 | 为什么冲突 | 处理 |
|---|---|---|
| `src/tool/builtin/bash/sandbox/**`（可写范围收窄） | 直接决定 skill 脚本能否写 `TMPDIR` / `XDG_CACHE_HOME` | 排最后，等 skills T5 回归完成 |
| 可见性白名单（§7，会过滤 `skills/` 的展示） | skills 正在新增 `_shared/`、`assets/`、`references/` | 等目录结构冻结 |
| 产物落位（§4.1） | skill CLI 默认输出到 cwd | 只做推荐与提示，不强制 |

网络出口策略（§10.5）**不在交集内**：只改 `src/tool/builtin/bash/sandbox/**` 的网络分支与
配置解析，不碰 `skills/**`，可与 skills 线并行推进。

**提交前自检**（有输出说明混进了 skills 文件）：

```bash
git status --porcelain | grep -E '^(..) (skills/|tests/skills/|tests/skill-e2e/|scripts/check-skill-tokens|docs/design-theme-tokens|docs/skills-optimization-plan)'
```

建议：两条线共用一个工作区，但**分开提交**；不要为权限线另开 worktree——未提交的 skills 改动不会被带过去，反而更难对齐。
