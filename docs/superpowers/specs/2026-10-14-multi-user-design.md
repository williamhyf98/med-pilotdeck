# med-pilotdeck 多用户功能设计

> 文档版本：2026-10-14
> 适用分支：`feat/multi-user-v2`（基于 develop 重新开始，不沿用 `feat/multi-user` 的代码）
> 取代：`feat/multi-user` 分支上的 `2026-09-23-multi-user-sandbox-implementation.md`。旧文档里「用业务能力服务替换通用工具」的路线**不采用**；本文 §16 改为「保留通用工具 + 后端硬校验 + 操作系统级沙箱」的用户目录沙箱方案。
> 参考实现：`feat/multi-user` 分支的 `gatewayPool.js`、`userHomes.js`、`userScope.js`，以及 `Downloads/mailob/PilotDeck` 的 `ensureDefaultAdminUser.js`。两者只作阅读参考，所有代码在 v2 重写。

---

## 1. 目标与范围

### 1.1 目标

让同一台服务器上的多位医生各自登录、各自拥有完全独立的项目、会话、记忆、技能和上传文件，互不可见。管理员比普通用户只多出「全局配置」能力，看不到别人的数据。

### 1.2 本文覆盖

- 账号、角色、注册、登录、登出与令牌失效
- 每个用户独立的数据目录与路径解析
- 每个活跃用户独立的 Gateway 进程及进程池
- 单机免登录模式与旧数据迁移
- 技能、记忆、设置页、非浏览器入口在多用户下的归属规则
- 前端账号区与管理页
- 用户目录沙箱：Agent 保留通用工具，靠后端路径校验与操作系统级沙箱防止越界（§16）
- 目录瘦身与清理策略（§9.4、§10.5）

### 1.3 本文不覆盖

- 用业务能力服务替换通用工具的「受控执行」路线（旧文档批次 C/D）
- 用户间共享项目、团队角色、SSO、共享技能目录
- 跨用户记忆
- 管理员浏览他人数据的任何入口

---

## 2. 已确认的决策

以下各项已与产品负责人逐条确认，是本文其余部分的前提。

| # | 决策 |
|---|---|
| D1 | 数据隔离采用**每用户独立 Gateway 子进程**，各自带 `PILOT_HOME=<root>/users/<userId>`。不把 userId 穿透进引擎的路径函数。 |
| D2 | **启动即有 admin**：服务启动时若用户表为空，自动创建用户名 `admin`、角色 `admin` 的账号。初始密码取环境变量 `PILOTDECK_ADMIN_PASSWORD`，未设置则为 `passok`。**不做**启动时密码同步，管理员改过的密码重启后保持。 |
| D3 | 角色是数据库字段 `users.role`，取值 `admin` / `user`，**不靠用户名判断**。注册接口禁止任何人注册用户名 `admin`。 |
| D4 | **公开注册默认开放**，注册出来的一律是 `user`。管理员可在设置页关闭注册，关闭后只能由管理员创建账号。角色只能由管理员修改。 |
| D5 | **单机免登录模式保留**：`PILOTDECK_DISABLE_LOCAL_AUTH` 为真时，所有请求自动以 `admin` 身份处理，数据落在 `users/<adminId>/`。两种模式共用同一套路径逻辑。 |
| D6 | **旧数据启动时自动迁移**到 admin 名下，但带快照、标记与失败即停三道保险（见 §9）。 |
| D7 | 技能只分**内置**（发行包内只读）和**个人**（`users/<userId>/skills/`）。不做共享技能层。 |
| D8 | **无任何跨用户记忆**。`memory/global/` 按用户各一份。 |
| D9 | Gateway 池按**几十个活跃用户**设计，上限为配置项。 |
| D10 | 普通用户设置页只保留：账号密码、主题 / 语言 / 排序等外观偏好、本人记忆开关与导入导出。模型、服务、MCP、插件、更新全部归管理员。 |
| D11 | **管理员看不到他人数据**，只比普通用户多出用户管理与全局配置。 |
| D12 | 非浏览器入口：CLI / TUI 仅在免登录模式可用（即 admin）；外部 API key 按表中已有的 `user_id` 归属请求；IM 接入与 always-on 常驻任务在多用户模式下**禁用**。 |
| D13 | 记忆后台维护（Index / Dream）**只在用户 Gateway 在线时运行**，不为离线用户拉起进程。 |
| D14 | 所有代码在 `feat/multi-user-v2` **重写**，旧分支仅作参考。 |
| D15 | **Agent 保留通用工具**（bash、read_file 等）。越界防护靠三层：提示词引导、文件与插件工具的后端硬校验、bash 的操作系统级沙箱。提示词不算安全边界。 |
| D16 | bash 沙箱做成**可替换适配层**：Linux 生产用 bubblewrap，macOS 开发用 `sandbox-exec`，`none` 仅在显式配置下允许。多用户模式下无可用沙箱则拒绝启动。 |
| D17 | 旧目录中的诊断日志、空目录、历史迁移产物、孤儿默认项目**不带入新结构**；保留的目录加清理策略（§9.4、§10.5）。 |

---

## 3. 总体架构

```text
浏览器 A           浏览器 B
    │                  │
    └────────┬─────────┘
             ▼
  UI 服务器（Express，单进程，共享）
    ├─ 认证中间件：JWT → req.user{id, role, tokenVersion}
    ├─ 请求作用域：AsyncLocalStorage 携带 userId，所有路径解析据此得到 userHome
    ├─ 账号库：<root>/system/auth.db（唯一写入者）
    └─ Gateway 池：userId → 子进程 { port, token, 状态, 最后活跃时间 }
             │                        │
             ▼                        ▼
   Gateway 进程 A                Gateway 进程 B
   PILOT_HOME=<root>/users/A     PILOT_HOME=<root>/users/B
   引擎代码不变，只认自己的 home   引擎代码不变，只认自己的 home
             │                        │
             ▼                        ▼
   <root>/users/A/…              <root>/users/B/…
             └──────────┬─────────────┘
                        ▼
              共享模型服务 / 医学远程服务（RADAR、DeepChest 等）
```

三条原则：

