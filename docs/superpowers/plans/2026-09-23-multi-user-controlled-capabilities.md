# 多用户隔离与受控业务能力 Implementation Plan

> **已被替代，不再用于执行。** 请使用 [多用户隔离与医学 Agent 受控执行：功能实现计划](2026-09-23-multi-user-sandbox-implementation.md)。新文档将合并同事分支、禁用自动迁移和临时环境验证列为 Task 1—3，覆盖最新架构与完整实现顺序。以下内容仅保留为历史记录，不与新文档并行执行。

> **For agentic workers:** REQUIRED SUB-SKILL: 使用 `superpowers:executing-plans` 按本文件逐项实施，在当前会话分批执行并保留检查点。未经用户另行授权，不启用子代理、不迁移真实数据、不推送 GitHub、不部署 node12。步骤使用复选框跟踪。

**Goal:** 在保留医学问答、战创伤推演、记忆、附件解析及文档交付能力的前提下，实现用户数据隔离、管理员权限和模型不可绕过的业务工具边界。

**Architecture:** 共享登录/管理服务与模型服务，每个活跃用户独立 Gateway 运行态和数据目录，Gateway 由有上限的运行时池按需启动。统一资源授权与业务能力服务负责访问边界，任务在受限 worker 中执行；Agent 只接触业务参数和资源标识，不接触任意路径、命令或系统凭据。

**Tech Stack:** 现有 Node.js `>=22.13.0 <23`、TypeScript、Express、SQLite、React/Vite、MCP/Python 医学服务；沿用现有文档生成运行时，不以重写脚本为前提。

**Spec:** 本文件第 1—8 节为最终设计规格，第 9—12 节为依赖有序的实施与验收计划。任何改变隔离边界、数据归属或功能覆盖范围的调整，应先更新规格并与用户确认。

**查验基线:** 2026-09-23，本地 `feat/multi-user` 工作代码 HEAD `56185c2`。编写时工作区无业务代码修改。此前讨论中的 `feat/trauma` 不是当前分支，不自动切换分支。本次为静态代码链路核验，不代表已通过多用户运行或越权测试；下文测试必须在实施时实际执行。

**方案修订 v2:** 已静态检查远程 `origin/feat/capability-layer@6b70c51`（含 `cacc5a7`、`040bf3d`、`6b70c51` 三个新提交），采用其中每用户 Gateway、请求作用域和账号管理的基础思路。远程分支尚未合并；本文修改不授权执行合并。原文共享 Gateway 的目标架构被本版替换，资源授权与受控业务能力要求不变。

## Global Constraints

- 本次不是通用编程 Agent 产品：医学会话中不提供任意 Shell、源码探索、任意路径读写或任意网络请求。
- 角色权限与模型能力分离：管理员聊天也使用受控能力集；系统管理操作走管理接口。
- `userId` 来自已验证身份，不来自用户文本、模型参数、目录猜测或前端提交的角色。
- 身份缺失时拒绝，不回退到第一个用户、admin、公共记忆或全局工作区。
- 每个用户 Gateway 启动时绑定唯一 ownerUserId；进程、连接及其服务令牌不能切换到另一用户。独立进程不等于文件系统沙箱。
- 用户数据、缓存、锁、任务、消息广播均有用户作用域；管理员默认不浏览其他人的病例正文。
- 使用不可变用户 ID；目录由配置根目录推导，不写死 Mac/node12 路径，不逐请求修改 `process.env`。
- 保留医学类型 `general_med`、`trauma_med`，保留现有 transcript/case 两套 session slug 算法。
- 内置技能只读；个人技能、项目技能不能扩大后端权限；插件和可执行扩展只由管理员安装。
- 保留纯判读 G9/DeepChest 报告直接展示与持久化，复合任务使用 material；不强制二次概括。
- 维护策略由管理员统一控制，默认立即执行；新用户默认暖诊、中文、最近活动排序。
- 所有旧功能的替代工具通过回归前，不在正常使用环境删除旧工具；所有隔离检查通过前，不开放多人访问。
- 本文不授权迁移现有数据、修改部署配置、重启远程服务或提交/推送代码。

## 1. 核验结论及修正

方案可行，但不能仅增加登录、用户目录和工具黑名单。必须同时处理以下已核实的入口：

| 当前代码 | 查验结果 | 最终处理 |
|---|---|---|
| `ui/server/constants/config.js`、`routes/auth.js`、`middleware/auth.js` | 默认免登录；单用户注册限制；免登录使用第一个用户 | 多用户模式强制认证，禁止相关绕过配置；独立的一次性初始化 |
| `ui/server/database/db.js`、`init.sql` | 已有账号/API key 用户维度，但 session_names 无用户维度；数据库默认在源码目录 | 迁移角色、令牌版本、归属表和标题约束；数据库移至 system |
| `src/pilot/paths.ts`、`ui/server/utils/pilotPaths.js` | 两套路径算法，均缺少完整用户维度 | 同步显式 UserScope；建立跨实现一致性测试，不能只改一侧 |
| `src/gateway/protocol/types.ts` | submitTurn 接收路径、workspaceCwd、mode 等；没有完整可信用户上下文 | 外部输入 DTO 与内部授权调用分开；用户不得选服务器 cwd/profile 以扩大权限 |
| `GatewayServer.ts`、`GatewayWsConnection.ts` | 服务令牌认证；`/auth/local-token` 返回服务令牌；Gateway 有独立 web API | 多用户模式关闭令牌分发及直接浏览器入口；逐 RPC 校验可信身份和归属 |
| `ui/server/pilotdeck-bridge.js` | 当前本地共享 Gateway 连接，部分运行态按 sessionKey 缓存 | 改为按用户选择 Gateway；共享 UI 层缓存仍使用 owner/project/session 作用域 |
| `ui/server/index.js` | watch-session 注册及部分后台消息路径需要补归属 | 订阅、恢复、停止、交互确认、后台广播全链路验证 |
| `src/cli/createLocalGateway.ts` | 创建通用工具；战创伤通过直接 `tool.execute()` 调用，部分上下文 bypassPermissions | 双入口共用业务服务；不可只在 ToolRuntime 修权限 |
| `createBuiltinRegistry.ts`、`ToolRuntime.ts`、`AgentLoop.ts` | 存在完整通用工具及策略过滤，可复用但非产品硬边界 | 新建受控能力注册表，模型可见过滤与执行侧拒绝双保险 |
| `filesystem/pathSafety.ts`、`bash/commandRunner.ts` | bypass 放宽文件检查；Shell 使用 `shell:true`；cwd 不是隔离机制 | 医学 Agent 禁用通用入口；后端固定程序执行、最小权限、任务隔离 |
| `PluginToToolBridge.ts`、`plugins/med-tools/server/app.py` | 医学工具仍接受路径；路径规范化不是用户授权；绝对路径有直接透传分支 | 模型使用资源 ID，业务服务授权后才构造内部调用 |
| `skills/{docx,pdf,pptx,spreadsheets,diagram-maker}` | 依赖 write_file、bash 和固定入口脚本 | 先包装结构化业务工具，再去掉模型侧 Shell |
| `readSkill.ts`、`systemPromptCopy.ts` | 返回技能实际路径；提示词指导查阅源码 | 只返回业务说明和声明式 schema；移除执行环境操作指令 |
| `med-deepchest-3dmedagent/SKILL.md` | 生产调用和实验脚本说明混在一起 | 生产技能只描述服务能力，实验命令移入运维文档 |
| `memoryService.js`、`createEdgeClawMemoryProviderFromConfig.ts` | 全局根、维护 key、缓存、导入导出共用 | 显式用户根，按用户/项目维护与授权 |
| `routes/user.js` | 个人 Git 配置会调用 git --global | 普通用户不提供系统 Git 修改；必要的项目 Git 身份限对应工作区 |
| `services/officePreview.js` | 系统临时目录缓存 | 将含用户内容的缓存和转换临时空间纳入用户/任务归属 |
| `scripts/lib-local-runtime.sh` | 会清理 DATABASE_PATH 等环境变量 | 启动过程按统一路径计算数据库位置；禁止意外切回源码 auth.db |

