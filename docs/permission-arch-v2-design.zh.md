# 权限架构 v2 设计书（个人工作区）

> 状态：设计稿，待评审
> 分支：`feat/permission-arch-v2`
> 适用范围：离线内网（医院服务器）单机部署，多用户登录模式
> 本文只覆盖本轮要做的范围，明确"不做什么"见第 13 节

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
| 存储接口（列表/预览/删除） | 已有，**前端零调用** | `ui/server/routes/storage.js` |
| 命令危险模式拦截 | 已有（curl/wget/pip install/rm -rf / 等） | `src/tool/builtin/bash/permissions.ts` |
| 操作系统级沙箱 | 已有（Linux bwrap / macOS sandbox-exec） | `src/tool/builtin/bash/sandbox/` |
| 沙箱可写范围 | **整个用户目录**，不是会话工作区 | `sandbox/bwrap.ts`、`sandbox/sandboxExec.ts` |
| scratch 配额 | 有定义但**无调用方** | `src/security/policy/resourceLimits.ts`（默认 1 GiB） |
| 用户磁盘用量统计 | 已有（管理员列表用，60s 缓存） | `ui/server/services/storageUsage.js` |
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
│ 工作区 4.2 GB / 10 GB  ████░░░░░░     │
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
| 上传到 `inbox` | 是 | 走现有上传通道 |
| 删除 | 是 | 进 `.trash`，7 天内可恢复 |
| 就地编辑文件内容 | 否 | 避免与 Agent 抢写 |
| 新建目录 | 是 | 任意层级，限 `root` 内 |
| 操作自建目录中的文件 | 是 | 与 `exports` 同等对待 |

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
3. 删除文件 → 进回收站，7 天内可恢复
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
- 保留：7 天（可配）
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

### 8.1 结论先说

**大小决定"要不要删"，时间决定"先删谁"，保护窗决定"谁不能删"。**

- 只用时间（TTL）：一次导入 30 个 DICOM 批次涨到 40 GB，30 天没到期 → 磁盘满、全系统挂。
- 只用大小（LRU）：上午 900 MB 的中间结果被下午 800 MB 的新任务挤掉，用户回头"继续上次分析"就失败。

### 8.2 默认值

| 项目 | 默认值 | 超限行为 |
|---|---|---|
| 单会话 `scratch` 硬上限 | **1 GiB** | **自动清理**（唯一可自动删的目录） |
| `scratch` 软阈值 | **80%**（819 MB） | 后台静默清理 |
| 单会话工作区总量（除 `scratch`） | 5 GiB 告警 / 10 GiB 拒绝写入 | **只告警/拒绝，绝不自动删** |
| 单用户全部工作区总量 | **20 GiB** | 只告警/拒绝，绝不自动删 |
| `exports`、用户自建目录 | 不单独设限、永不自动清理 | — |
| `scratch` TTL 兜底 | **30 天未访问即清**（每周一次） | 自动清理 |
| 保护窗 | **最近 10 分钟**内被读写的不动 | — |

> **关键约束**：自动清理只作用于 `scratch/`。
> `exports/` 与用户自建目录**永远不会被自动删除** —— 否则用户的文件夹会"自己消失"，
> 这是比磁盘满更难解释的事故。它们超限时只能告警或拒绝写入。

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
5. 删后仍 > hardLimit → 拒绝本次写入（quota_exceeded）
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
| 单文件即超上限 | 写入前拒绝，不"先写后删" |
| 正在被当前回合读取 | 跳过，不清理 |
| 两个回合并发写 | 每工作区一把文件锁，串行化清理 |
| 清理时文件已消失 | 忽略 `ENOENT`，继续 |
| 符号链接 | 不跟随、不计入（`lstatSync`） |
| `exports` 占满磁盘 | 不自动清理，告警 + 提示用户手动处理 |

### 8.7 用户可见

工作区页面需要**两条**进度条，因为两者语义不同：
工作区总量只告警、`scratch` 会自动清理。

```
工作区  4.2 GB / 10 GB    ████░░░░░░   （5 GB 起黄色告警）
├─ exports        3.1 GB    不自动清理
├─ scratch        820 MB / 1 GB   ████████░░   [立即清理]   ← 会自动清理
│   ├─ work          640 MB
│   ├─ preview        90 MB
│   └─ tool-results   90 MB
└─ 我的资料         280 MB    不自动清理
回收站  2 项 / 45 MB         [清空]
```

规则：

| 元素 | 行为 |
|---|---|
| 工作区总量条 | 5 GB 黄色告警、10 GB 拒绝写入；**永不自动删** |
| `scratch` 子条 | 80% 后台静默清理，100% 拒绝写入 |
| 每个目录行 | 显示聚合大小（懒加载时异步计算，服务端缓存 60 秒） |
| 悬停提示 | "scratch 会自动清理；其他目录不会" |
| 管理动作 | `[立即清理]` 只清 scratch；`[清空回收站]` 需二次确认；可按大小排序看 Top 5 |

实现要点：