1. **引擎（`src/`）不感知多用户。** 它继续读 `PILOT_HOME`，只是这个值由 UI 服务器在 spawn 时按用户给定。`src/pilot/paths.ts` 的函数签名不变。
2. **UI 服务器是唯一的多用户感知层。** 所有 REST 路由、文件服务、记忆导入导出、技能 CRUD 都通过请求作用域拿到当前用户的 home，再调用现有的路径函数。
3. **身份只来自后端认证。** userId 不从前端参数、URL、模型输出或目录名推断。缺少作用域的请求直接报错，不回退到任何默认用户。

---

## 4. 目录结构

```text
<PILOT_ROOT>/                         # 原 PILOT_HOME 所指位置，例如 .pilotdeck-home
  pilotdeck.yaml                      # 系统级配置（模型、服务地址、密钥），仅 UI 服务器与 Gateway 启动时读取
  plugins/                            # 管理员安装的插件，所有用户共享只读（现有 med-tools 符号链接保留在此）
  system/
    auth.db                           # 账号、会话、注册开关等（由 DATABASE_PATH 指向此处）
    gateway-tokens/<userId>           # 每个用户 Gateway 的服务令牌
    gateway-pids.json                 # 池内子进程 pid，供 stop 脚本与启动扫描使用
    config-backups/                   # 操作者手工备份的 pilotdeck.yaml（可选）
    migration/
      legacy-done.json                # 旧数据迁移完成标记
      history/                        # 历史迁移报告与备份（migration-reports、migration-backups 等）
  users/
    <userId>/                         # 该用户的 PILOT_HOME，内部布局与今天的单机 PILOT_HOME 一致
      projects/<typeKey>/<projectId>/
      workspaces/<typeKey>/<workspaceId>/
      memory/global/
      memory/<typeKey>/<projectId>/
      skills/                         # 个人技能
      archives/                       # 删除项目后的快照，30 天自动清理
      logs/                           # trauma-agent.jsonl 等审计日志，按大小滚动
      .pilotdeck/tool-results/        # 会话回放依赖的工具输出缓存
      .tmp/chat-attachments/          # 附件暂存，7 天清理
      .legacy-bundled-skills-migrated-v1   # 建目录骨架时预写，跳过内置技能迁移
      plugins -> ../../plugins        # 符号链接，建骨架时创建
      router/ telemetry/ cron/        # 仅在对应功能开启时才创建；多用户模式下三者默认关闭
  archives/
    legacy-<timestamp>/               # §9 迁移前的原始快照
```

`<userId>` 使用数据库自增整数的字符串形式（与现有 `users.id` 一致）。不引入新的 UUID，避免账号库与目录名两套 ID。

**为什么用户目录内部布局与今天一致**：这样 `src/pilot/paths.ts` 和 `ui/server/utils/pilotPaths.js` 的全部函数无需修改，只需把传入的 `pilotHome` 从「全局」换成「该用户的」。引擎、测试、迁移脚本的既有假设全部保留。

**根目录瘦身后只剩五样**：`pilotdeck.yaml`、`plugins/`、`system/`、`users/`、`archives/`。每个用户目录常态下八个条目：`projects`、`workspaces`、`memory`、`skills`、`archives`、`logs`、`.pilotdeck`、`.tmp`。

---

## 5. 账号、角色与令牌

### 5.1 数据库变更

`ui/server/database/init.sql` 增加：

```sql
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';        -- 'admin' | 'user'
ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
-- 初始行：('allow_public_registration', 'true')
```

迁移通过 `db.js` 现有的「检查列是否存在再 ALTER」模式完成，不删表。`session_names` 表当前没有用户维度，改为复合唯一键 `(user_id, session_id)`，旧行在迁移时归到 admin。

数据库文件位置：`DATABASE_PATH` 默认值从源码目录改为 `<PILOT_ROOT>/system/auth.db`。启动脚本 `scripts/lib-local-runtime.sh` 中清理 `DATABASE_PATH` 的逻辑要同步调整，避免回退到源码目录下的旧库。

### 5.2 启动引导

`ensureDefaultAdminUser()` 在数据库初始化之后、监听端口之前运行：

1. 若 `users` 表为空：创建 `admin`，`role='admin'`，密码为 `PILOTDECK_ADMIN_PASSWORD` 或 `passok`，并建好 `users/<id>/` 目录骨架。控制台打印一行提示，若使用了默认密码则额外提示修改。
2. 若已有用户但没有任何 `role='admin'` 的激活账号：**不自动提权**，打印错误并拒绝启动。这种状态只能由操作者用迁移命令修复（见 §9.3），避免重启带来隐式提权。
3. 不比对、不重置既有 admin 的密码。

### 5.3 注册

`POST /api/auth/register`：

- 用户名为 `admin`（不区分大小写）直接 403。
- `system_settings.allow_public_registration` 为 `false` 时 403，错误码 `REGISTRATION_DISABLED`。
- 免登录模式下 403（与现状一致）。
- 成功后 `role` 固定为 `user`，建目录骨架，返回 JWT。
- 去掉「已有用户则拒绝第二个」的单用户限制。

管理员创建账号走 `POST /api/admin/users`，可指定 `role`。

### 5.4 登录与令牌

- JWT 载荷增加 `role` 与 `tokenVersion`。有效期保持 7 天。
- 认证中间件校验 JWT 后，再从数据库读取用户，比对 `is_active` 与 `token_version`，任一不符则 401。这样密码重置、停用、强制下线都能立即生效，代价是每个请求多一次 SQLite 主键查询，可接受。
- `POST /api/auth/logout` 不再只是前端删 token：将本用户 `token_version + 1`，使该用户所有设备的旧 JWT 失效。第一版不做「只退出当前设备」，保持简单。
- 用户自己改密码、管理员重置密码、管理员停用账号，都令 `token_version + 1`。
- 已建立的 WebSocket 连接在 `token_version` 变化后由 UI 服务器主动关闭（见 §7.4）。

### 5.5 权限中间件

- `authenticateToken`：现有，补 role / tokenVersion 校验。
- `requireAdmin`：新增，`req.user.role !== 'admin'` 则 403。免登录模式下 `req.user` 就是 admin，天然通过。
- 保护最后一个管理员：停用、降级、删除操作若会导致没有任何激活的 admin，则 409 拒绝。