注意区分两个来源：早先读取的 `Downloads/mailob/PilotDeck` 有技能共享、按用户名判管理员等问题；最新远程 `feat/capability-layer` 已增加 role、个人技能和独立 Gateway，不能沿用对旧目录版本的判断。

### 1.1 最新同事分支的取舍

| 远程实现 | 本版处理 |
|---|---|
| `middleware/userScope.js`、`utils/userScope.js` 的 AsyncLocalStorage | 保留请求上下文机制；多用户模式缺少上下文必须拒绝，不能回退全局 |
| `services/userHomes.js` 独立用户根、共享配置 | 保留目录思路；不把共享插件可写链接暴露到模型工作区 |
| `services/gatewayPool.js` 按用户启动进程 | 保留并强化；启动/等待/运行/回收状态分离，所有操作持有租约 |
| 角色字段、用户管理页面、精简设置 | 复用；补令牌撤销、初始化凭据、完整配置读权限及个人设置 |
| 启动/首个注册自动移动旧数据 | 不启用；改为本文显式、可恢复的迁移流程 |
| admin Header/WS 参数切换数据用户 | 第一版关闭；不隐式获得其他用户病历访问权 |
| 为新账号复制全局个人技能目录 | 不默认复制旧用户私有内容；仅复制明确发布为模板的技能 |
| 按写请求限制管理员权限 | 替换为按能力/路由授权；完整配置 GET 同样仅管理员 |
| 独立进程仍可用 Shell/绝对路径 | 不视为安全隔离完成；继续落实能力层和生产沙箱 |

合并预演的文本冲突为 `config/deploy.env.example`、`ui/server/services/memoryService.js`、`ui/src/components/app-shell/SidebarV2.tsx`。获准合并后，两类服务配置均保留；记忆导入保留 `fsSync` 并采用用户根；侧栏保留工具三入口与新增账号区域，四主题样式不回退。首次启动前禁用自动旧数据迁移。

### 1.2 最终拓扑与取舍

```text
浏览器 A/B
    ↓
共享身份/管理服务（账号库、归属索引、资源票据、运行时池）
    ├─ 用户 A Gateway（只绑定 A，会话及记忆实例独立）
    └─ 用户 B Gateway（只绑定 B，会话及记忆实例独立）
                  ↓
统一授权的业务能力服务与任务队列
                  ↓
受限 worker（本任务输入只读，输出可写，固定程序只读）
                  ↓
对应用户产物 / 共享远端模型服务
```

独立 Gateway 减少当前代码大量运行态缓存全面多租户化的改动，但共享 UI、任务服务和资源接口仍必须逐请求授权。此选择预计增加常驻内存和冷启动成本；上线前实际测量，不承诺未测量的吞吐/用户数量。Gateway 池容量、worker 并发、GPU 并发是三个独立限制，不能混用。

## 2. 明确实施范围

### 2.1 纳入

1. 双角色、账号管理、个人设置与系统设置拆分。
2. 两个医学模块全部项目/会话/文件/记忆/技能/任务隔离。
3. 上传资源与生成产物注册、受控预览和下载。
4. 业务能力服务、医学适配器、文档适配器、后台任务管理。
5. Agent 工具白名单、技能改造、错误收束、子任务权限继承。
6. 历史迁移脚本、备份校验、回滚流程和双用户验收。

### 2.2 第一版不开放

- 公开注册、用户间共享项目、团队角色、SSO。
- 普通用户插件安装、自带可执行技能、服务地址配置、任意 Shell/SQL/Python。
- 自动从其他磁盘目录导入项目；普通用户只能上传资料到受管项目。
- 未完成用户绑定的 IM、外部 API、CLI/TUI、常驻入口：多用户服务模式下默认拒绝，而非回退 admin。外部 API key 如开放必须明确绑定用户、权限和资源。
- 管理员直接浏览所有用户病历的通用入口；账号和存储统计可管理，不默认返回内容。

已有科研/表格功能采用已支持的结构化操作；不承诺提供任意代码执行能力。发现原功能只能通过任意代码完成时，记录具体缺口，新增受控操作或向用户确认范围，不伪称全量保留。

## 3. 身份、资源与内部协议

### 3.1 账号

- 用户表新增 `role: admin|user`、`token_version`、`must_change_password`，沿用停用标识。
- admin 使用一次性初始化密码/令牌，由操作者提供；不内置通用密码、不按用户名推断权限、不在启动时重置。
- 普通账号由管理员创建；不能停用/降级最后一个有效管理员。
- 所有登录会话、API key、WS 关联用户状态和 token_version；密码重置/停用使旧凭据失效。
- 登录限速、错误不区分账号不存在/密码错误；密码哈希不进入响应或审计。
- 第一版沿用现有 JWT 交互；不新增长期 URL bearer。SSE/预览需要鉴权时使用短期、单用途、限定资源的票据；禁止用任意 Referer 推导身份。
- 远程访问需 HTTPS/WSS；跨域按部署来源白名单处理，浏览器 WS 校验 Origin。

### 3.2 持久化元数据

`system/auth.db` 管理 users、登录会话、资源归属及审计索引。业务大文件仍存磁盘。

新增表（所有用户关联使用真实 users 主键类型，边界统一转字符串）：

