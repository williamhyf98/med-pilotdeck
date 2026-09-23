# 多用户隔离与医学 Agent 受控执行：功能实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: 使用 `superpowers:executing-plans` 在当前会话按批次执行。每项使用复选框记录实际结果，不派遣子代理。当前请求仅授权编写文档；用户随后明确要求开始实施时，从 Task 1 开始，不跳过合并、安全处理和临时环境验证。

**Goal:** 复用同事多用户初版，在保留医学功能的前提下实现账号权限、用户内容隔离、独立 Agent 运行态、受控业务工具和生产执行沙箱。

**Architecture:** 共享登录/管理服务；每个活跃用户独立 Gateway，由运行时池按需启动和回收；统一资源授权与业务能力服务；独立任务沙箱执行固定程序。模型只能选择业务能力并分析结果，不能任意访问本地目录、源码、命令和凭据。

**Tech Stack:** Node.js `>=22.13.0 <23`、TypeScript、Express、SQLite、React/Vite、现有 MCP/Python 医学服务与文档脚本。优先复用现有代码，不整体重写医学 Runner 或文档生成器。

**Spec:** 本文第 1—5 节是设计与约束，第 6 节是顺序执行任务，第 7—8 节是总验收与交接。本文为唯一有效执行计划，完整取代 `2026-09-23-multi-user-controlled-capabilities.md`；旧文档仅用于历史追溯。

**基线（2026-09-23）:** 本地 `feat/multi-user@56185c2`；已抓取的远程 `origin/feat/capability-layer@6b70c51`。同事新增提交为 `cacc5a7`、`040bf3d`、`6b70c51`。分支尚未合并；静态查验不等于运行验收。

## Global Constraints

- 第一批正式工作就是合并同事代码、关闭自动旧数据迁移、基础检查及临时环境验证，不再把合并留作模糊前置条件。
- 开始实施的授权包含本地代码合并与修复；真实数据迁移、远程重启/部署、GitHub push、合入 develop 均需单独授权。
- 合并前保护用户工作区和本计划；不使用 reset --hard、强制 checkout、自动 stash 或清理用户文件。
- 未通过最终隔离验收前，不开放多人生产使用；不得以登录成功或目录不同代表安全完成。
- 管理员角色不扩大聊天 Agent 能力；普通用户无权读取完整系统配置。
- 身份缺失拒绝，不回退 first user、admin、公共 Gateway 或共享记忆。
- 用户身份来自后端认证，资源 ID 每次验证归属；不可让模型传 userId、任意路径或服务地址决定权限。
- Gateway 固定绑定一名用户。独立进程不是文件系统沙箱，仍须限制文件和网络访问。
- 保留通用医学/战创伤、四主题、侧栏布局、中文技能名称、附件预览和历史对话行为。
- 保留 G9/DeepChest 纯判读原始报告直接展示及转录；复合任务用 material，不新增强制二次总结。
- 维护模式默认立即执行，个人默认暖诊、中文、最近活动；既有用户显式偏好不被启动覆盖。
- 不逐请求修改进程环境变量；部署路径从配置根解析，不写死 Mac/node12。
- 每批先写失败测试、验证失败原因、实现、再验证；编译失败/依赖缺失不能伪装成功能测试失败。
- 不为方便测试关闭真实系统认证、修改真实数据库或启动可能自动迁移真实数据的服务。

## 1. 最终需求与架构

### 1.1 用户能做什么

普通用户登录后可使用两个医学模块、管理本人项目/会话/文件/记忆、自建声明式技能、调整个人界面和交互偏好。无法访问其他用户内容、安装执行插件、读取系统密钥、配置模型服务或通过 Agent 操作服务器。

管理员除本人业务能力外，可管理账号、系统配置、维护策略、公共技能、配额、服务与更新。默认无跨用户病历浏览入口，不沿用同事的 Header/WS 用户代入功能。

首次初始化创建角色为 admin 的账号（默认用户名 admin，可在明确迁移时指定已有账号）；使用操作者提供的一次性凭据，不提供固定通用密码。普通账号由管理员创建，不开放公开注册。

第一版不做团队共享、SSO、公开注册、任意编程 Agent。未绑定账号的 IM/API/CLI/常驻入口在多用户模式下拒绝，不回退系统用户。

### 1.2 运行关系

```text
用户 A / 用户 B
       ↓
共享控制服务：认证、账号管理、资源归属、运行时池、任务协调
       ├─ Gateway A：只处理 A，会话与记忆实例独立
       └─ Gateway B：只处理 B，会话与记忆实例独立
                    ↓
统一业务能力接口：校验身份、资源、操作范围
                    ↓
任务沙箱：固定程序、本任务输入只读、输出可写
                    ↓
用户私有产物 / 共享模型服务
```

Gateway 是组织智能体运行的后台进程，不是 GPU 模型。独立 Gateway 不要求每用户复制模型权重。Gateway 池容量、任务 worker 并发、GPU 并发分别限制。

### 1.3 同事代码取舍