### 5.6 管理接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/users` | 列表：id、username、role、is_active、created_at、last_login、存储用量（目录大小，异步计算可缓存） |
| POST | `/api/admin/users` | 创建账号 |
| PATCH | `/api/admin/users/:id` | 改 role、is_active |
| POST | `/api/admin/users/:id/reset-password` | 重置密码，返回一次性新密码 |
| DELETE | `/api/admin/users/:id` | 停用并归档目录到 `archives/users/<id>-<timestamp>/`，不物理删除 |
| GET / PUT | `/api/admin/settings/registration` | 读写 `allow_public_registration` |

以上全部挂 `requireAdmin`。管理接口**不提供**读取他人项目、会话、记忆、文件的任何端点。

---

## 6. 请求作用域与路径解析

### 6.1 作用域机制

新增 `ui/server/middleware/userScope.js`，基于 `AsyncLocalStorage`：

```js
// 认证之后立即进入
runWithUserScope({ userId: req.user.id, role: req.user.role }, next);

// 任意深度的服务代码
const { userId } = requireUserScope();   // 没有作用域 → 抛 UserScopeMissingError，响应 500
const userHome = resolveUserHome(userId); // <PILOT_ROOT>/users/<userId>
```

`requireUserScope()` **没有兜底**。这是和旧实现最重要的差别：旧实现缺少作用域时回退到全局目录，这正是数据串用的来源。

WebSocket 连接在握手时完成认证并把作用域绑定到该连接对象，后续每条消息的处理都在该作用域内执行。

### 6.2 UI 服务器侧路径解析

`ui/server/utils/pilotPaths.js` 新增两个入口，其余函数不动：

```js
export function resolvePilotRoot(env = process.env)   // 原 resolvePilotHome 的语义，指向 <PILOT_ROOT>
export function resolveUserHome(userId, env)           // <PILOT_ROOT>/users/<userId>
```

当前有十处模块在加载时或请求时调用 `resolvePilotHome(process.env)` 取全局 home（`projects.js` 9 处、`memoryService.js` 7 处、`storage.js` 3 处、`commands.js` 4 处、`caseState.js`、`git.js`、`mcp.js`、`messages.js`、`taskmaster.js`、`skills.js` 各 1 处）。全部改为在请求内调用 `resolveUserHome(requireUserScope().userId)`。

**模块级常量必须拆掉。** 例如 `memoryService.js` 第 24 行 `MEMORY_ROOT_DIR = path.join(process.env.PILOT_HOME, 'memory')` 这类在 import 时固化的路径，要改成函数。这是本项目最容易漏的一类改动，测试策略 §12 专门覆盖。

### 6.3 引擎侧

`src/pilot/paths.ts` 不改签名。Gateway 子进程启动时拿到 `PILOT_HOME=<PILOT_ROOT>/users/<userId>`，所有现有函数自然工作在用户目录内。

唯一要确认的是引擎里有没有绕过 `resolvePilotHome()` 直接读 `~/.pilotdeck` 或源码相对路径的地方。已知一处：`src/cli/commands/gatewaySetup.ts:7`。实施时 grep `homedir()` 与 `.pilotdeck` 字面量逐一核对。

### 6.4 跨实现一致性

TS 与 JS 两份路径实现必须对同一输入给出同一输出。新增测试 `tests/pilot/user-paths-parity.spec.ts`：对固定的 `(userId, projectId, typeKey)` 组合，分别调用两边函数，断言字符串相等。

---

## 7. Gateway 池

### 7.1 现状

今天 UI 服务器不创建 Gateway，而是通过 `createRemoteGateway({ url, token })` 连到启动脚本单独拉起的那个进程。`pilotdeck-bridge.js` 里 `gatewayPromise` 是模块级单例。

### 7.2 目标

新增 `ui/server/services/gatewayPool.js`，对外只有一个接口：

```js
const lease = await gatewayPool.acquire(userId);   // 返回 { gateway, release() }
try { await lease.gateway.submitTurn(...) } finally { lease.release(); }
```

`pilotdeck-bridge.js` 中所有 `ensureGateway()` 调用改为 `acquire(requireUserScope().userId)`。bridge 内部按 sessionKey 缓存的运行态（订阅、watch-session 等）全部把 key 改为 `${userId}:${sessionKey}`。

### 7.3 子进程生命周期

| 状态 | 进入条件 | 说明 |
|---|---|---|
| `starting` | 首次 acquire 且池内无该用户实例 | spawn `node dist/src/cli/pilotdeck.js server`，环境变量：`PILOT_HOME=<root>/users/<id>`、`PILOTDECK_GATEWAY_PORT=<动态分配>`、`PILOTDECK_GATEWAY_TOKEN_PATH=<root>/system/gateway-tokens/<id>`、`PILOTDECK_CONFIG_PATH=<root>/pilotdeck.yaml`。同用户并发 acquire 复用同一个启动 promise。 |
| `ready` | WebSocket 连上并通过令牌校验 | 可以发放租约 |
| `busy` | 活跃租约数 > 0 | 不可回收 |
| `idle` | 活跃租约数 = 0 | 记录 `idleSince`，可回收 |
| `stopping` | 被回收或服务关闭 | 先 `gateway.close()`，再 SIGTERM，5 秒后 SIGKILL，确认退出后才释放端口与池容量 |
| `failed` | 启动超时或进程异常退出 | 清理条目，下一次 acquire 重试。连续失败 3 次后该用户 10 分钟内直接返回 503 |

配置文件 `pilotdeck.yaml`：引擎启动时要读模型与服务配置，而这份配置含密钥，不应复制进用户目录。做法是 Gateway 通过 `PILOTDECK_CONFIG_PATH` 直接指向 `<root>/pilotdeck.yaml` 读取，用户目录内不放副本。普通用户看不到这个文件内容，因为读取配置的 REST 接口在 UI 服务器侧已被 `requireAdmin` 拦住。

端口分配：从 `PILOTDECK_GATEWAY_PORT_BASE`（默认 18800）起向上探测空闲端口，只绑定 `127.0.0.1`。