```sql
-- 实施时纳入有版本、可重复执行的 migration，而非启动时删表重建。
CREATE TABLE owned_projects (
  project_id TEXT PRIMARY KEY, owner_user_id INTEGER NOT NULL REFERENCES users(id),
  project_type TEXT NOT NULL, relative_root TEXT NOT NULL, status TEXT NOT NULL
);
CREATE TABLE owned_sessions (
  session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES owned_projects(project_id),
  owner_user_id INTEGER NOT NULL REFERENCES users(id)
);
CREATE TABLE resources (
  resource_id TEXT PRIMARY KEY, owner_user_id INTEGER NOT NULL REFERENCES users(id),
  project_id TEXT NOT NULL REFERENCES owned_projects(project_id), session_id TEXT,
  kind TEXT NOT NULL, relative_path TEXT NOT NULL, display_name TEXT NOT NULL,
  content_hash TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE capability_jobs (
  job_id TEXT PRIMARY KEY, owner_user_id INTEGER NOT NULL REFERENCES users(id),
  project_id TEXT NOT NULL, session_id TEXT NOT NULL, capability TEXT NOT NULL,
  status TEXT NOT NULL, idempotency_key TEXT NOT NULL, result_resource_id TEXT,
  UNIQUE(owner_user_id, idempotency_key)
);
```

所有关联同时校验 owner 一致；不能只确认 resource 存在。session_names 增加 owner 字段及相应唯一约束。批次/序列/报告也在资源表注册，可用单独关系表表示成员，不使用传目录替代成员校验。

### 3.3 服务身份与用户身份分开

每个用户 Gateway 保持 loopback（采用容器时为受控内部网络），由运行时池传入不可变 ownerUserId、runtimeId 和私有数据根。UI 为对应用户选取连接；每个 RPC 仍带可信声明，防止错误分发或原始参数造成越权，不是在同一 Gateway 内切换用户。

```ts
type UserScope = { userId: string; role: "admin" | "user"; tokenVersion: number };
type CapabilityContext = {
  actor: UserScope;
  projectId: string;
  sessionId: string;
  turnId: string;
  allowedResourceIds: readonly string[];
  signal?: AbortSignal;
};
type InternalCallClaims = {
  userId: string; tokenVersion: number;
  runtimeId: string;
  audience: "pilotdeck-gateway"; method: string;
  paramsDigest: string; nonce: string; expiresAt: number;
};
```

- 控制服务使用签名私钥，Gateway 只获验证公钥，不能自行签发身份。声明绑定 runtimeId、RPC 方法与规范化参数摘要，有效期最多 60 秒，nonce 防重放；不得接受浏览器透传。
- Gateway 验签并验证声明 userId 等于进程 ownerUserId、runtimeId 等于本次进程实例。通过受认证的内部授权接口复核账号状态/版本，不直接打开系统账号数据库，不信任客户端声称的 role。
- 内部授权接口由共享控制服务承载；接口认证绑定调用 Gateway 的固定用户，仅返回该用户所需授权决定，不返回密码哈希、其他用户索引或全局配置。
- 长流请求只在入站验证时间窗口，后续持续监听撤销；重连重新签发，不能复用已消费 nonce。
- 普通 RPC 必须带明确用户；维护任务使用独立系统入口，仍枚举并显式绑定某一用户，禁止模型选择系统身份。
- `workspaceCwd`、权限模式、profile、系统提示词、服务地址由服务端策略确定；用户可选 agent/ask/plan，但不能扩大能力。
- 所有读取、停止、恢复、rewind、删除、技能管理、订阅、permission/elicitation 响应都检查归属。
- `/auth/local-token` 在多用户模式返回 404；Gateway 直接 web API/浏览器客户端入口关闭，防止绕过 UI 授权层。

### 3.4 用户运行时池与进程边界

- `acquireGatewayLease(actor)` 返回 `{gateway, runtimeId, release}`；查历史、技能生成、战创伤确认、配置刷新及聊天都使用租约，不仅聊天计数。
- 池条目状态 `starting|ready|busy|idle|stopping|failed`；等待队列独立存放，不计作已启动条目，不参与 LRU。
- 容量预留和建条目原子化；starting/有租约条目不能淘汰。只淘汰无任务/维护租约的 idle 条目，等待进程退出后才复用容量。
- 创建失败、连接失败、重置、关停均关闭连接并终止对应进程树；无法确认退出时不释放其物理容量，也不启动替代进程造成失控增长。
- 每个用户同时最多一个 Gateway 实例；重复请求复用启动 promise；排队取消/超时不遗留进程。
- 退出登录关闭该登录会话连接；账号停用/密码重置撤销关联身份并中断相关运行时访问，任务按明确取消/保留规则处理。
- 全局配置变更通过版本广播刷新全部活跃 Gateway，新启动实例取得最新版本；忙碌实例在安全边界应用，不任意重启中断任务。
- 不给 Gateway 整份含共享密钥的 pilotdeck.yaml。控制服务输出按需脱敏配置，模型调用凭据由受控服务/代理持有；兼容期的共享配置路径仅是迁移步骤，不是最终生产隔离。
- 网关进程同样限制可见目录：本用户数据和固定只读代码；无其他用户根、系统数据库及可写共享插件挂载。后台 worker 进一步缩小到本任务范围。
- 远端模型权重仍由共享模型服务加载；不是每个 Gateway 加载一套 GPU 模型。

## 4. 存储与访问范围

```text
<PILOT_HOME>/
  pilotdeck.yaml
  system/
    auth.db
    secrets/
    audit/
    migrations/
  shared/skills/
  users/<userId>/
    preferences.json
    projects/<general_med|trauma_med>/<projectId>/chats/
    workspaces/<general_med|trauma_med>/<projectId>/
      inbox/
      exports/
      scratch/<jobId>/
    memory/
      global/
      general_med/<projectId>/
      trauma_med/<projectId>/cases/<caseSlug>/
    skills/
    always-on/
    archives/
```

- 代码内置技能继续在发行包中只读加载；公共发布技能在 shared，个人在 users，项目技能在对应受管工作区 `.pilotdeck/skills`。
- 路径层区分 `systemHome` 与 `userHome`；不得把 userHome 冒充 systemHome 导致配置/凭据跟随用户变化。
- 若管理员配置自定义 memory 根，也必须追加用户分区，不能直接把配置值作为所有用户记忆根。
- 默认模型上下文给本轮附件清单；历史会话/项目资料通过授权列表/搜索工具获取，不把全部项目资料自动注入每轮。
- 用户可以使用同项目历史资料；跨项目不自动开放。同名附件需要 ID 选择，不按 basename 猜测。
- 实际读取检查真实路径/符号链接；新文件写入检查父目录真实路径。上传压缩包阻止路径穿越、符号链接逃逸及解压炸弹。
- 管理员与普通用户均不得将上传内容写入源码、系统配置、公共技能或运行时目录。
- 文档中的资源引用、图片、模板同样使用 ID；拒绝 file://、远程 URL、任意 path 和动态模板执行。
- 所有产物按授权资源 ID 提供预览/下载；前端显示中文文件名，不显示服务器路径。