| 同事实现 | 处理决定 |
|---|---|
| role、用户管理 UI、普通用户精简设置 | 保留，补初始化保护、撤销及服务端读权限 |
| AsyncLocalStorage 用户作用域 | 保留；多用户模式缺失作用域直接拒绝 |
| users/<id>、每用户 Gateway | 保留，补租约、任务队列、可靠回收与生产隔离 |
| 共享配置路径 | 作为兼容阶段；最终通过控制服务提供脱敏配置及模型代理 |
| 自动迁移到首个管理员 | 合并后、任何启动前关闭；换成显式迁移命令 |
| 无上下文时回退 global Gateway | 多用户模式删除此回退 |
| 新账号复制旧全局技能 | 禁止默认复制；只允许明确发布的公共模板 |
| admin 切换其他用户数据 scope | 第一版禁用 |
| 仅管理写请求，配置 GET 开放 | 改为按路由和能力授权 |
| 原通用文件/Shell/MCP 工具 | 在替代业务工具验收后从医学模型能力集移除 |

## 2. 存储、身份和资源契约

### 2.1 目标目录

```text
<PILOT_HOME>/
  pilotdeck.yaml                    # 仅控制服务访问含密钥的版本
  system/
    auth.db                        # 身份、归属、任务索引
    secrets/
    audit/
    migrations/
  shared/skills/                   # 管理员发布，只读
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

内置技能保留在发行包中只读加载；项目技能位于受管项目 `.pilotdeck/skills`。保留原 transcript 与 case 两套 slug，禁止统一算法导致历史丢失。

systemHome 与 userHome 明确分开；UI 的 JS 路径层与引擎的 TS 路径层必须一致。自定义记忆根仍追加用户分区。旧个人技能、记忆不能作为新账号模板。

### 2.2 数据归属

控制数据库增加/迁移以下信息：

- users：role、is_active、is_system、token_version、must_change_password。
- auth_sessions：loginSessionId、userId、tokenVersion、撤销/过期状态。
- owned_projects：ownerUserId、projectId、projectType、relativeRoot、status。
- owned_sessions：ownerUserId、projectId、sessionId；标题关联同一归属。
- resources：resourceId、ownerUserId、projectId、sessionId、kind、relativePath、displayName、hash、version、status。
- resource_members：批次/序列与成员资源关系，每个成员归属一致。
- capability_jobs：jobId、ownerUserId、projectId、sessionId、capability、状态、幂等键、远端 ID、结果引用。
- maintenance_due：用户/领域/项目的下次维护状态、占用租约、上次结果。

同事版生成 ID 可能在不同用户目录重复，数据库主键/唯一约束以 ownerUserId+业务 ID 组合，不要求改写现有 projectId/sessionId；新资源 ID 使用随机不可预测标识，但标识随机不替代授权。

SQLite schema 由控制服务唯一版本迁移；Gateway 不复制账号库、不直接挂载 system/auth.db。设置 WAL、busy_timeout；写事务不跨异步密码哈希/网络操作。

### 2.3 内部接口

```ts
type Actor = {
  userId: string;
  role: "admin" | "user";
  tokenVersion: number;
  loginSessionId: string;
};
type Scope = { actor: Actor; projectId: string; sessionId: string; turnId: string };
type GatewayLease = {
  gateway: unknown;             // 实施时复用现有 Gateway 接口
  runtimeId: string;
  release(): Promise<void>;
};
type CapabilityResult = {
  status: "succeeded" | "queued" | "running" | "failed" | "needs_input";
  jobId?: string;
  reportId?: string;
  artifactIds?: string[];
  data?: unknown;               // 每种能力另设结果 schema
  error?: { code: string; message: string; retryable: boolean };
};
// 服务端私有接口，不向模型开放 scope 或路径。
interface ResourceService {
  authorize(scope: Scope, resourceId: string, operation: string): Promise<void>;
}
interface CapabilityService {
  execute(name: string, input: unknown, scope: Scope): Promise<CapabilityResult>;
}
```

所有不存在/不属于本人资源，对外统一 RESOURCE_NOT_FOUND；身份、授权和 schema 错误在适配器执行前抛出稳定 code 的错误。合法任务的格式不支持/运行失败返回 failed，不能混淆授权失败与业务失败。

模型参数严格 schema、拒绝附加字段。路径、userId、Shell、URL、环境变量和可执行模板不作为自由参数。

## 3. Gateway、工具与沙箱规则

### 3.1 Gateway 池

- `acquireGatewayLease(actor)` 为所有运行时操作提供租约，不限聊天；同用户复用同一启动 promise。
- 状态为 starting/ready/busy/idle/stopping/failed；等待队列不与活动进程混放。
- 原子容量预留；starting、有租约、尚未确认停止的进程不能淘汰或释放物理容量。
- 只回收无任务、无维护租约的 idle 实例；停止须关闭连接及子进程树，超时升级终止并确认退出。
- 重置连接不能只删除 Map 条目造成孤儿进程；过期旧回调不能删除同用户的新实例。
- RPC 校验进程固定 ownerUserId/runtimeId。内部请求由控制服务签名，绑定方法、参数摘要、60 秒有效期和 nonce；Gateway 只有验证公钥。
- 验证服务令牌之外还验证用户声明；停用/密码重置/退出对应会话后，身份撤销及时通知活动连接。
- `/auth/local-token` 和直接浏览器 Gateway API 在多用户模式关闭；运行时只在 loopback/受控网络监听。
- UI 所有缓存和事件注册仍按用户/项目/会话区分，不能因为 Gateway 独立就省略。

### 3.2 业务能力

固定能力清单：

| 能力 | 模型输入 | 后端负责 |
|---|---|---|
| project_files_list | 类型/关键词/分页 | 当前授权项目资料列表 |
| document_read/search | resourceId、页码/章节/查询 | 正文、表格、受控图像与出处 |
| document_create/update/export | 内容/结构、资源 ID、格式、版本 | 临时文件、固定脚本、校验、产物注册 |
| medical_parse/dicom_route | attachmentId/batchId/seriesId、问题 | 路径解析、格式/部位/完整性检查 |
| radar_analyze/deepchest_analyze | 资源 ID、问题和已知检查信息 | 远程调用、持久任务、结果保存 |
| trauma_rag_query/stage_plan | 查询/结构化病例信息 | 检索和固定医学服务 |
| job_status/cancel | jobId | 本人任务状态及取消 |
| result_read | reportId、章节/游标 | 长结果分页，不要求模型 read_file |

脚本固定路径+argv、shell:false；不能提供 run_script(command) 变相恢复 Shell。文档图片/模板/报告引用也用资源 ID。默认产物新版本，不覆盖原上传文件。

读取用户授权的代码附件与读取服务器源码是两回事；上传文件中写的指令不能扩大权限。

纯判读 terminal 原样展示/落盘；复合 material 后续可导出 reportId，避免主模型复制时压缩报告。

### 3.3 后台任务与运行权限

- 持久任务幂等、防重复提交，重启按远端 ID 恢复；禁止网络超时后盲目重交 GPU 任务。
- 首版远端 GPU 同时运行 1 个任务、每用户最多 1 个运行任务，用户间轮转排队；管理员可调整。
- 暂时网络错误最多重试 2 次；权限/格式/不支持不重试；无提交幂等保证时只查询状态。
- 远端不支持取消时说明“停止等待，服务任务可能仍运行”，不能伪报已终止。
- 医学 Agent 不提供 bash/read_file/glob/grep/write_file/edit_file、原始 MCP 代理或任意 URI 工具。
- 时间、澄清、待办、受控 read_skill、用户主动计划模式保留；计划由宿主结构化保存。
- 子代理、嵌套调用、别名修复、旧会话允许规则、bypassPermissions 不得增加白名单之外的能力。
- Gateway 生产隔离仅访问本人数据和只读代码；任务 worker 进一步仅访问本任务输入/输出。
- 控制服务持有系统凭据，通过模型/医学代理转发；Gateway 不挂载完整系统配置和账号库。
- worker 默认禁网；如需服务调用，经限定端点和方法的代理，禁止通用转发任意 URL。
- Mac 固定适配器可用于开发验证，但不宣称具备 OS 沙箱；node12 生产隔离实测通过前不开放多人。

## 4. 记忆、技能与设置

- 全局画像和 Feedback 的“全局”仅在同一用户内；保留现有两医学模块适用规则。
- project 记忆继续包括病例、科研、教学、文献上下文，不新增单患者限制。
- 战创伤保留病例 current/snapshots，不新增其不使用的项目记忆页面。
- 维护协调器在共享控制服务唯一运行：按用户/项目持久到期状态取得 Gateway 租约执行；用户离线或 Gateway 回收后仍能排队唤起。
- 即时/定时/手动 Index/Dream 使用同一去重队列；删除与维护共用作用域锁，不复活已删除记忆。
- 用户关闭本人记忆时取消/复核待 capture；不自动删除既有数据。
- 私有、项目、公共技能分离；声明式技能不能增加脚本/hook/插件权限。
- read_skill 不返回安装路径，不混入实验复现/部署命令；中文展示名与现有技能知识保留。

| 设置 | 普通用户 | 管理员 |
|---|---|---|
| 账号密码、退出、主题/语言/排序/输入/编辑器 | 本人 | 本人 |
| 本人记忆开关及查看/删除/导入导出 | 本人范围 | 本人范围 |
| 用户创建/停用/角色/重置密码 | 禁止 | 可用，保护最后管理员 |
| 模型池、路由、密钥、MCP、医学服务配置 | 仅简化可用状态 | 管理，密钥掩码不回显 |
| Index/Dream 模型、维护模式/时间/总开关 | 不可修改 | 管理所有已有/新项目策略 |
| 插件、系统权限、环境变量、重启/更新 | 禁止 | 管理 |
| 版本/帮助 | 可看 | 可看及执行更新 |
| 其他用户病历全文 | 禁止 | 第一版无通用浏览入口 |

个人设置不得挂载完整 usePilotDeckConfig。配置 GET、解析失败的 raw YAML、插件接口、Shell WS、目录浏览同样做后端授权；不能只藏菜单。

退出/切号关闭旧连接、撤销对应登录会话、取消旧前端请求并清理缓存；本地偏好按 userId 命名空间，服务端保存个人偏好。常规断网不自动取消已接受的后台分析任务。

## 5. 实施边界、模块及测试方式

### 5.1 顺序总览

| 批次 | Task | 可交付结果 | 是否允许使用真实数据 |
|---|---|---|---|
| A 合并与基础保护 | 1—3 | 同事功能纳入当前分支，禁自动迁移，临时双账号可验证 | 否 |
| B 身份与运行时 | 4—7 | 账号撤销、资源归属、稳定独立 Gateway | 否 |
| C 业务工具替代 | 8—11 | 文档/医学/长任务由受控接口执行 | 否 |
| D 完整隔离 | 12—15 | Agent 边界、记忆、设置、生产沙箱验收 | 否 |
| E 迁移与发布 | 16—17 | 明确授权后迁移和部署 | 单独确认后 |

Task 有依赖：8 依赖 5/6/7；9/10 依赖 8；11 依赖 8/10；12 必须等 9/10/11 覆盖通过；13 依赖 6/11；15 依赖 12—14；真实迁移只能在 15 通过后。

### 5.2 新增模块责任

```text
src/security/
  types.ts, internalClaims.ts, authorization.ts