### 7.4 回收与容量

| 参数 | 配置键 | 默认值 | 依据 |
|---|---|---|---|
| 最大活跃实例 | `multiUser.gatewayPool.maxInstances` | 30 | 实测单个空闲 Gateway 约 139 MB（macOS，tsx 开发模式，含 MCP 子进程前）。30 个约 4 GB，模型服务不在同机时可接受。生产环境以 `dist/` 启动会略低。 |
| 空闲回收时间 | `multiUser.gatewayPool.idleTimeoutMs` | 30 分钟 | 医生问诊间隙通常在此以内 |
| 启动超时 | `multiUser.gatewayPool.startTimeoutMs` | 60 秒 | 与现有 `PILOTDECK_BRIDGE_TIMEOUT` 一致，覆盖 MCP 冷启动 |
| 等待队列上限 | `multiUser.gatewayPool.maxWaiting` | 20 | 超出直接 503 |

达到上限时的处理顺序：先淘汰 `idle` 中 `idleSince` 最早的实例；若没有 idle 实例，请求进入等待队列，队列按先到先得，任一实例进入 idle 或被释放时唤醒队首。

**令牌失效联动**：§5.4 中 `token_version` 变化时，UI 服务器关闭该用户所有 WebSocket 连接，并把该用户 Gateway 标记为可立即回收（不等 idle 超时），防止被停用的账号继续通过已有连接工作。

### 7.5 服务关闭

UI 服务器收到 SIGTERM 时，对池内所有实例执行 `stopping` 流程，等待最多 15 秒，再退出。`scripts/stop-local.sh` 要能找到并清理所有子进程，建议子进程以进程组方式 spawn（`detached: false` 且记录 pid 到 `<root>/system/gateway-pids.json`），脚本按文件清理残留。

### 7.6 启动脚本

`scripts/start-local.sh` 与 `dev-launcher.mjs` 目前并行拉起「一个 Gateway + UI 服务器」。多用户模式下不再预拉 Gateway，由池按需创建。免登录模式下也走池，只是池里永远只有 admin 一个实例，行为与今天一致。

---

## 8. 单机免登录模式

`PILOTDECK_DISABLE_LOCAL_AUTH` 为真时：

- 认证中间件跳过 JWT，把 `req.user` 设为数据库中的 admin 账号（启动引导保证存在）。
- 请求作用域、路径解析、Gateway 池全部照常工作，userId 恒为 admin 的 id。
- 注册、登录、管理用户页隐藏或 403。
- CLI / TUI 直接读 `PILOT_HOME=<root>/users/<adminId>`：在 `scripts/config.env` 中导出该值。多用户模式下 CLI 不导出这个变量，启动时若检测到 `<root>/users/` 存在且未指定 `PILOT_HOME`，打印提示并退出。

代码上不存在「免登录模式专用」的路径分支。免登录只是认证中间件的一个开关。

---

## 9. 旧数据自动迁移

### 9.1 触发条件

启动时，数据库初始化并保证 admin 存在之后，检测 `<PILOT_ROOT>` 下是否存在旧布局：`projects/`、`workspaces/`、`memory/`、`skills/`、`always-on/`、`archives/` 中任意一个非空目录。同时满足以下条件才迁移：

- `<PILOT_ROOT>/users/` 不存在，或存在但为空
- `<PILOT_ROOT>/system/migration/legacy-done.json` 不存在

任一条件不满足则跳过，只打印一行说明。

### 9.2 迁移步骤

1. 创建 `<PILOT_ROOT>/archives/legacy-<timestamp>/`，把 §9.4 表中**全部**旧条目（含将被丢弃的）**硬链接复制**进去作为快照（同一文件系统下成本极低；跨文件系统退化为普通复制）。
2. 创建 `<PILOT_ROOT>/users/<adminId>/` 骨架（含 `plugins` 符号链接与内置技能迁移标记），把 §9.4 中标记为「搬入 admin」的目录逐个 `rename` 进去。
3. 把 `auth.db` 移动到 `system/auth.db`；若源码目录下还有旧库且新位置没有，同样移动。
4. 把 §9.4 中标记为「归档」的条目移入 `system/migration/history/`，标记为「丢弃」的条目从根目录删除（快照中仍有）。
5. 写入 `legacy-done.json`：时间、admin id、每个条目的处理方式、快照路径。
6. 任一步失败：打印错误，**退出进程，不监听端口**。此时快照完好，操作者可手工恢复或重试。

迁移在任何 Gateway 启动之前完成，不存在读写竞争。

### 9.3 操作者命令

提供 `scripts/migrate-user-storage.mjs`，支持 `--dry-run`（只打印每个条目的处理方式和大小）与 `--assign-admin <username>`（无 admin 时手动指定某个既有账号为管理员，对应 §5.2 第 2 条）。

### 9.4 旧目录逐项处理表

以 2026-10-14 开发机上的 `.pilotdeck-home` 为样本。处理方式分三种：**搬入 admin**（进入 `users/<adminId>/`）、**归档**（进入 `system/migration/history/`，不再参与运行）、**丢弃**（只留在 legacy 快照里）。