## 5. 受控业务能力

### 5.1 统一接口

新建 `src/capability/`，不将通用 ToolRuntime 继续扩展为巨型业务模块：

```ts
type CapabilityName =
  | "project_files_list" | "document_read" | "document_search"
  | "document_create" | "document_update" | "document_export"
  | "medical_parse" | "dicom_route" | "radar_analyze" | "deepchest_analyze"
  | "trauma_rag_query" | "trauma_stage_plan"
  | "job_status" | "job_cancel" | "result_read";
type CapabilityResult = {
  status: "succeeded" | "queued" | "running" | "failed" | "needs_input";
  jobId?: string;
  reportId?: string;
  artifactIds?: string[];
  data?: unknown;
  error?: { code: string; message: string; retryable: boolean };
};
interface CapabilityService {
  execute(name: CapabilityName, input: unknown, context: CapabilityContext): Promise<CapabilityResult>;
}
```

每个能力有独立 JSON schema，`additionalProperties:false`。输入不含用户身份、路径、URL、命令、环境变量。资源解析结果只存在后端适配器中。

身份、授权和 schema 校验失败抛出带稳定 `code` 的 `CapabilityAccessError`，供 HTTP/工具边界转换为安全错误；例如跨用户资源使用 `RESOURCE_NOT_FOUND`，适配器调用次数必须为零。已授权业务执行中的格式不支持、服务故障等返回 `CapabilityResult.status="failed"`；不可混淆这两种失败语义。

`data` 的结构按能力限定；不能把原始 MCP payload 不加筛选地返给模型。保留医学原文和证据，去除凭据、内部路径、堆栈和部署诊断。长结果用 `result_read(reportId, section/cursor)`，不能截断后指示模型 read_file。

### 5.2 文档操作范围

- `document_read`: resourceId、pageRange/section/sheet、cursor；返回正文/表格/受控图像。
- `document_search`: resourceIds、query、cursor；仅授权集合内检索。
- `document_create`: format、title、声明式 sections/slides/workbook、imageResourceIds。
- `document_export`: reportId 或 resourceId、format、displayName。
- `document_update`: resourceId、expectedVersion、有限操作枚举；默认新版本，不覆盖输入。
- 支持现有脚本已实现的章节/幻灯片文本、表格、图片、主题等操作；合并/拆分/旋转 PDF 以类型化操作提供。
- schema 不接受可执行模板、JS/Python、原始 CLI flags；Excel 公式仅允许现有审计确认的安全范围，拒绝外部工作簿/DDE 等外部引用。
- 后端以固定脚本绝对路径和 argv 调用，`shell:false`；命令、输出路径由适配器构造。不可仅按文件名匹配“可信脚本”。
- 将正文落盘、生成、审计、注册产物收束为一次业务调用；原有脚本 JSON 错误转换为稳定业务码。
- 将脚本当前支持的全部面向用户操作登记到覆盖表；无法安全包装的功能不得悄然删除，发布前确认差异。

### 5.3 医学与任务

- 复用现有解析器、模型提示词和远程客户端；不为本改造更改 G9 判读提示词。
- DICOM 识别可由后端先执行，返回适用能力与缺失信息；Agent 仍可选择业务步骤，但不能跳过输入兼容性硬校验。
- RADAR/DeepChest 输入、部位、序列完整性规则保留；不把兜底模型结果伪称专用模型结果。
- DeepChest 的 submit/poll 内部化，前端接收阶段事件；重复提交按幂等键复用同一任务。
- 数据库持久化 owner/project/session、远端 jobId 映射、阶段和结果；服务重启可恢复查询，不重复推理。
- 第一版远程 GPU 任务全局并发 1、每用户运行任务 1，其他排队；按用户轮转取队列，管理员可调整上限。
- 网络超时/暂不可用最多自动重试 2 次；不盲目重试无幂等保障的提交。无权限、格式错误、不支持不自动重试。
- 取消先标记请求并传给支持取消的后端；后端不支持取消时诚实显示“停止等待，服务任务可能仍运行”。
- 纯判读 terminal 与复合 material 由业务编排明确传递；完成答案和转录落盘保持一致。

### 5.4 能力硬边界

- 医学模型注册表不含 bash/read_file/glob/grep/write_file/edit_file、通用 MCP 代理、任意资源 URI 读取及未审计插件工具。
- 时间、受控 read_skill、澄清问题、待办、显式计划模式可保留；plan 内容通过结构化宿主状态保存，不依赖模型写本地计划文件。
- 能力集合为系统策略、账号授权、项目范围、任务范围的交集；子代理只能取父权限子集。
- 老工具别名修复、nested executeTool、profile、bypassPermissions 不得扩大交集。
- 后端执行器使用最小环境变量、限时、任务独立目录、固定可执行入口；运维凭据不传给文档处理器。
- 生产 node12 将文件转换/解析放入受限 worker：只挂载本任务输入（只读）、输出（可写）和固定运行时（只读），默认禁网；模型服务由受控代理访问。
- 本地 Mac 开发可运行固定适配器验证功能，但不能宣称该模式具备操作系统级沙箱。多人生产发布必须验证受限 worker，部署能力不足则阻止发布并报告。

## 6. 记忆、技能与设置

### 6.1 记忆

两种医学保留现有领域规则，用户是外层边界：

- 全局画像/Feedback 只属于一名用户；不在本次改造改变现有 Feedback 的模块适用规则。
- project 记忆保持科研、教学、文献、患者事实等现有提取语义，不新增单患者限制。
- 战创伤保留当前状态和逐轮快照，不新引入其未使用的项目记忆页面。
- Index/Dream 分用户运行；全局归并 key 至少包含 userId；项目任务包含 userId/projectId。
- 维护配置为系统策略，数据为用户私有。共享控制服务中设置唯一维护协调器，枚举到期用户并排队获取其 Gateway 租约，再调用用户私有记忆实例；禁止 UI 定时器和 Gateway 各自重复扫描。
- 协调器维护持久的用户/项目到期状态，不能依赖用户登录或 Gateway 常驻。Gateway 被回收后仍会在到期时按池限额唤起；即时维护与定时维护走相同去重队列。繁忙时可排队，界面显示实际状态，不保证零延迟。
- 用户可暂停本人记忆 capture；已排队 capture 应取消或重新检查用户开关。暂停不自动删除已有记忆。
- 删除记忆/项目与正在运行的维护操作通过同一作用域锁串行化，防止后台任务复活已删除内容。

