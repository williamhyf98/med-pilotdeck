# 权限架构 v2 设计书（个人工作区）

> 状态：**第一批范围已评审通过（2026-11-09）**；按 §15.1 的 9 天计划执行，决策见 §17
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
| 中间产物（抽帧、分页、转码） | `scratch/work/<turnId>/` | 可被配额清理 |
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
| 删除 | 第二批 | 进 `.trash`，7 天内可恢复 |
| 就地编辑文件内容 | 否 | 避免与 Agent 抢写 |
| 新建目录 | 第二批 | 任意层级，限 `root` 内 |
| 操作自建目录中的文件 | 是 | 与 `exports` 同等对待 |

### 5.3.1 第一批交付：最小可见版（2026-11-09 确认）

**第一批只交付"看得见"，不交付任何会改文件系统的前端动作。**

纳入范围：

| 元素 | 要求 |
|---|---|
| 面板标题 | 「项目文件」→「工作区」 |
| 能力卡片 | 三行：可读＝整个工作区；可写＝除 `inbox` 与系统保留项；技能文档只读、实现代码不可见 |
| 工作区总量条 | 数值 / 提示阈值；超阈值变黄。**纯提示** |
| `scratch` 条 | 数值 / 提示阈值；超阈值变黄。**纯提示** |
| 目录树 | 层级树 + 懒加载，显示名称、大小、修改时间 |
| 预览 | pdf / docx / xlsx / 图片 / 文本 |

**明确不做**（第一批不出现，且**不置灰、不显示**，避免"点了没反应"）：

上传、下载以外的写操作、删除、新建目录、回收站恢复、就地编辑。

理由：写操作是唯一能造成数据损失的入口，必须等软删除（§6）落地并被验证一段时间后再开放；
而"看得见"本身已经能解决三条原始诉求里的第 1 条（用户看得见自己的东西）。

> 说明：仓库里已存在 `StorageV2.tsx`（`activeTab === 'storage'`），
> 它能列出工作区/归档分组、预览、并**直接调用 `/api/storage/delete` 做硬删除**。
> 第一批**不改造它、也不在它上面加东西**；硬删除属于 §5.1.1 要改造的对象，
> 在软删除落地前不要给用户新的删除入口。

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

所有接口用 `workspaceId` + 相对路径，**不返回绝对路径**（复用现有 `pathSanitization`）。

### 5.5 验收标准

1. 新建会话 → 页面能看到三个默认目录与能力卡片
2. Agent 生成 PDF 到 `exports` → 页面可见且可预览
3. 删除文件（第二批）→ 进回收站，7 天内可恢复
4. 页面任何位置都看不到服务器绝对路径
5. 只读用户能看不能改（按钮禁用 + 后端 403）

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
| `scratch` TTL 兜底 | **30 天未访问即清**（每周一次） | 自动清理 |
| 保护窗 | **最近 10 分钟**内被读写的不动 | — |

> **关键约束**：自动清理只作用于 `scratch/`。
> `exports/` 与用户自建目录**永远不会被自动删除** —— 否则用户的文件夹会"自己消失"，
> 这是比磁盘满更难解释的事故。它们超限时**只告警**，既不删也不拦。
>
> 补充：`scratch` 的自动清理**不在第一批交付**。第一批只做"看得见"（用量展示 + 告警），
> 清理能力上线前，UI 不得出现"会自动清理"这类文案。

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
  dir: string;        // scratch/work/<turnId>/ 或 scratch/preview/<turnId>/
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
| 管理动作 | `[立即清理]` 只清 scratch；`[清空回收站]` 需二次确认；可按大小排序看 Top 5 |

实现要点：

- 数值来自 `WorkspaceService` 的增量记账 + 6 小时全量校准，页面**不实时 walk 目录**
- 文件增删后只失效对应目录的缓存项
- 90% 以上时提示"建议把大文件移出或删除"
- 清理完成后轻提示："已清理 12 个文件，释放 320 MB"
- **告警文案不得出现"无法继续""请先清理"这类阻断性措辞**，只说"占用偏高，可考虑清理"

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
| scratch TTL | 数字（天） | 30 | 1–365 |
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
| 阈值着色 | 超过 `单用户总量告警值` 的行标黄；**只着色，不提供"停用账号"之类的快捷操作** |
| 刷新 | 沿用 60s 缓存；提供手动刷新按钮，点击时调用 `invalidateStorageCache()` 后重取 |
| 归档用户 | 已归档（archived）用户的目录同样计入合计，但单独标灰，避免"总和对不上" |
| 越权 | 普通用户访问 `/api/admin/users` 必须 403（已有 `requireAdminChain`，加测试锁定） |

验收：

1. 管理员打开设置 →「用户」，能看到每个用户的目录占用、排序、占比、合计。
2. 某用户写入 1 GB 文件后，60 秒内该行数字更新。
3. 普通用户请求 `/api/admin/users` 返回 403。

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
    scratchTtlDays: 30
    protectRecentMinutes: 10
    snapshotRetentionDays: 7
    overrides:
      imaging: { scratchMaxBytes: 2147483648 }