| 旧条目 | 处理 | 新位置 | 依据 |
|---|---|---|---|
| `pilotdeck.yaml` | 原地保留 | `<root>/pilotdeck.yaml` | 系统级配置 |
| `pilotdeck.yaml.bak-*` | 原地保留 | 不动；操作者可自行移入 `system/config-backups/` | 操作者手工备份，迁移不碰 |
| `plugins/`（含 med-tools 符号链接） | 原地保留 | `<root>/plugins/` | 共享只读；每个用户目录用符号链接指回 |
| `auth.db` | 搬入系统层 | `system/auth.db` | 账号库 |
| `server-token` | 丢弃 | 由池按用户在 `system/gateway-tokens/` 重新生成 | 旧令牌作废 |
| `projects/general_med/`、`projects/trauma_med/` | 搬入 admin | `users/<admin>/projects/…` | 用户数据 |
| `projects/Users-william-…-.pilotdeck-home/` | 丢弃 | 无 | 「无项目对话」的默认容器，目录名由 `PILOT_HOME` 路径派生，搬家后引擎会生成新名字，旧目录必然成为孤儿；样本中仅一条 2 KB 会话 |
| `workspaces/general_med/`、`workspaces/trauma_med/` | 搬入 admin | `users/<admin>/workspaces/…` | 用户数据（样本 252 MB） |
| `workspaces/general/` | 丢弃 | 无 | 未分类旧布局残留，空目录 |
| `memory/` | 搬入 admin | `users/<admin>/memory/` | global、general_med、trauma_med 整体搬 |
| `skills/` | 搬入 admin | `users/<admin>/skills/` | 个人技能 |
| `archives/projects/` | 搬入 admin | `users/<admin>/archives/projects/` | 删除项目的快照，受 §10.5 的 30 天策略约束 |
| `.pilotdeck/tool-results/` | 搬入 admin | `users/<admin>/.pilotdeck/tool-results/` | `readSessionMessages.ts`、`forkSession.ts` 读取，会话回放依赖 |
| `.tmp/chat-attachments/` | 搬入 admin | `users/<admin>/.tmp/chat-attachments/` | 附件暂存，受 7 天清理约束 |
| `logs/trauma-agent.jsonl` | 搬入 admin | `users/<admin>/logs/` | 战创伤审计日志含病例内容，必须按用户；受滚动策略约束 |
| `.legacy-bundled-skills-migrated-v1` | 搬入 admin | `users/<admin>/` | `migrateLegacyBundledSkills.ts` 读取此标记 |
| `router/events.jsonl`、`router/stats.jsonl` | 丢弃 | 无 | 仅 `createLocalGateway.ts:1066` 写入，产品代码无读取方；写入改为调试开关，默认关 |
| `telemetry/` | 丢弃 | 无 | 空目录；`telemetry.enabled: false` 时不再创建 |
| `cron/` | 丢弃 | 无 | 空目录；多用户模式下常驻任务禁用，不创建 |
| `migration-backups/`、`migration-reports/` | 归档 | `system/migration/history/` | 2026-09 路径迁移的产物，无读取方 |
| `.workspace-migration-v1.json` | 归档 | `system/migration/history/` | 一次性迁移标记，引擎与 UI 服务器均不读取 |

表外出现的未知条目：迁移脚本一律**归档**并在日志中列出，不丢弃也不搬入用户目录，由操作者事后判断。

---

## 10. 技能、记忆、设置与其他入口

### 10.1 技能

- 内置技能：发行包内，只读，所有用户可见。
- 个人技能：`users/<userId>/skills/`。`SkillManager` 的 CRUD 路由通过作用域拿目录，无需改内部逻辑。
- `PluginRuntime.collectSkillContributions()` 的优先级 project > global > builtin 保持不变，global 自然指向用户目录。
- 新账号的 `skills/` 为空，不复制任何人的技能。

### 10.2 记忆

- `memory/global/` 与 `memory/<typeKey>/<projectId>/` 都在用户目录内，自动隔离。
- 维护调度器随 Gateway 进程生存：用户 Gateway 在线时按现有逻辑跑；被回收时调度器一起结束，下次拉起时按「上次维护时间」补跑一次。不在 UI 服务器侧另建全局调度器。
- 记忆导入导出路由（`memoryService.js`）改为作用域内解析，导入时拒绝包含 `..` 或绝对路径的条目（现有校验保留）。

### 10.3 设置页

| 区块 | 普通用户 | 管理员 |
|---|---|---|
| 账号：改密码、退出 | 可用 | 可用 |
| 外观：主题、语言、排序、输入偏好 | 可用，服务端按 userId 保存 | 可用 |
| 记忆：本人开关、查看 / 删除 / 导入导出 | 可用 | 可用 |
| 模型与路由、服务地址、密钥、MCP、插件 | 隐藏，后端 403 | 可用，密钥掩码不回显 |
| 系统：更新、重启、环境变量 | 隐藏，后端 403 | 可用 |
| 用户管理、注册开关 | 隐藏，后端 403 | 可用 |

**后端必须真拦**：`routes/config.js`、`settings.js`、`plugins.js`、`mcp.js`、`update.js`、`gateway.js` 中所有读取完整配置或执行系统操作的端点挂 `requireAdmin`，包括 GET。解析失败时返回 raw YAML 的分支同样受限。前端隐藏菜单只是体验层。

`routes/user.js` 中修改个人 Git 配置的接口会调用 `git config --global`，在多用户下会互相覆盖。改为写入 `users/<userId>/.gitconfig` 并在该用户 Gateway 的环境中设置 `GIT_CONFIG_GLOBAL` 指向它。

### 10.4 非浏览器入口

| 入口 | 多用户模式 | 免登录模式 |
|---|---|---|
| CLI / TUI | 启动时检测到 `users/` 且无 `PILOT_HOME` 则提示并退出 | 走 admin 目录 |
| 外部 API key | 中间件按 `api_keys.user_id` 建立作用域，与 JWT 等价 | 同左 |
| IM 接入 | 配置加载时若多用户模式则跳过注册并打印警告 | 保持现状 |
| always-on 常驻任务 | Gateway 启动参数禁用 | 保持现状 |

### 10.5 清理策略

保留下来的几类会持续增长的目录，统一由各用户 Gateway 在启动时和每日一次的轻量任务里清理，不在 UI 服务器侧另建调度器。参数全部为配置项，位于 `multiUser.retention.*`。

| 目录 | 策略 | 默认值 | 说明 |
|---|---|---|---|
| `logs/*.jsonl` | 按大小滚动 | 单文件 20 MB，保留 5 份 | 审计日志有保留价值，不按时间删 |
| `.pilotdeck/tool-results/` | 随会话删除 | 无时间阈值 | 删除会话时同步删除其工具输出；不单独过期，否则历史回放会缺块 |
| `.tmp/chat-attachments/` | 按修改时间 | 7 天 | 已被引用进项目的附件早已复制到 workspace，暂存区可放心清 |
| `archives/projects/` | 按创建时间 | 30 天 | 存储页提供「立即清空」按钮；清理前在存储页显示将删除的条目数 |
| `router/`、`telemetry/`、`cron/` | 不创建 | 功能关闭时不建目录 | `router` 事件写入改为 `PILOTDECK_ROUTER_DEBUG=1` 才开启 |