### 6.2 技能

`read_skill` 返回名称、业务规则、允许操作的 schema/例子，不返回真实路径。静态资源由资源注册表引用。

个人技能为声明式内容；导入包中的 hook、脚本、插件配置、符号链接不得自动启用。新增可执行能力需要管理员在后端发布，不由用户 skill.md 授权。

### 6.3 权限矩阵

| 设置 | user | admin |
|---|---|---|
| 密码、退出、本人主题/中文/排序/编辑器/交互 | 本人 | 本人 |
| 本人记忆开关、查看、删除、导入导出 | 本人范围 | 本人范围 |
| 系统记忆模型、维护模式/时间、总开关 | 不返回配置 | 管理 |
| 模型池、路由、RAG、MCP、RADAR/DeepChest 配置 | 仅能力可用状态 | 管理，凭据掩码/更新不回显 |
| 插件安装、执行策略、服务/环境变量/更新 | 禁止 | 管理 |
| 用户管理、默认偏好、配额 | 禁止 | 管理 |
| 版本/帮助 | 只读 | 只读及更新管理 |
| 其他用户病历/聊天全文 | 禁止 | 第一版同样无通用浏览入口 |

UI 分为个人设置 API 和管理 API。现有 usePilotDeckConfig 不在普通用户设置挂载；普通用户不能通过 raw YAML 或其他 gateway/plugin 接口读取系统配置。显示隐藏与服务端鉴权同时实施。

账号切换关闭旧 WS、终止旧请求、清理查询和预览缓存；浏览器本地设置使用 userId 命名空间，服务端个人设置为持久源。

## 7. 迁移与回滚

1. 实施先用测试目录生成用户与旧格式样本，不移动真实数据。
2. 迁移工具 `scripts/migrate-user-storage.mjs` 提供 `--dry-run`、`--owner-user-id`、`--apply`、`--rollback`；真实执行必须单独确认目标用户和目录。
3. 进入维护模式，停止写入与 Index/Dream/远端新任务提交；SQLite 采用一致性备份，不在活动写入期间简单复制主文件。
4. 清单覆盖 chats、workspaces、memory、skills、archives、always-on、标题、任务和所有附件引用；区分安装内置技能与用户自建技能。
5. 保留 projectId/sessionId；全局冲突必须报告，不能静默改名。两个 session slug 算法分别保留。
6. 复制到新根，校验数量/哈希/SQLite 完整性；建立 owner 元数据及旧路径到资源 ID 的私有映射。
7. `.cwd`、memory pipeline_state、转录中的旧附件引用通过结构化迁移处理，禁止全局文本替换污染病例正文。
8. 切换配置与版本标记后原数据保留只读；多用户服务只读新根。旧链接必须经所属用户映射解析，禁止旧全局目录作为 fallback。
9. 试运行未产生新数据前可按清单回滚；已经产生新数据时须先导出增量，不能直接切回旧系统造成丢失或重新暴露共享数据。
10. Mac 与 node12 分别迁移各自数据；Git 同步只同步代码，不同步账号库、病历、凭据或真实数据清单。

## 8. 代码模块划分

新增目录按责任拆分，以下是计划路径（并非已存在实现）：

| 模块 | 文件 | 职责 |
|---|---|---|
| 身份与策略 | `src/security/types.ts`, `identity.ts`, `internalClaims.ts`, `authorization.ts` | 可信身份、RPC 声明、归属检查 |
| 用户运行时池 | `ui/server/services/gatewayPool.js`, `userHomes.js`、`ui/server/utils/userScope.js` | 复用远程基础并修正租约/排队/生命周期；禁止无身份回退 |
| 维护协调器 | `ui/server/services/userMaintenanceCoordinator.js` | 持久到期调度，按用户租约执行，不依赖 Gateway 常驻 |
| 元数据 | `src/storage/OwnershipStore.ts`, `ResourceStore.ts`, `userPaths.ts` | 系统数据库读取/写入、资源索引、用户路径 |
| 能力核心 | `src/capability/types.ts`, `registry.ts`, `CapabilityService.ts`, `errors.ts` | schema、授权、调度、稳定错误 |
| 文件能力 | `src/capability/files/ResourceResolver.ts`, `documentTools.ts` | ID 解析、分页、搜索 |
| 适配器 | `src/capability/adapters/document.ts`, `medical.ts`, `worker.ts` | 固定脚本、MCP/医学服务、受限进程 |
| 任务 | `src/capability/jobs/JobStore.ts`, `JobRunner.ts` | 幂等、队列、轮询、恢复、取消 |
| 模型接口 | `src/capability/modelTools.ts`, `policy.ts` | 能力白名单及工具定义 |
| UI 后端 | `ui/server/middleware/authorization.js`, `routes/adminUsers.js`, `routes/preferences.js`, `routes/resources.js` | HTTP 角色授权和业务接口 |
| 迁移 | `scripts/migrate-user-storage.mjs` | dry-run、迁移、验证、回滚 |

SQLite 核心共享层使用项目已采用的 `node:sqlite`；现有 UI better-sqlite3 账号层可暂保留，共用同一数据库文件和 migration 版本，均只在可信控制服务中使用。Gateway 通过授权接口访问归属服务，不直接挂载系统数据库。设置 WAL/busy_timeout；不跨异步 bcrypt 等操作持有 SQLite 写事务；账号查询/归属更新使用短事务。禁止每个 Gateway 复制一份用户库。

## 9. 执行约定与测试命令

每个 Task 依次执行“写失败测试 → 确认失败 → 最小实现 → 运行测试 → 记录检查点”。新测试用隔离临时 PILOT_HOME，不能使用真实病例目录。

根项目 TS 测试：

```bash
npm run build
node --test --test-force-exit --test-timeout 60000 dist/tests/security/*.spec.js
node --test --test-force-exit --test-timeout 60000 dist/tests/capability/*.spec.js
```

UI 测试/构建：

```bash
npm --prefix ui test -- server/routes/auth.multitenant.spec.js
npm --prefix ui run typecheck
npm --prefix ui run build
```

新增测试目录/文件按各 Task 创建；运行目标不存在属于计划未完成，不可视为通过。编译前测试失败应确认与当前缺失功能相关，而非依赖或环境损坏。最终运行 `npm test`、`npm --prefix ui test`，分别记录既有失败和新增失败。

医学插件：

```bash
cd plugins/med-tools
.venv/bin/python -m unittest discover -s tests
```

测试用结构（作为各 Task 的实现契约，实际 import 指向上述新增模块）：