```

YAML 覆盖 `DEFAULT_RESOURCE_LIMITS`；代码默认值保持可运行（无配置也能启动）。

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
| `docx` / `pptx` / `spreadsheets` | `open`（过渡） | `allowlist 10.31.112.13:19400` |
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
| 类型化工具替代 bash（A+） | 3–4 周，破坏 skill 接口 | 观察指标达标（见 10.4） |
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
| 4 | 用户要求删除 3 个文件（第二批） | 进 `.trash`，无弹窗，可一键恢复 |
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
| 18 | 该面板顶部 | 同时显示工作区总量条与 `scratch` 条，数值与记账一致 |
| 19 | 目录行 | 显示聚合大小；新增文件后 60 秒内更新 |
| 20 | 点击"立即清理" | 只清 `scratch`，用户目录与 `exports` 不变 |
| 21 | 管理员打开设置 →「用户」 | 看到每个用户目录占用、可按大小排序、显示占比与全用户合计 |
| 22 | 普通用户请求 `/api/admin/users` | 403 |
| 23 | 任意一次超阈值写入 | 写入成功，仅页面提示 + 审计留痕（**不得出现拒绝**） |
| 24 | `data-analysis` 脚本里 `socket.connect('127.0.0.1', x)` | 失败（`none` 档） |
| 25 | `data-analysis` 脚本里 `socket.connect('10.31.112.13', 19400)` | 失败（`none` 档） |
| 26 | 文档类 skill 向 `10.31.112.13:19400` 取渲染结果 | 成功（Mac `allowlist`；Linux `open`） |
| 27 | 故意把策略配成 `none` 但沙箱未断网 | **Gateway 拒绝启动**并给出明确原因 |

---

## 15. 工期

### 15.1 第一批：9 个工作日（2026-11-09 确认，可立即开工）

**范围：只做与 skills 优化零交集的部分。**

| # | 步骤 | 工期 | 依赖 / 为什么排这里 |
|---|---|---|---|
| 1 | 审计骨架（第 11 节，先只接 `file.*` 事件） | 1d | 零依赖；后面的每一步都能立刻留痕，越早接越好 |
| 2 | 路径校验三条（4.2 的 4/5/6：reserved / inbox 只读 / 覆盖确认） | 1d | 纯增量；`tests/tool/path-safety-*.spec.ts` 已有两个回归基线 |
| 3 | 统一路径校验：`validatePathInProject` 改为调用 `pathSafety` | 0.5d | **必须排在软删除之前**——现实现只做字符串前缀判断，软链可绕过 |
| 4 | 软删除：`fs.rm` → `.trash/<相对路径>.<时间戳>` + restore 接口 | 1.5d | 依赖 3；是前端删除入口的前置 |
| 5 | 用量接口（只读）：工作区总量 / 各分组 / `scratch` | 1d | 依赖 2；被 6、7 共同消费 |
| 6 | 管理员配额页 + `gatewayPool.reloadAll()`（9.4 必做） | 2d | 依赖 5；同时补 9.2.1 的用户占用总览 |
| 7 | 前端最小可见版（5.3.1） | 2d | 依赖 5；不含任何写操作入口 |
| | **合计** | **9d** | |

每一步完成即跑：`npm run build` + 相关 `node --test` / `vitest`，并确认提交里不含 `skills/**`。

### 15.2 第二批（第一批验收后再排）

| 项 | 触发条件 |
|---|---|
| `scratch` 自动清理（8.4） | 告警跑满 2 周、拿到真实用量分布 |
| 前端写操作（删除/新建目录/回收站恢复） | 软删除上线并稳定运行 2 周 |
| 配额硬告警升级为「页面常驻提示」 | 出现真实"用户不知道空间去哪了"的反馈 |

### 15.3 依赖 skills 优化完成（不要提前做）

| 项 | 触发条件 |
|---|---|
| 可见性白名单（第 7 节） | `skills/_shared`、`references/themes.md` 等目录结构冻结（skills T1/T2 完成） |
| 沙箱可写范围收窄（10.3 B 档） | skills T5 回归跑完，并重新实测 8 个 skill 的真实写入路径 |
| 产物落位强制（4.1） | 不做强制，只做推荐；skills 的 CLI 默认输出到 cwd 不改 |

### 15.4 全量参考工期

若把二、三批一并做完，总量仍是 **14–18 个工作日**；其中第一批 9 天是"不受 skills 影响、可立刻推进"的部分。

### 15.5 网络出口策略：2 天（2026-11-10 确认，可与第一批并行）

| # | 步骤 | 工期 | 验收 |
|---|---|---|---|
| 1 | Linux 侧按技能分组落策略（`data-analysis` → `none`） | 0.5d | 5 条探针全绿 |
| 2 | macOS 三态 `network` 真正生效 + `allowlist` | 1d | 连 `19400` 通、连 `8.8.8.8` 不通 |
| 3 | 启动自检（4 探针 + fail-closed） | 0.5d | 故意配错时不启动 |
| | **合计** | **2d** | |

原第 4 步「`frontend-slides` 回环兜底」已在 10.5.7 实测中排除，不再需要。

与 skills 优化的交集为零：本项只改 `src/tool/builtin/bash/sandbox/**` 的网络分支与配置解析，
不触碰 `skills/**`。**唯一注意**：Linux 侧把 office 类技能留作 `open`，
因此 `.doc/.xls/.ppt` 转换与视觉验收都不受影响。

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