清理只删除本用户目录内的文件，使用 §16 同样的「路径必须在用户 home 内」校验，防止配置错误导致越界删除。

---

## 11. 前端改动

- 登录 / 注册页：注册表单在 `allow_public_registration=false` 时隐藏并提示「请联系管理员开通」；状态由 `GET /api/auth/status` 返回。
- 侧栏底部增加账号区：用户名、角色标签、退出按钮。退出时清空本地缓存与 React Query 缓存，关闭 WebSocket。
- 本地存储键（最近项目、折叠状态等）加 `userId` 前缀，避免同一浏览器切换账号后串台。
- 设置页按 §10.3 分区，普通用户不加载 `usePilotDeckConfig` 的完整配置 hook，改为只请求 `/api/settings/me`。
- 管理员新增「用户管理」页：列表、创建、停用、重置密码、改角色、注册开关。
- 401 的全局处理：收到 `TOKEN_REVOKED` 或 `USER_DISABLED` 时跳转登录页并清缓存。

---

## 12. 错误处理

| 场景 | 行为 |
|---|---|
| 请求无作用域到达路径解析 | 500，日志打印调用栈。这是编程错误，不是用户错误，测试阶段必须清零 |
| Gateway 启动失败 | 503 `GATEWAY_UNAVAILABLE`，前端提示稍后重试 |
| 池满且队列满 | 503 `GATEWAY_POOL_EXHAUSTED`，提示当前在线人数过多 |
| 令牌版本不符 | 401 `TOKEN_REVOKED` |
| 账号停用 | 401 `USER_DISABLED` |
| 注册关闭 | 403 `REGISTRATION_DISABLED` |
| 尝试注册 `admin` | 403 `RESERVED_USERNAME` |
| 停用最后一个管理员 | 409 `LAST_ADMIN` |
| 迁移失败 | 进程退出码 1，不监听端口 |
| 普通用户访问管理端点 | 403，响应体不透露端点是否存在以外的信息 |

---

## 13. 测试策略

所有测试使用 `mkdtemp` 临时根和临时账号库，通过环境变量 `PILOT_HOME`、`DATABASE_PATH`、`PILOTDECK_CONFIG_PATH` 指向临时位置。测试不启动真实模型，Gateway 池测试使用可注入的假 spawn。

### 13.1 单元测试

- `ui/server/middleware/userScope.spec.js`：有作用域正确返回；无作用域抛错且不回退。
- `ui/server/utils/pilotPaths.users.spec.js`：`resolveUserHome` 输出；与 TS 侧的一致性测试 `tests/pilot/user-paths-parity.spec.ts`。
- `ui/server/routes/auth.multiuser.spec.js`：启动引导建 admin；默认密码与环境变量；不重置既有密码；无 admin 时拒绝启动；注册 `admin` 被拒；注册开关；第二个用户可注册且 role 为 user；logout 后旧 JWT 401；重置密码后旧 JWT 401；最后一个 admin 不可停用。
- `ui/server/services/gatewayPool.spec.js`：同用户并发 acquire 只 spawn 一次；A/B 得到不同进程与不同 `PILOT_HOME`；idle 超时回收；上限淘汰 LRU；队列唤醒；启动失败重试与熔断；token_version 变化触发回收；关闭时清理全部子进程。
- `ui/server/services/legacyMigration.spec.js`：§9.4 表中每一类条目都得到对应处理（搬入 / 归档 / 丢弃 / 未知条目归档）且快照完整；有标记则跳过；`users/` 非空则跳过；中途失败不写标记且进程退出。
- `tests/tool/sandbox-adapter.spec.ts`：三种适配器生成的包装命令正确，bwrap 的 argv 只挂载用户 home 可写、代码与 node 只读、无其他 `--bind`；`none` 在多用户模式且未显式允许时抛错；自动探测顺序正确。此测试不执行真实命令，macOS 上可跑。
- `tests/tool/path-safety-multiuser.spec.ts`：Web 模式下 `bypassPermissions` 不再跳过路径校验；经符号链接指向用户 home 之外的路径被拒；`read_skill` 返回的路径不含绝对前缀；网络工具拒绝 `file://`。

### 13.2 隔离回归（最重要）

`ui/server/multiUser.isolation.spec.js`：以 A、B 两个账号各建一个同名项目、同名附件、同 sessionId 的会话，然后逐个端点验证：

- A 列项目看不到 B 的；A 用 B 的 projectId 请求得到 404。
- A 的记忆搜索不命中 B 的内容。
- A 的技能列表不含 B 的个人技能。
- A 的文件预览 / 下载请求 B 的路径得到 404。
- B 的 session_names 不出现在 A 的会话列表。
- A 的 Agent 调用 `read_file`、`glob`、`grep` 读取 `../../users/<B>/…` 以及指向 B 目录的符号链接，全部被拒。

此测试在每个批次结束时都要跑，作为合并门槛。

### 13.3 Linux 容器内的沙箱对抗测试

bash 沙箱的真实效果只能在 Linux 上验证。新增 `docker compose run sandbox-test`：基于仓库现有的 bookworm 镜像安装 bubblewrap，在容器里启动 A、B 两个用户的 Gateway，由测试脚本以 A 的身份提交一组对抗性命令，断言全部失败：

```bash
cat ../../users/<B>/memory/global/*.md
ls /
cat /etc/passwd
bash -c 'cd / && find . -name "*.jsonl"'
python3 -c 'print(open("/proc/1/environ").read())'
curl file:///etc/hostname
ln -s ../../users/<B> ./peek && cat peek/memory/global/*.md
```

同时验证正向用例仍然通过：docx / pptx / pdf 技能的脚本在沙箱内能正常生成文件到本用户 workspace。此测试进 CI；本地开发机不要求每次跑。

### 13.4 模块级常量扫描

一个静态检查脚本 `scripts/check-module-level-pilot-home.mjs`：在 `ui/server/**` 中查找顶层作用域对 `process.env.PILOT_HOME`、`resolvePilotHome(` 的引用，命中即失败。纳入 `npm --prefix ui run typecheck` 之前执行。