```ts
import assert from "node:assert/strict";
import test from "node:test";
// 每个 fixture 显式创建 actorA、actorB 及各自 project/session/resource。
test("资源存在但不属于调用者时拒绝", async () => {
  const f = await makeSecurityFixture();
  try {
    await assert.rejects(
      f.service.execute("document_read", { resourceId: f.fileB }, f.contextA),
      { code: "RESOURCE_NOT_FOUND" },
    );
    assert.equal(f.adapterCalls.length, 0);
  } finally { await f.dispose(); }
});
```

Task 1 创建 `makeSecurityFixture`，接口固定为 `contextA/contextB/fileA/fileB/service/adapterCalls/dispose`；后续增加测试所需字段时同时更新 fixture 类型，不在不同任务中重建不兼容的 mock。

## 10. 分批任务

### 批次 A：账号、归属与协议基础

**前置检查（不计为已获合并授权）:** 实施前确认是否已批准合入 `origin/feat/capability-layer`。若批准，以新基线合并并修正三处文本冲突；启动前关闭自动迁移，新增能力先在临时 PILOT_HOME 验证。若尚未批准，暂停涉及该分支复用的实施并确认，不自行 cherry-pick。下列 Task 对远程已存在的模块进行加固，而非重复建立另一套账号/运行时池。

#### Task 1：可验证的范围清单与隔离测试基础

**文件:** 新增 `tests/security/fixtures.ts`、`tests/security/scope.spec.ts`、`docs/superpowers/plans/2026-09-23-capability-coverage.md`；读取当前技能与已有回归测试。

**产物:** `makeSecurityFixture()`；业务功能→旧入口→新能力→测试→差异的覆盖表。

- [ ] 创建两用户、两类型项目、重复文件名、两种 session slug、共享技能及私有技能的临时样本；dispose 仅删除本测试创建的临时目录。
- [ ] 为缺少身份、外用户资源、相同 ID 尝试写入添加失败测试。
- [ ] 创建最小身份类型和测试存储适配器，使隔离契约测试通过；不将 mock 当成正式权限实现。
- [ ] 枚举五类文档技能及 frontend-slides 当前操作，记录安全包装目标；禁用某项旧操作需在覆盖表明确说明。
- [ ] 运行 `npm run build` 后执行 `dist/tests/security/scope.spec.js`；记录现有全套测试基线。

#### Task 2：角色、账号初始化、登录撤销

**修改:** `ui/server/database/{db.js,init.sql}`、`middleware/auth.js`、`routes/auth.js`、`constants/config.js`、`src/storage/OwnershipStore.ts`。
**新增:** `routes/adminUsers.js`、`middleware/authorization.js`、`ui/server/routes/auth.multitenant.spec.js`。

**接口:** `resolveActiveActor(userId, tokenVersion): UserScope`；`requireAdmin`；初始化只允许无管理员且持有一次性初始化凭据的请求。

- [ ] 测试普通用户创建账号返回 403、重置密码使旧 JWT/WS 失效、最后管理员不能删除、启动不重置密码。
- [ ] 实现数据库版本迁移；密码哈希在事务外计算，账号创建/唯一性检查在短事务中完成。
- [ ] 多用户模式拒绝 DISABLE_LOCAL_AUTH/IS_PLATFORM 绕过；迁移未完成时返回维护状态，不映射 first user。
- [ ] 账号响应只含公开字段；限速、Origin/CORS、资源票据与审计不记录密码/令牌。
- [ ] 运行 auth.multitenant.spec.js，确认管理接口和失效连接测试通过。

#### Task 3：用户路径及持久资源归属

**修改:** `src/pilot/paths.ts`、`ui/server/utils/pilotPaths.js`、`ui/server/projects.js`。
**新增:** `src/storage/{userPaths.ts,ResourceStore.ts}`、`tests/security/user-paths.spec.ts`。

**接口:** `resolveUserHome(systemHome, userId)`；`ResourceStore.getOwned(actor, resourceId)`；归属不存在对用户统一返回 RESOURCE_NOT_FOUND。

- [ ] 断言 A/B 同类型项目根不同；JS/TS 对同样输入输出一致；拒绝 `..`、斜杠 ID、符号链接逃逸。
- [ ] 构建 owned_projects/owned_sessions/resources schema；创建项目和目录采用可恢复状态记录，失败不留下可见半成品项目。
- [ ] 改造项目、标题、历史搜索、删除和归档入口；明确 systemHome/userHome，不更改配置定位。
- [ ] 真实路径校验覆盖读和新建父目录；保留 transcript/case slug。
- [ ] 执行 user-paths.spec.ts 和现有 workspace/typed-project/delete-project 测试。

#### Task 4：用户 Gateway 池、可信上下文与实时消息归属

**修改:** `src/gateway/{protocol/types.ts,protocol/frames.ts,protocol/version.ts,client/RemoteGateway.ts,client/GatewayWsClient.ts,server/GatewayServer.ts,server/GatewayWsConnection.ts,Gateway.ts,SessionRouter.ts}`、`ui/server/{index.js,pilotdeck-bridge.js}`。
**复用并修改:** `ui/server/services/{gatewayPool.js,userHomes.js}`、`ui/server/{middleware/userScope.js,utils/userScope.js}`。
**新增:** `src/security/internalClaims.ts`、`tests/security/gateway-scope.spec.ts`、`ui/server/services/gatewayPool.spec.js`。

**接口:** `acquireGatewayLease(actor)` 及第 3.3 节声明；Gateway 固定 ownerUserId/runtimeId，不能切换用户。

- [ ] 测试共享 UI 中交错 A/B 请求各进自己的 Gateway；A 的声明发到 B 进程被拒绝；覆盖过期/重放、错误 runtimeId/paramsDigest、跨用户停止/订阅/批准交互。
- [ ] 测试启动占位、容量峰值、重复 acquire、队列公平、取消等待、boot 失败、连接失败、LRU 回收和进程退出确认；每次操作都持租约。
- [ ] 为 RPC 方法建立显式权限映射，未知方法拒绝；关闭多用户模式的 local-token 和直接 web API。
- [ ] Bridge 丢弃前端 actor/cwd/提升权限参数，由服务端构造声明；同步升级内部协议版本。
- [ ] 缓存 key 和事件携带 owner/project/session；后台通知不允许 undefined 用户过滤。
- [ ] 更新外部 API/IM/CLI：无已验证用户绑定时拒绝；WebSocket 断开只处理该连接所属任务。
- [ ] 删除多用户模式下 globalGateway fallback，禁止 admin 隐式切换用户；账号状态通过内部授权接口复核。
- [ ] 系统配置版本通知所有活动实例，新实例读取最新版本；密钥不通过客户端/Gateway 可见文件暴露。
- [ ] 运行 gateway-scope 测试，并模拟重连、撤销、并发多会话。

**检查点 A:** 可在隔离测试环境运行双用户；尚不对外开放多用户，不迁移真实数据。