src/storage/
  OwnershipStore.ts, ResourceStore.ts, userPaths.ts
src/capability/
  types.ts, registry.ts, CapabilityService.ts, errors.ts, modelTools.ts, policy.ts
  files/ResourceResolver.ts, documentTools.ts
  adapters/document.ts, medical.ts, worker.ts
  jobs/JobStore.ts, JobRunner.ts
ui/server/services/
  gatewayPool.js, userHomes.js                 # 同事模块，修正而非重建另一套
  userMaintenanceCoordinator.js
ui/server/routes/
  preferences.js, resources.js, runtimeControl.js
scripts/
  migrate-user-storage.mjs
  capability-worker/                         # 固定 worker 程序及生产隔离配置
```

共享资源/能力服务运行在可信控制层；Gateway 使用经身份绑定的客户端，不直接打开全部用户资源索引。接口暴露不同操作而非通用 SQL/文件读取。适配器不返回内部路径或密钥。

### 5.3 测试与提交规则

新测试通过临时目录和临时账号库执行。服务模块导入可能打开数据库，所以测试进程启动前设置 PILOT_HOME、DATABASE_PATH、PILOTDECK_CONFIG_PATH、token 路径及隔离端口；子进程继承测试根而非操作者环境。

构建前检查 prebuild 配置生成脚本，在临时配置环境中运行。测试不调用生产 start-local，不连接真实模型作为默认单元测试。

测试命令：

```bash
# 仓库根：目标 TS 测试编译到 dist/tests 下
npm run build
node --test --test-force-exit --test-timeout 60000 dist/tests/security/*.spec.js
node --test --test-force-exit --test-timeout 60000 dist/tests/capability/*.spec.js
# UI（各任务使用下文准确的测试路径过滤）
npm --prefix ui test -- server/services/gatewayPool.spec.js
npm --prefix ui run typecheck
npm --prefix ui run build
# 最终完整检查
npm test
npm --prefix ui test
# 医学插件：在 plugins/med-tools 目录执行
.venv/bin/python -m unittest discover -s tests
```

测试 helper 在 Task 3 创建，后续维护相同接口：

```ts
type SecurityFixture = {
  scopeA: Scope; scopeB: Scope;
  resourceA: string; resourceB: string;
  service: CapabilityService;
  adapterCalls: unknown[];
  dispose(): Promise<void>;
};
// makeSecurityFixture() 创建隔离根并返回上述接口；
// 早期 service 使用测试 adapter，Task 8 后连接正式 CapabilityService。
```

每 Task 完成：记录修改文件、测试命令/结果、功能差异、下一步。需要提交时只暂存本任务明确文件，不用 git add .；业务提交/push 不由本次“写文档”请求授权。开始实施后，合并提交与分批本地检查点按用户批准范围保存，不自动 push。

## 6. 按顺序执行的任务

### 批次 A：先合并，不先重写

#### Task 1：保护基线并合并同事分支

**文件:** 当前计划、旧计划停用说明及 Git 合并涉及文件。
**输入:** 当前 feat/multi-user 和同事 feat/capability-layer。
**输出:** 可追溯合并状态，尚不启动应用。

- [ ] 检查 `git status --short`、分支、HEAD；保护未跟踪计划和用户修改。工作区有重叠修改时停止并确认，不自动 stash。
- [ ] 经实施授权保存文档检查点和本地备份引用；记录原 HEAD，备份引用不替代业务数据备份。
- [ ] fetch 同事分支并重新运行 merge-tree；若不再是 6b70c51，先检查新增差异与冲突，不机械采用旧清单。
- [ ] 使用明确版本执行 `git merge --no-ff --no-commit origin/feat/capability-layer`，不启动服务，不立即完成合并提交。
- [ ] 解决 `config/deploy.env.example`：RADAR/DeepChest 与多用户配置都保留；不得从示例覆盖真实配置。
- [ ] 解决 `memoryService.js`：保留 fsSync，采用用户记忆根，移除未使用 os；本步不声称后台调度已隔离完成。
- [ ] 解决 `SidebarV2.tsx`：保留 HardDrive/LogOut，技能/记忆/存储在分隔线上方；用户信息和退出在下方，设置最底；使用四主题语义颜色。
- [ ] 检查自动合并文件的医学引用、文件预览、技能中文名、转录和配置定位；随后立即执行 Task 2。

**检查:** `git diff --check`、`git diff --name-only --diff-filter=U`；后者应为空。若失败只报告冲突，不重置用户改动。

#### Task 2：任何运行之前关闭自动迁移及危险默认值

**修改:** `ui/server/index.js`、`routes/auth.js`、`services/userHomes.js`、`middleware/userScope.js`。
**新增测试:** `ui/server/services/userHomes.safety.spec.js`。
**输出:** 启动/注册不移动数据，旧布局进入明确维护状态。

- [ ] 创建含旧 projects/workspaces/memory 的临时根；测试启动和首次注册不执行 rename/rm、不产生迁移完成标记：

```js
expect(migrateLegacySharedData).not.toHaveBeenCalled();
expect(await fs.readFile(legacyCasePath, "utf8")).toBe(originalContent);
```

- [ ] 移除启动与注册中的自动迁移调用，不以“出错后继续”代替禁止。发现旧数据时给出“需管理员迁移”的状态，不让首个注册者自动取得旧数据。
- [ ] 默认不复制全局私有技能；公共模板必须显式配置。禁 admin scopeUser/Header 代入，收到该参数返回明确拒绝。
- [ ] 初始注册在临时环境使用一次性初始化令牌；没有凭据时不允许任何来访者抢占首个管理员。完整账号流程由 Task 4 补齐。
- [ ] 执行 UI 定向测试与静态检查后完成合并检查点；记录已合入与尚未加固内容。

**停止条件:** 如果无法证明启动不会迁移真实目录，不执行任何集成启动测试。

#### Task 3：临时环境双账号基线验证及覆盖清单

**新增:** `tests/security/fixtures.ts`、`tests/security/merge-baseline.spec.ts`、`docs/superpowers/plans/2026-09-23-capability-coverage.md`。
**输出:** SecurityFixture；现有业务操作覆盖清单；检查点 A。

- [ ] 创建 A/B 测试账号、两类项目、同名附件、历史会话和两种 slug；所有数据在 mkdtemp 根内，dispose 只删除该根。
- [ ] 运行两账号登录/列项目/新会话/退出，确认实例与目录不同；不把正常流程成功当成越权验收。
- [ ] 运行时工厂用假进程先验证可重复启动；记录跨用户请求、配置 GET、Shell、后台维护仍存在的缺口，不跳过失败。
- [ ] 枚举 docx/pdf/pptx/spreadsheets/diagram-maker/frontend-slides 技能每个面向用户操作，记录“旧入口→新能力→测试→支持差异”。
- [ ] 在隔离配置中执行根构建、UI typecheck/build，跑现有医学/预览/侧栏相关测试；区分原有失败与合并新增失败。

**检查点 A:** 仅说明合并与启动保护完成。不迁移真实数据、不部署 node12、不启用多人生产。向用户报告合并结果和下一批内容。

### 批次 B：可靠身份与用户运行态

#### Task 4：完善账号、角色、撤销及后台读权限

**修改:** `ui/server/database/{db.js,init.sql}`、`middleware/auth.js`、`routes/{auth.js,adminUsers.js,config.js,settings.js,plugins.js,gateway.js,update.js}`。
**新增测试:** `ui/server/routes/auth.multitenant.spec.js`。

- [ ] 测试普通用户读完整配置、raw YAML、更新/插件管理返回 403；修改本人偏好可用。
- [ ] 实现 token_version/auth_sessions、首次改密；密码重置/停用撤销现有 JWT、API key 使用和 WS；退出只撤销对应登录会话。
- [ ] 保护最后有效管理员；未知 role 最低权限或拒绝，不默认 admin；写事务在异步哈希后进行。
- [ ] 账号初始化限定一次性令牌，禁止启动时自动提升普通账号/重置密码；登录限速、错误文案不泄露账号存在性。
- [ ] 修改所有管理读写入口，普通用户只拿功能名称/可用性；解析失败也不返回 raw 密钥配置。
- [ ] 执行 `npm --prefix ui test -- server/routes/auth.multitenant.spec.js`。

**断言:** `expect(userConfigResponse.status).toBe(403)`；重置后旧 JWT/WS/API key 不可再发起操作。

#### Task 5：统一归属与路径解析

**新增:** `src/storage/{OwnershipStore.ts,ResourceStore.ts,userPaths.ts}`、`src/security/{types.ts,authorization.ts}`、`tests/security/ownership.spec.ts`。
**修改:** `src/pilot/paths.ts`、`ui/server/utils/pilotPaths.js`、`ui/server/projects.js`、标题/搜索/归档入口。

- [ ] 测试相同 projectId/sessionId 在 A/B 下独立，路径 JS/TS 输出相同：

```ts
assert.notEqual(pathsFor(A).projectRoot, pathsFor(B).projectRoot);
await assert.rejects(store.getOwned(scopeA, resourceB), { code: "RESOURCE_NOT_FOUND" });
```

- [ ] 建立第 2.2 节有版本 schema；账户归属只由后端赋值，项目/会话/资源关系全部检查。
- [ ] 路径拒绝 ..、非法 ID、读/写父目录符号链接逃逸；保留两个 session slug。
- [ ] UI 缓存/标题/会话索引按 owner+project+session；禁止任意磁盘项目导入和普通用户 git --global。
- [ ] 运行 ownership.spec 与现有 workspace/typed-project/delete-project 测试。

#### Task 6：修正 Gateway 池并建立可信调用边界

**修改:** 同事 `services/gatewayPool.js`、`userHomes.js`、用户作用域模块、`ui/server/pilotdeck-bridge.js`、`src/gateway/{protocol,client,server}`、`src/cli/pilotdeck.ts`。
**新增:** `src/security/internalClaims.ts`、`ui/server/services/gatewayPool.spec.js`、`tests/security/gateway-scope.spec.ts`。

- [ ] 对假 runtimeFactory 测试启动中不可淘汰、同用户只启动一次、满载等待、取消等待、旧回调不能删除新实例：

```js
expect(factoryCallsFor(userA)).toBe(1);
expect(peakLiveProcesses).toBeLessThanOrEqual(capacity);
expect(killedRuntimeIds).not.toContain(startingRuntimeId);
```

- [ ] 实现 acquireGatewayLease/release，所有 RPC 操作持有租约，等待队列与进程池分离。
- [ ] 绑定 ownerUserId/runtimeId；验证带 method/paramsDigest/nonce/expiry 的签名声明，拒绝 A 声明进入 B 实例。
- [ ] 多用户模式无上下文直接失败；关闭 local-token/直接浏览器 Gateway API；未绑定 IM/CLI/API 路径拒绝。
- [ ] 连接失败/reset/shutdown 关闭全部关联资源并确认进程树退出，不能仅删除缓存条目。
- [ ] 全部活跃实例接收配置版本更新；新实例使用最新版，忙碌任务安全切换；参数无效/池耗尽返回明确队列状态。
- [ ] 执行 gatewayPool.spec.js 和 gateway-scope.spec.ts。

#### Task 7：文件标识、预览、下载及事件授权

**新增:** `ui/server/routes/resources.js`、`src/capability/files/ResourceResolver.ts`、`tests/security/resources.spec.ts`。
**修改:** 上传入口、`routes/storage.js`、`services/officePreview.js`、`AttachmentResolver.ts`、WS 订阅和交互确认。

- [ ] 测试 B resourceId、旧绝对路径、伪造 watch-session、跨用户 job/permission 请求均拒绝；Range、DICOM 帧、Office 回调也测。
- [ ] 上传注册 attachmentId/batchId/seriesId，先校验再发布；失败文件不进入可访问列表。
- [ ] 归属验证后解析真实路径；压缩包限制大小、数量、展开字节数，拒绝路径穿越/链接；HTML 预览隔离 Origin/CSP，不作为同源活动代码运行。
- [ ] 下载/预览通过资源票据或认证，禁止长期 URL bearer 和 Referer 推断身份；票据限定资源、操作和有效期。
- [ ] 预览缓存、附件合并和历史回放用资源 ID，不因同名混淆；广播只发已授权会话。
- [ ] 执行 resources.spec 和现有 DICOM/XML/Office/重复附件回归。

**检查点 B:** 身份、资源和池生命周期单测通过；仍不宣称 Agent 沙箱已完成。

### 批次 C：先补替代工具，再删除通用工具

#### Task 8：统一业务能力服务

**新增:** `src/capability/{types.ts,registry.ts,CapabilityService.ts,errors.ts}`、`tests/capability/service.spec.ts`。

- [ ] 使用正式 CapabilityService 替换 fixture 测试 adapter 外壳；保留可计数底层 adapter。

```ts
await assert.rejects(
  f.service.execute("document_read", { resourceId: f.resourceB }, f.scopeA),
  { code: "RESOURCE_NOT_FOUND" },
);
assert.equal(f.adapterCalls.length, 0);
```

- [ ] 按身份→作用域→能力→schema→资源→适配器顺序执行，未知能力默认拒绝。
- [ ] 结果按 schema 筛选；原始路径、环境、堆栈进受控日志，不返回模型。医学证据原文不随诊断脱敏被删减。
- [ ] result_read 按章节/游标提供长结果；不返回让模型 read_file 的落盘路径。
- [ ] 业务服务内部接口认证绑定用户进程/任务，不能接收未认证 scope；所有拒绝结果可审计但不写病历全文/令牌。
- [ ] 执行 service.spec.ts，测试任意 path/userId/command/url 附加参数无法触达适配器。

#### Task 9：文档读取与生成业务化

**新增:** `src/capability/files/documentTools.ts`、`adapters/document.ts`、`tests/capability/documents.spec.ts`。
**修改:** 文档脚本入口适配，不先删除旧技能操作。

- [ ] 测试 Word/PDF 中文报告原文导出、图片、表格、PPT 指定页修改、PDF 合并/拆分/旋转及版本保护：

```ts
assert.equal(exportedReportText, storedReportText);
assert.equal(await hash(originalUpload), originalHash);
assert.notEqual(newArtifactId, originalResourceId);
```

- [ ] 将受控参数映射到固定脚本+argv；Markdown/JSON 暂存由后端完成，固定输出目录。
- [ ] reportId/resourceId 传材料，不要求主模型重复抄写完整报告；所有图片和模板引用校验归属。
- [ ] 拒绝可执行模板、原始 flags、任意输出路径、外部 Excel/DDE 引用；未支持操作明确返回 unsupported。
- [ ] 按 Task 3 覆盖表逐项验证现有业务功能；不可安全包装的差异需用户接受后才删除旧入口。
- [ ] 执行 documents.spec.ts 及原有文档生成回归。

#### Task 10：医学工具与战创伤 Runner 统一授权

**新增:** `src/capability/adapters/medical.ts`、`tests/capability/medical.spec.ts`。
**修改:** `PluginToToolBridge.ts`、`plugins/med-tools/server/app.py`、`src/cli/createLocalGateway.ts`、`src/trauma/attachments/parseClient.ts`、`src/trauma/rag/client.ts`。

- [ ] 测试单帧/多帧/完整与混合序列、未知部位、多附件、历史文件及 terminal/material。
- [ ] 模型端只暴露资源 ID；内部 MCP 可使用解析后的私有路径，但接口仅对授权业务服务开放。
- [ ] 将 Runner 直接 tool.execute 改为业务服务；保留固定工位、专属提示词与流程状态，不重写 Runner 成通用 Agent。
- [ ] 维护 G9/DeepChest 原报告展示、流式及转录一致：

```ts
assert.equal(persistedAssistantText, terminalReport);
assert.equal(mainModelRewriteCalls, 0);
```

- [ ] 原模型不可用时报告真实降级，不伪称 RADAR/DeepChest 推理成功；保留限制和来源。
- [ ] 执行 medical.spec、现有 trauma 回归、Python unittest；真实服务不可达的用例标记待实测，不用 mock 结案。

#### Task 11：持久任务与公平排队

**新增:** `src/capability/jobs/{JobStore.ts,JobRunner.ts}`、`tests/capability/jobs.spec.ts`。
**修改:** 医学适配器、任务事件和用户 Gateway 通知。

- [ ] 测试重复提交、网络断开、进程回收、重启恢复、取消、跨用户查询：

```ts
assert.equal(secondSubmit.jobId, firstSubmit.jobId);
assert.equal(remoteSubmitCount, 1);
assert.deepEqual(await resumedJob.result(), completedResult);
```

- [ ] 独立后台执行常规轮询，Gateway 无须为等待远端任务永久持租约；结果持久化后用户重连/新运行时可取回。
- [ ] 恢复对话的回调仅携带不可变 owner/project/session；晚到结果不能写入另一会话或已删除项目。
- [ ] 分别限制用户/全局 GPU 并发、文档 worker 并发；按用户轮转排队，显示排队/执行/完成/失败状态。
- [ ] 实现幂等、重试和取消规则；远端不支持取消时保留真实状态。
- [ ] 执行 jobs.spec，验证正常刷新不会重复推理。

**检查点 C:** 替代工具覆盖通过；纯解析、分析后生成报告、跨轮导出均不依赖模型 Shell。

### 批次 D：能力收紧、记忆与生产沙箱

#### Task 12：移除医学 Agent 的通用执行能力

**新增:** `src/capability/{modelTools.ts,policy.ts}`、`tests/capability/model-boundary.spec.ts`。
**修改:** `ToolRuntime.ts`、`AgentLoop.ts`、工具注册、`readSkill.ts`、`systemPromptCopy.ts`、医学和文档技能。

- [ ] 断言实际模型 schema 没有通用 Shell/目录/文件工具：

```ts
for (const name of ["bash", "read_file", "glob", "grep", "write_file", "edit_file"]) {
  assert.equal(modelToolNames.includes(name), false);
}
```

- [ ] 伪造调用、别名、nested executeTool、子代理、旧会话权限、profile、bypass 均不能越过系统白名单。
- [ ] 技能返回业务知识和受控操作例子，不给安装路径/源码/实验指令；DeepChest 实验内容移至运维文档。
- [ ] 保留时间、澄清、待办和用户主动计划模式；由宿主管理计划状态。
- [ ] 对“功能不支持”返回明确下一步，不引导模型查源码或安装依赖；仍保留工具循环上限作兜底。
- [ ] 执行 model-boundary.spec，覆盖包含恶意指令的上传文档。

#### Task 13：记忆和维护全链路隔离

**新增:** `ui/server/services/userMaintenanceCoordinator.js`、`tests/security/memory-isolation.spec.ts`。
**修改:** `memoryService.js`、`createEdgeClawMemoryProviderFromConfig.ts`、记忆 API、trauma memory/store。

- [ ] A/B 写不同 Feedback，断言各自模型上下文仅含本人内容；自定义 memory 根也分区。
- [ ] 覆盖 capture、Index、Dream、手动维护、导入导出、清空、病例快照；锁 key 包含用户，不清空其他用户缓存。
- [ ] 使用唯一协调器与持久 due 队列；关闭 UI/Gateway 重复调度。Gateway 回收后到期维护仍可唤起并执行。
- [ ] 删除项目与维护串行化，晚到任务不能复活数据；用户暂停记忆后排队 capture 不落盘。
- [ ] 管理员策略应用已有和新项目；保留 war_trauma 规则和立即执行默认值。
- [ ] 执行 memory-isolation 和现有 memory/trauma 快照回归。

#### Task 14：技能、个人设置及切号清理

**新增:** `ui/server/routes/preferences.js`、`ui/server/routes/settings.authorization.spec.js`、`ui/src/components/settings/role-navigation.spec.tsx`。
**修改:** 技能 API/SkillManager、设置/账号/侧栏/预览/WS 前端。

- [ ] 验证个人/项目技能只在本人和对应项目有效；公共/内置技能不可被普通用户覆盖。
- [ ] 上传技能包拒绝可执行 hook/插件激活、符号链接逃逸；普通自定义技能仅声明式内容。
- [ ] 按第 4 节矩阵实现精简设置；管理 API 校验与 UI 同步，不只隐藏菜单。
- [ ] 个人偏好服务端持久化，切号清理旧请求/WS/查询/预览缓存；测试 B 页面不闪现 A 的会话或附件。
- [ ] 保持四主题、侧栏工具入口、中文名称和默认偏好；用户更改不会影响别人。
- [ ] 执行两项新测试及侧栏/记忆页/文件页回归。

#### Task 15：生产沙箱与双用户完整验收

**新增:** `src/capability/adapters/worker.ts`、`ui/server/routes/runtimeControl.js`、`scripts/capability-worker/`、`tests/security/sandbox.spec.ts`、`tests/security/multi-user-e2e.spec.ts`。
**输出:** 发布阻断项清单、实测资源指标。

- [ ] worker 输入只读/输出可写/程序只读，限制进程、CPU/内存/时间/输出字节；网络默认拒绝。
- [ ] Gateway 只挂载本人数据，无 B 文件、system/auth.db 和含密钥 YAML；控制服务提供脱敏配置及限定模型/医学代理。
- [ ] 代理验证实例/用户、限定端点和操作，不能传任意 URL 或取得密钥；审计不记录病历全文。
- [ ] 从 A Gateway 和 A worker 实际尝试打开测试 B 文件/系统秘密文件，均失败；不能只模拟路径检查。
- [ ] 验证实例关停、端口/token 隔离、配置广播、任务恢复；测冷启动、峰值内存、队列与吞吐，据此设置部署容量。
- [ ] 运行双用户问答/影像/文档/战创伤/记忆/预览/切号；越权覆盖 HTTP/WS/Gateway/MCP/票据/旧 URL。
- [ ] 运行完整根/UI/Python 测试和构建。Mac 无 OS 沙箱的测试不能算 node12 生产验收；若无法在获准的隔离测试环境验证生产沙箱，标记发布阻断，不跳过。

**检查点 D:** 业务功能、双用户越权、生产隔离均有实测证据后才允许进入真实迁移。需要远程验证时先单独获得授权，不擅自重启 node12。

### 批次 E：显式迁移和部署，单独授权

#### Task 16：迁移工具及干运行

**新增:** `scripts/migrate-user-storage.mjs`、`tests/security/migration.spec.ts`。
**修改:** `scripts/lib-local-runtime.sh`、配置引导的 DATABASE_PATH/layoutVersion 处理。

- [ ] 提供 `--dry-run`、`--owner-user-id`、`--apply`、`--rollback`；owner 必须明确，不取首个登录用户。
- [ ] 测试 dry-run 不写、重跑幂等、中断可续跑、冲突停止、部分失败不写完成标记：

```ts
assert.equal(await hashTree(sourceRoot), beforeHash);
assert.equal(await exists(completedMarker), false); // 模拟部分迁移失败
```

- [ ] 维护模式停止写入/维护/新任务；SQLite 用一致性备份。源文件复制校验后再切换，保留原数据只读。
- [ ] 覆盖项目、会话、标题、记忆、病例快照、技能、任务、归档及 `.cwd`/pipeline_state/附件引用；不能全局替换病例正文。
- [ ] 建立 owner 私有旧路径→资源 ID 映射，不开放任意旧路径 fallback；目录冲突需报告。
- [ ] 测试启动脚本不清理新数据库配置后回退源码 auth.db；半迁移只进入维护状态。
- [ ] 输出脱敏清单、数量/哈希/数据库完整性报告。新系统产生数据后不得直接 rollback 丢增量，需先保存并核对增量。

#### Task 17：经确认迁移、部署和交付

**新增:** `docs/deployment/multi-user-sandbox.md`，记录操作与验收。

- [ ] 请求确认真实数据目标 owner、备份位置、停机窗口、迁移范围；未经确认不 apply。
- [ ] Mac/node12 各迁各的用户数据，不通过 Git 同步数据库、病历、密钥。
- [ ] 先本地迁移验证历史聊天、附件链接、病例状态、个人记忆、技能；报告差异再继续。
- [ ] 经单独授权 push feat/multi-user、同步 node12、安装依赖、迁移并启动；不自行合入 develop。
- [ ] 检查实际静态端口和开发端口的登录/流式/预览一致；配置 HTTPS/WSS、Origin、管理入口权限。
- [ ] 用真实测试样本运行 RADAR/DeepChest/文档；缺少真实服务的用例保持未验收，不以假结果代替。
- [ ] 全部验收后开放多人，保存回滚说明和性能限制；需合入 develop 时再次按用户指示执行。

## 7. 总验收与禁止跳过项

- [ ] 同事代码合并记录明确，三个冲突正确解决，自动迁移已关闭。
- [ ] 两账号正常使用成功，跨账号直接请求/订阅/工具调用失败。
- [ ] Gateway owner 固定，缺身份不回退；启动/回收无孤儿进程或超配。
- [ ] 角色与 Agent 能力独立，admin 聊天也不能任意访问服务器。
- [ ] 普通用户无法取系统配置、raw YAML、密钥、Shell 或其他用户数据。
- [ ] 模型实际工具集及执行入口均受限，文档生成不依赖模型 Shell。
- [ ] G9/DeepChest 原报告、战创伤 Runner/快照、中文技能、四主题和预览保持正确。
- [ ] 用户离线记忆维护仍执行，用户之间不串库，删除不会被后台复活。
- [ ] 生产 Gateway 与 worker 越界读写/网络限制实测通过。
- [ ] 真实迁移和部署有明确授权、备份、验证和回滚记录。

## 8. 每批交接模板

```text
批次 / Task：
原基线 → 当前版本：
已完成：
修改文件：
测试命令及真实结果：
已知失败 / 功能差异 / 发布阻断：
是否触及真实数据或远程：默认无；如有列出授权
下一步：
```

**执行起点：用户批准开始后，Task 1 合并同事代码 → Task 2 禁自动迁移 → Task 3 临时环境验证。**
此文档创建时所有任务均未执行；文档完成不代表允许迁移、部署或开放多人访问。