- 数值来自 `WorkspaceService` 的增量记账 + 6 小时全量校准，页面**不实时 walk 目录**
- 文件增删后只失效对应目录的缓存项
- 90% 以上时提示"建议把大文件移出或删除"
- 清理完成后轻提示："已清理 12 个文件，释放 320 MB"

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
| 单会话工作区告警值（除 scratch） | 数字 | 5 GB | >= 1 GB |
| 单会话工作区拒绝写入值 | 数字 | 10 GB | >= 告警值 |
| 单用户总量上限 | 数字 | 20 GB | >= 1 GB，且 >= 单会话上限 |
| scratch TTL | 数字（天） | 30 | 1–365 |
| 保护窗 | 数字（分钟） | 10 | 0–1440 |
| 覆盖快照保留 | 数字（天） | 7 | 1–90 |
| 影像类会话覆盖值 | 数字 | 2 GB | 同单会话上限 |

页面同时展示（只读）：

- 当前全用户实际占用（来自 `storageUsage.js`，60 秒缓存）
- 占用 Top 5 工作区
- 最近 24 小时的清理记录（次数、释放字节）

### 9.3 交互与安全

| 事项 | 处理 |
|---|---|
| 调低配额 | 二次确认，并提示"预计立即清理 X 个会话、约 Y GB" |
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

另外：`selectSandbox()` 的 `network` 默认是 `true`。离线部署建议显式配
`sandbox.network: false`；这不影响远程服务（走 Gateway 进程），只限制 bash 子进程。

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
| `quota_exceeded` | 空间不足 | **不得换方法绕过** | 明确数字 + 可执行建议 |
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

---

## 14. 验收标准（总）

| # | 场景 | 期望 |
|---|---|---|
| 1 | 点项目名旁的文件夹图标 | 右侧滑出原「项目文件」面板，标题为「工作区」，显示三个默认目录 + 能力卡片 |
| 2 | Agent 写 `exports/x.pdf` | 页面可见、可预览、可下载 |
| 3 | Agent 写 `../outside.txt` | `policy_denied`，无文件产生 |
| 4 | 用户要求删除 3 个文件 | 进 `.trash`，无弹窗，可一键恢复 |
| 5 | 覆盖同名文件 | 弹一次汇总确认，旧版本可查 |
| 6 | `scratch` 到 85% | 后台清理，任务不中断 |
| 7 | `scratch` 到 105% | 清最旧非保护单元；仍超则拒绝并给出建议 |
| 8 | 管理员把上限改成 512 MB | 所有在线用户 1 分钟内生效，无需重启 |
| 9 | 管理员把上限调到低于当前用量 | 二次确认 + 显示预计清理量 |
| 10 | 普通用户访问 `/api/config` | 403 |
| 11 | 页面任意位置 | 无绝对路径泄漏 |
| 12 | 审计日志 | 上述操作均有记录，可按日期检索 |
| 13 | 沙箱收窄后跑 8 个 skill | 全部成功（或只用已登记的可写路径） |
| 14 | Agent 在 `root` 下新建 `我的资料/` 并写入 | 成功；前端树出现该目录且可浏览 |
| 15 | Agent 写 `inbox/x.txt` | `policy_denied`（inbox 只读） |
| 16 | Agent 写 `.trash/...` / `.usage.json` | `policy_denied`（系统保留） |
| 17 | `scratch` 跑满触发清理 | 用户自建目录与 `exports` 完好无损 |
| 18 | 该面板顶部 | 同时显示工作区总量条与 `scratch` 条，数值与记账一致 |
| 19 | 目录行 | 显示聚合大小；新增文件后 60 秒内更新 |
| 20 | 点击"立即清理" | 只清 `scratch`，用户目录与 `exports` 不变 |

---

## 15. 工期

| 阶段 | 内容 | 工期 |
|---|---|---|
| P0 | `TaskScope` + `WorkspaceService` + 路径校验（第 4 节） | 3 天 |
| P0 | 配额与清理（第 8 节） | 4 天 |
| P1 | 前端工作区页面（第 5 节） | 3–5 天 |
| P1 | 删除/覆盖确认 + 软删除（第 6 节） | 2–3 天 |
| P1 | 管理员配置页（第 9 节） | 2 天 |
| P2 | 可见性白名单（第 7 节） | 2–3 天 |
| P2 | 沙箱 A/B 档（第 10 节） | 1–2.5 天 |
| P2 | 审计日志（第 11 节） | 1 天 |
| | **合计** | **14–18 个工作日** |

建议顺序：

```
TaskScope / WorkspaceService
  → 路径校验（第 4 节）
  → 审计日志（最早接，后面每个功能都能记）
  → 配额与清理
  → 前端页面
  → 删除 / 软删除
  → 管理员配置页
  → 可见性白名单
  → 沙箱收窄（最后，需要全 skill 实测）
```

---

## 16. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 另一个进行中的 skill 改造（`skills/_shared` 等） | 与沙箱收窄、落位规则冲突 | 沙箱收窄排最后；落位规则先兼容旧写法 |
| 沙箱收窄后某个 skill 写入失败 | 任务失败率上升 | 先跑实测清单，再逐个登记可写路径 |
| 配额清理误删 | 用户丢中间结果 | 只清 `scratch`；保护窗 + pinned + 回收站；全程审计 |
| 多用户 gateway 未重载配额 | 管理员改了但用户看不到 | 9.4 的 `reloadAll()` 为必做项 |
| 记账漂移 | 实际占用与显示不符 | 每 6 小时全量校准 |