### 批次 B：资源与业务执行

#### Task 5：上传、预览、下载、结果统一资源化

**修改:** `ui/server/index.js` 上传/文件相关处理、`routes/storage.js`、`services/officePreview.js`、`src/context/attachments/AttachmentResolver.ts`。
**新增:** `routes/resources.js`、`src/capability/files/ResourceResolver.ts`、`tests/security/resources.spec.ts`。

**接口:** `ResourceResolver.resolveOwned(context, id, purpose)` 返回仅后端可见的已授权句柄；resource API 不返回绝对路径。

- [ ] 测试跨用户文件/预览/Range/DICOM 帧/office 回调、重复文件名、压缩路径穿越、恶意符号链接、超大解压输入。
- [ ] 上传成功注册 ID/批次成员；失败上传不产生可访问资源；HTTP 大小、解压条数与展开字节数设硬限制并返回 413。
- [ ] 改造聊天附件和历史回放，ID 为主键；旧引用只有 owner 私有映射能解析。
- [ ] 预览、转换缓存和长结果落盘进入用户 scratch；资源下载/回调同样校验。
- [ ] 跑 resources.spec.ts 及现有重复附件、DICOM、XML、Office 预览测试。

#### Task 6：业务能力服务和固定执行器

**新增:** `src/capability/{types.ts,registry.ts,CapabilityService.ts,errors.ts,adapters/worker.ts}`、`tests/capability/service.spec.ts`。

**接口:** 第 5.1 节 CapabilityService；registry 中每能力声明 schema、资源字段、操作影响、可用性及受信任适配器。

- [ ] 在 `errors.ts` 定义 `CapabilityAccessError extends Error`，包含只读 `code`；授权与 schema 错误抛出该类型，业务错误使用 CapabilityResult。
- [ ] 用第 9 节用例确认未授权请求不会触达适配器；测试任意 path/url/command 字段、伪造 actor 被 schema 拒绝。
- [ ] 在服务入口依次执行身份、项目/会话关系、能力白名单、schema、资源范围校验，再调适配器。
- [ ] 固定可执行文件+argv，禁 shell 拼接；输入 manifest 仅含已授权资源；限制任务输出大小、超时和环境。
- [ ] 返回稳定业务错误与审计 ID；管理员日志和模型结果分开。
- [ ] 模拟 worker 越权读取、输出符号链接和未知产物，确认不注册/不返回。

#### Task 7：文档能力替代

**新增:** `src/capability/files/documentTools.ts`、`adapters/document.ts`、`tests/capability/documents.spec.ts`。
**修改:** `skills/{docx,pdf,pptx,spreadsheets,diagram-maker,frontend-slides}/SKILL.md`（有不支持的操作必须在覆盖表登记）。

**接口:** 第 5.2 节六类文档操作；script 内部输入路径不泄漏为模型 API。

- [ ] 测试中文长报告、表格、图片、PPT 指定页修改、PDF 合并/拆分以及旧产物版本不被覆盖。
- [ ] 为现有脚本建立固定命令映射和参数 schema；声明式输入由后端落盘。
- [ ] reportId 导出读取原报告，不经主模型摘要；结果注册 artifactId 和版本。
- [ ] 搜索/分页读取支持 result_read，不用 read_file 处理截断。
- [ ] 对照覆盖表逐项回归；依赖不具备时明确 unavailable，不诱导模型安装软件。

#### Task 8：医学能力与战创伤适配

**新增:** `src/capability/adapters/medical.ts`、`tests/capability/medical.spec.ts`。
**修改:** `src/mcp/runtime/PluginToToolBridge.ts`、`plugins/med-tools/server/app.py`、`src/cli/createLocalGateway.ts`、`src/trauma/attachments/parseClient.ts`、`src/trauma/rag/client.ts`。

**接口:** medical_parse/dicom_route/radar_analyze/deepchest_analyze/trauma_rag_query/trauma_stage_plan。

- [ ] 测试有效与不完整 CT、非 CT、未知部位、多附件、terminal/material、同项目历史附件。
- [ ] 模型工具只接收资源 ID；后端医学调用允许私有路径但必须来自 ResourceResolver，插件服务不得作为公开无鉴权文件代理。
- [ ] 将 Runner 和知识问答直接 tool.execute 路径改为 CapabilityService，不改变工位推演逻辑。
- [ ] 过滤诊断字段同时保留完整医学证据/报告；前端流式和刷新转录输出一致。
- [ ] 执行 medical.spec.ts、trauma 现有回归和 Python unittest；无远端服务用假服务验证协议，不声称真实推理通过。

#### Task 9：持久任务、配额与受限 worker

**新增:** `src/capability/jobs/{JobStore.ts,JobRunner.ts}`、`tests/capability/jobs.spec.ts`、`scripts/capability-worker/` 下生产受限 worker 配置与启动入口。
**修改:** DeepChest/RADAR 适配器及进度事件。

**接口:** job_status/job_cancel；内部远端 ID 不能直接作为用户任务 ID。

- [ ] 测试重复提交、断线重连、服务重启恢复、同用户排队、A/B 公平排队、取消和远端不可取消。
- [ ] 持久化幂等 key、任务状态、结果引用；不将一次网络超时当成远端任务失败并重复提交。
- [ ] 落实并发与重试规则，后台执行不占模型循环；设置超时后保留可查询 jobId。
- [ ] Linux worker 限制挂载、网络、进程权限、资源；Mac 标记开发执行模式，不混淆安全保证。
- [ ] Gateway 自身也采用第 3.4 节用户边界；测试 A Gateway 进程不能读取 B 文件/系统账号库。worker 只获本任务输入，不能因为属于 A 就看到 A 的全部项目。
- [ ] 分别测量 Gateway 冷启动、空闲内存、并发峰值和回收，worker 队列、GPU 队列单独计量；按实测设置池容量，不能把默认 8 当成性能结论。
- [ ] 以临时“其他用户文件”验证生产 worker 无法读取；受限环境未通过则禁止多用户发布。

**检查点 B:** 上传—分析—报告—文档—预览链路可运行；业务能力已替代原命令入口，功能覆盖差异明确。

### 批次 C：模型能力、记忆、界面

#### Task 10：受控模型工具集和技能

**新增:** `src/capability/{modelTools.ts,policy.ts}`、`tests/capability/model-boundary.spec.ts`。
**修改:** `createBuiltinRegistry.ts`、`ToolRuntime.ts`、`AgentLoop.ts`、`createLocalGateway.ts`、`readSkill.ts`、`systemPromptCopy.ts`、相关 skills。

**接口:** 系统能力白名单与会话/子代理能力集合交集；用户/模型不能修改系统白名单。