### 13.5 手工冒烟

两个浏览器会话分别登录 A、B，各自创建项目、上传文件、对话、查看记忆；管理员停用 B 后 B 的页面应立刻跳回登录；重启服务后数据各归各处；免登录模式下行为与今天一致。

---

## 14. 实施批次概览

详细任务拆分由后续的实施计划文档给出。批次之间串行，每批结束跑 §13.2 隔离回归。

| 批次 | 内容 | 产出 |
|---|---|---|
| A 账号与作用域 | §5 数据库变更、启动引导、注册规则、令牌版本；§6 作用域中间件与 `resolveUserHome`；拆掉模块级常量 | 单进程下两个账号的 REST 数据已隔离，Gateway 仍是旧单例 |
| B Gateway 池 | §7 全部；bridge 改为按用户租约；启动脚本调整 | 两个账号各自独立 Gateway，对话、记忆、技能全隔离 |
| C 模式与迁移 | §8 免登录模式走 admin；§9 自动迁移与操作者命令 | 单机用户升级无感；旧数据归 admin |
| D 设置、入口与前端 | §10 设置页后端授权、Git 配置、非浏览器入口、§10.5 清理策略；§11 前端 | 普通用户与管理员界面分离，管理页可用 |
| E 用户目录沙箱 | §16 全部：文件与插件工具硬校验、沙箱适配层、bwrap / sandbox-exec 实现、`read_skill` 与 `file://` 收口；§13.3 容器对抗测试 | Agent 在 Linux 上无法越出用户目录；macOS 开发机有弱化沙箱 |
| F 验收 | §13.5 手工冒烟；内存与并发实测；Linux 真机跑 §13.3；文档 | 可开放科室内多人使用 |

批次 A 完成后系统已经可用（只是所有用户共用一个 Gateway 进程，会话运行态有串用风险），因此 A 不单独对外开放，A+B 一起才是最小可用版本。**批次 E 完成前不得在多人环境开放 bash 工具**：A 到 D 期间多用户模式下 bash 工具对普通用户暂时不可见，由配置 `multiUser.sandbox.bashEnabled=false` 控制，E 完成后翻为 true。

---

## 15. 风险与待实测项

| 项 | 说明 | 处理 |
|---|---|---|
| Gateway 实际内存 | 139 MB 是空闲值，对话中加载 MCP 子进程与大上下文后会上升 | 批次 E 用 5 个账号并发对话实测，据此调整 `maxInstances` 默认值 |
| 引擎内隐藏的全局路径 | 可能有绕过 `resolvePilotHome()` 的地方 | 批次 B 开始前 grep `homedir()`、`.pilotdeck`、`__dirname` 逐一核对 |
| bridge 运行态缓存 | `pilotdeck-bridge.js` 两千多行，按 sessionKey 的缓存散落多处 | 批次 B 统一改 key，并用隔离回归覆盖 watch-session、订阅、中断 |
| SQLite 并发 | 单进程写入，压力不大 | 开 WAL 与 `busy_timeout=5000` 即可 |
| 端口耗尽与僵尸进程 | 池异常时可能留下孤儿 Gateway | pid 文件 + stop 脚本清理 + 启动时扫描并回收上次残留 |
| 免登录模式下 CLI 与 Web 同时写同一目录 | 与今天行为一致，不新增风险 | 不处理 |
| 生产机缺少 bubblewrap | 麒麟 / 统信 / 鲲鹏 ARM64 均有 `bubblewrap` 包，但现场可能未装 | 部署脚本检查并安装；缺失时多用户模式拒绝启动（D16），日志给出安装命令 |
| `sandbox-exec` 被苹果标为弃用 | Darwin 24 上仍可用，未来版本可能移除 | 仅用于开发自测，不作为验收依据；若失效则 macOS 开发走 `none` 并显式配置允许 |
| 文档技能脚本在 bwrap 内缺依赖 | docx / pptx / pdf 脚本依赖 python、libreoffice 等系统程序 | §13.3 正向用例覆盖；bwrap 只读挂载 `/usr`、`/lib`、`/etc/alternatives` 等系统路径，不挂载 `/home`、`/root`、`/proc/1` |
| 符号链接绕过文件校验 | 用户在自己目录里建链接指向他人目录 | 校验用 realpath 后再比对；bwrap 内他人目录根本不存在，双保险 |

---

## 16. 用户目录沙箱

### 16.1 目标与边界

每用户独立 Gateway 保证了引擎「不知道」别人的目录，但 Agent 的通用工具接受任意路径或任意命令，仍可能被用户指令或上传文件中的注入内容带出用户目录。本节的目标是：**Agent 保留全部通用工具，但无论模型怎么调用，都只能触及本用户的 `PILOT_HOME`。**

三层防护，强度递增，缺一不可：

| 层 | 手段 | 性质 |
|---|---|---|
| 1 提示词 | 系统提示说明「你只能在当前工作目录与用户目录内操作」 | 体验层。降低误操作，**不计入安全边界** |
| 2 后端硬校验 | 文件工具、插件工具的路径参数在执行前校验必须位于用户 home 内 | 安全边界，对所有带路径参数的工具生效 |
| 3 操作系统级沙箱 | bash 命令在 bwrap / sandbox-exec 中执行，用户目录以外不可见 | 安全边界，对 bash 及其派生的一切子进程生效 |

### 16.2 文件与插件工具的硬校验

现有 `src/tool/builtin/filesystem/pathSafety.ts` 已对 `read_file`、`write_file`、`edit_file`、`glob`、`grep` 做范围校验，允许范围为当前 workspace 与 `$PILOT_HOME` 下若干固定子目录。多用户后 `$PILOT_HOME` 即用户 home，因此这套校验天然成为「只许在自己家里」。需补三处：