- [ ] 检查模型请求实际 schema 不含通用文件/Shell/MCP 代理；直接伪造这些调用也被拒绝。
- [ ] 测试别名修复、nested executeTool、bypassPermissions、profile 和子代理均不能提权。
- [ ] read_skill 返回业务说明；移除源码路径、实验命令、自动探索运行时和本地环境上下文。
- [ ] 保留澄清、待办、用户主动计划模式；计划保存交给宿主，不依赖模型路径读写。
- [ ] 新会话启用严格工具集；旧会话恢复也重新构造，不继承历史允许列表扩大权限。

#### Task 11：记忆全链路与后台身份

**修改:** `src/context/memory/createEdgeClawMemoryProviderFromConfig.ts`、`ui/server/services/memoryService.js`、`routes/memory.js`、`src/trauma/{store.ts,memory/}`、`src/cli/createLocalGateway.ts`。
**新增:** `ui/server/services/userMaintenanceCoordinator.js`、`tests/security/memory-isolation.spec.ts`。

**接口:** 私有记忆实例归属于固定用户 Gateway；共享维护协调器按用户+领域+项目去重并获取 Gateway 租约，UI 手动请求也进入同一队列。

- [ ] A/B 写相反反馈，验证各自模型上下文只收到本人内容；自定义 memory 根也不串库。
- [ ] 覆盖提取、Index、Dream、导入导出、删除和病例快照；验证 war_trauma 专属规则继续生效。
- [ ] 停用用户/暂停 capture/删除项目时检查待执行任务；锁覆盖删除与维护，防止复活。
- [ ] UI 定时维护停止重复执行；管理员更改策略影响已有/新项目，当前用户数据仍独立。
- [ ] 用户退出且 Gateway 已回收时，验证定时维护仍会唤起对应运行时；所有槽位繁忙时排队，不回退共享 Gateway、不静默漏掉用户。
- [ ] 运行 memory-isolation 和现有记忆领域/快照测试。

#### Task 12：技能存储与角色化设置、切号状态

**修改:** `ui/server/routes/{skills.js,settings.js,config.js,plugins.js,gateway.js,user.js,update.js}`、`src/extension/skills/SkillManager.ts`、`ui/src/components/settings/`、`ui/src/components/auth/`、`ui/src/contexts/`。
**新增:** `routes/preferences.js`、`ui/server/routes/settings.authorization.spec.js`、`ui/src/components/settings/role-navigation.spec.tsx`。

**接口:** `/api/preferences` 仅个人字段；管理配置强制 admin；个人/项目技能按 owner 解析。

- [ ] 普通用户直接请求管理配置/更新/插件安装返回 403；个人设置可保存，系统配置不进入其浏览器响应。
- [ ] admin 账户管理 UI 与个人设置分区；凭据字段不回显，默认设置保持暖诊/中文/最近活动。
- [ ] 技能导入拒绝可执行扩展自动激活；项目技能只在对应项目可见。
- [ ] 移除用户 git --global，清理隐藏管理入口和原始工具参数展示。
- [ ] A 退出后 B 登录，验证 session/sidebar/preview/WS/localStorage 无 A 数据闪现。

**检查点 C:** 测试环境功能与隔离回归通过；可以准备真实迁移，但尚未授权迁移或部署。

### 批次 D：迁移、整体验收与交付

#### Task 13：迁移工具与启动一致性

**新增:** `scripts/migrate-user-storage.mjs`、`tests/security/migration.spec.ts`。
**修改:** `scripts/lib-local-runtime.sh`、启动/配置引导的数据库路径处理。

**接口:** 第 7 节 CLI；状态清单版本、源目标哈希、数据库备份、切换标记。

- [ ] 测试 dry-run 不写业务数据、重复 apply 幂等、中途失败可续跑、冲突停止、rollback 保留原内容。
- [ ] 分别迁移一般/战创伤会话、两个 slug、旧绝对附件、项目技能、记忆 DB 路径及归档。
- [ ] 所有归属使用明确 owner；不能以登录的第一个账号抢占旧数据。
- [ ] 启动校验 layoutVersion、多用户开关和数据库路径；半迁移返回维护状态而非静默创建新空库。
- [ ] 输出脱敏迁移报告，执行真实迁移前向用户说明目标账号、备份位置和影响。

#### Task 14：端到端验收与部署清单

**新增:** `tests/security/multi-user-e2e.spec.ts`、`docs/deployment/multi-user-controlled-capabilities.md`。

- [ ] 两账号分别完成普通医学问答、附件分析、RADAR/DeepChest（有服务时）、战创伤推演、历史快照、报告导出和文件预览。
- [ ] 验证所有入口：HTTP、WS、Gateway、任务恢复、资源票据、MCP 私有入口、插件/skill 导入、旧 URL、导入导出。
- [ ] 上传带“读取配置/访问他人文件”指令的文档，验证模型即便提出越权工具请求也无法执行。
- [ ] 真实推理需有明确服务响应和当前输入对应证据；缺依赖/服务的用例标记未通过验收，不用 mock 代替。
- [ ] 跑根测试、UI 测试、类型检查、双端构建、Python 测试；记录提交基线、命令、失败及修复结果。
- [ ] 经用户确认后才备份/迁移真实数据及同步 node12；测试实际静态页面端口和开发端口行为一致。
- [ ] 验证生产 worker 安全限制、HTTPS/WSS、服务令牌不暴露、无未归属数据可访问；全部通过后开放多人使用。

## 11. 完成判据

- [ ] 每个资源及任务有可校验 owner，跨用户请求在触达业务适配器之前失败。
- [ ] 用户 Gateway 身份不可切换；池容量/租约/回收测试通过；无作用域时不回退公共数据。
- [ ] 普通用户只能看到个人设置，直接调用管理 API 同样被拒绝。
- [ ] 医学模型请求和嵌套调用均无法运行任意 Shell/源码/路径操作。
- [ ] 文档和医学原功能覆盖清单全部通过，或差异已明确获用户接受。
- [ ] 全局记忆、Feedback、Index/Dream、病例快照、归档和搜索不跨用户混合。
- [ ] 生成中状态、刷新结果、历史文件、账号切换正确；G9 报告未被二次稀释。
- [ ] 真实数据迁移可审计可恢复；凭据/病例不进入 Git。
- [ ] 生产受限执行与真实端到端测试通过，未把单机开发模式当安全多人部署。

## 12. 检查点记录模板

每批结束在本文下追加：

```text
批次 / Task：
完成日期与代码版本：
修改文件：
执行的测试命令及结果：
功能覆盖差异：
未通过项与原因：
数据/部署操作：无，或列出另行获得的授权
下一任务：
```

实施起点为 Task 1。先在本地测试环境完成批次 A；文档编写完成不等于任何 Task 已实施。