1. **堵掉 bypass**：第 28 行 `permissionMode === "bypassPermissions"` 时直接放行。Web 模式下该分支改为仍然执行范围校验，只跳过交互确认。CLI 本机模式保留原语义。
2. **realpath 比对**：所有「是否在根目录内」的判断先对候选路径与根目录做 `realpath`，再比较前缀。符号链接目标在用户 home 之外则拒绝。目标不存在的路径（写入新文件）对其父目录做 realpath。
3. **统一入口**：新增 `assertWithinUserHome(candidate, context)`，`pathSafety.ts` 与下述插件桥共用。错误码 `PATH_OUTSIDE_USER_HOME`，返回给模型的消息只说「路径不在允许范围内」，不回显真实根路径。

插件工具：`src/mcp/runtime/PluginToToolBridge.ts` 在把参数交给插件前，对 schema 中标记为路径类型的字段调用同一校验；`plugins/med-tools/server/app.py` 里接受绝对路径直接透传的分支一并收口，服务端二次校验 `PILOT_HOME` 前缀。

两个小口：`read_skill` 返回技能内容时去掉绝对安装路径，只给相对路径；网络类工具（`web_fetch` 等）拒绝 `file://` 与 `localhost` 以外的回环地址。

### 16.3 沙箱适配层

新增 `src/tool/builtin/bash/sandbox/`：

```ts
interface CommandSandbox {
  readonly kind: "bwrap" | "sandbox-exec" | "none";
  /** 把原始命令包装成实际要 spawn 的 argv；不改变 cwd 与 stdio 语义 */
  wrap(command: string, options: { cwd: string; userHome: string; env: NodeJS.ProcessEnv }): { file: string; args: string[] };
  /** 启动时自检：二进制存在、能执行 `true`，失败则返回原因 */
  probe(): Promise<{ ok: true } | { ok: false; reason: string }>;
}
```

`commandRunner.ts` 不再直接 `spawn(command, { shell: true })`，而是 `spawn(file, args)`，`file`/`args` 来自 `sandbox.wrap()`。`none` 的 `wrap` 返回 `{ file: "/bin/sh", args: ["-c", command] }`，行为与今天一致。

选择顺序：配置 `multiUser.sandbox.kind` 指定 > 自动探测（Linux 找 `bwrap`，macOS 找 `sandbox-exec`）> `none`。Gateway 启动时执行 `probe()`，日志第一行打印 `sandbox: bwrap (ok)`。多用户模式下若落到 `none` 且 `multiUser.sandbox.allowUnsandboxed` 不为 true，Gateway **拒绝启动**，UI 服务器收到启动失败后返回 503 并在管理页显示原因。免登录模式允许 `none`，只打警告。

### 16.4 bwrap 实现（Linux 生产）

`wrap()` 生成的 argv 骨架：

```text
bwrap
  --ro-bind /usr /usr  --ro-bind /lib /lib  --ro-bind /lib64 /lib64  --ro-bind /bin /bin  --ro-bind /sbin /sbin
  --ro-bind /etc/alternatives /etc/alternatives  --ro-bind /etc/ssl /etc/ssl  --ro-bind /etc/resolv.conf /etc/resolv.conf
  --ro-bind <APP_ROOT> <APP_ROOT>          # 代码、dist、node_modules、skills 脚本
  --ro-bind <NODE_BIN_DIR> <NODE_BIN_DIR>
  --bind <USER_HOME> <USER_HOME>           # 唯一可写区域
  --tmpfs /tmp  --proc /proc  --dev /dev
  --unshare-pid  --unshare-ipc  --unshare-uts
  --die-with-parent  --new-session
  --chdir <cwd>
  --setenv HOME <USER_HOME>  --setenv TMPDIR /tmp  --setenv PILOT_HOME <USER_HOME>
  /bin/sh -c <command>
```

要点：

- 不挂载 `/home`、`/root`、`<PILOT_ROOT>/users` 的上级、`<PILOT_ROOT>/system`、`<PILOT_ROOT>/pilotdeck.yaml`。模型在沙箱内 `ls <PILOT_ROOT>` 只看到自己的 home 这一条路径链。
- `--unshare-net` 作为配置项 `multiUser.sandbox.network`，默认 **不隔离网络**，因为医学技能需要调用远程 RADAR / DeepChest 服务。隔离网络时需要一个受控代理，本期不做。
- 环境变量白名单：`PATH`、`HOME`、`LANG`、`TMPDIR`、`PILOT_HOME` 与配置里显式列出的键；默认不透传宿主全部 env，避免密钥泄漏。
- `--die-with-parent` 保证 Gateway 被回收时沙箱内进程树一起结束，与 §7.3 的停止流程配合。
- 系统程序路径（python、libreoffice、ImageMagick 等）由 `multiUser.sandbox.extraReadOnlyBinds` 配置补充，部署脚本按目标发行版给默认值。

### 16.5 sandbox-exec 实现（macOS 开发）

生成一份 SBPL profile 写到 `<USER_HOME>/.tmp/sandbox.sb`：

```scheme
(version 1)
(deny default)
(allow process-exec process-fork signal)
(allow sysctl-read mach-lookup)
(allow network*)
(allow file-read* (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/System") (subpath "/Library")
                  (subpath "/private/etc") (subpath "/opt/homebrew") (subpath "<APP_ROOT>") (subpath "<NODE_BIN_DIR>"))
(allow file* (subpath "<USER_HOME>") (subpath "/private/tmp") (subpath "/private/var/folders"))
```

`wrap()` 返回 `{ file: "/usr/bin/sandbox-exec", args: ["-f", profilePath, "/bin/sh", "-c", command] }`。此实现只用于开发自测与 §13.1 的参数测试，**不作为生产验收依据**。

### 16.6 与现有能力的关系

- 文档技能（docx / pptx / pdf / spreadsheets / diagram-maker）的脚本在沙箱内运行，输出落到本用户 workspace，不需要改技能本身。§13.3 用正向用例确认。
- 战创伤 Runner 直接调用 `tool.execute()` 的路径同样经过 `commandRunner.ts`，自动受沙箱约束，无需单独处理。
- 子代理、`sessions_spawn` 派生的会话继承父会话的 `userHome` 与沙箱实例，不能通过嵌套获得更宽的范围。
- 管理员的 Agent 与普通用户使用**同一套**沙箱配置。管理员身份只影响 UI 服务器侧的管理接口，不放宽 Agent 能力（与 D11 一致）。
