# 多用户功能实施计划（二）：迁移、免登录收尾、管理员门禁与前端

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在计划一（账号、作用域、Gateway 池）之上，把旧数据搬进管理员目录、让免登录与命令行入口在新目录结构下正常工作、给系统配置接口加管理员门禁、补齐清理策略，并交付登录注册、账号区、角色化设置页与用户管理页，使多用户功能在界面上真实可用。

**Architecture:** 迁移是启动前的一次性服务加一条操作者命令，按设计文档 §9.4 的处理表逐项搬入 `users/<adminId>/`、归档或丢弃，带硬链接快照与完成标记。门禁复用 `requireAdmin`，按路由分类挂载；配置广播按角色过滤。清理任务跑在每个用户的 Gateway 进程里（引擎侧），只触碰本用户目录。前端在现有 `AuthContext`、`SidebarV2`、`Settings` 骨架上加角色感知，不引入新的状态管理。

**Tech Stack:** Node.js `>=22.13.0 <23`、Express、better-sqlite3、React 18 + Vite、react-i18next、Vitest（UI：`npm --prefix ui test -- <path>`；引擎：`PILOTDECK_SKIP_BOOTSTRAP=1 npm run build` 后 `node --test dist/tests/...`）。

**Spec:** `docs/superpowers/specs/2026-10-14-multi-user-design.md` §8–§11、§9.4、§10.5，以及计划一执行记录中「交给计划二」的事项（计划一文档末尾）。

## Global Constraints

- 迁移只搬不删：丢弃项也先进入 `archives/legacy-<timestamp>/` 快照；任一步失败立即退出进程，不监听端口（spec §9.2）。
- 迁移触发条件：根目录存在旧布局目录且 `system/migration/legacy-done.json` 不存在。目标 `users/<adminId>/` 可能已存在（计划一会创建空骨架），迁移必须**合并**而不是假设为空。
- 表外未知条目一律归档到 `system/migration/history/`，不丢弃也不搬入用户目录（spec §9.4）。
- 身份只来自后端认证；缺少作用域直接 500，不回退（spec §6.1）。
- 管理员门禁只看 `req.user.role === 'admin'`；免登录模式下 `req.user` 已是 admin，天然通过（spec §10.3）。
- 普通用户设置页保留：账号密码、主题 / 语言 / 排序 / 输入偏好、本人记忆开关与查看 / 删除 / 导入导出。模型池、路由、密钥、MCP、插件、IM、更新、Index/Dream 模型与维护策略全部管理员（spec D10、§10.3）。
- 配置 GET、解析失败时的 raw YAML、插件管理、Shell WebSocket、目录浏览同样做后端授权，不能只藏菜单（spec §10.3）。
- CLI / TUI 只在免登录模式可用，落到 admin 目录；外部 API key 按 `user_id` 归属（已完成）；IM 与 always-on 在多用户模式禁用（spec D12）。
- 清理策略默认值：日志单文件 20 MB 保留 5 份；`.tmp/chat-attachments` 7 天；`archives/projects` 30 天；`router` 事件写入默认关闭（spec §10.5）。
- 本地存储键按 `userId` 命名空间，退出时清空缓存并关闭 WebSocket（spec §11）。
- 所有测试使用 `mkdtemp` 临时根与临时账号库，不触碰 `.pilotdeck-home`；不启动真实模型。手工验证用隔离端口（UI 3151、Gateway 基值 19200）与 `/tmp/pd-plan2*`，不动用户正在运行的 3020 / 5170 / 18800。
- 提交信息末尾加 harness 给出的 attribution trailer。

## Review Focus

1. **旧目录里 `projects/<root 路径派生名>/` 这种「无项目对话」容器**：目录名由 `PILOT_HOME` 路径派生，搬家后引擎会算出新名字。期望：迁移把它改名为新 home 派生的名字，而不是丢弃或留成孤儿。测试在 Task 1。
2. **迁移中途断电**：快照已建、部分目录已搬、标记未写。期望：重启再次进入迁移，已搬的条目跳过，剩余条目继续，最终写标记；不会把已搬到 `users/1/` 的目录再归档一次。测试在 Task 1。
3. **普通用户在设置页里直接请求 `/api/config`**：期望 403 `ADMIN_REQUIRED`，且前端不会因为 403 把整个设置页渲染成报错。测试在 Task 5 与 Task 8。
4. **令牌被撤销时前端正在聊天**：期望 WebSocket 收到 4401 后不再重连，页面回到登录页，本地缓存已清。测试在 Task 7。
5. **管理员把自己降级**：后端已保护最后一个管理员；若还有第二个管理员，操作成功后本人令牌失效。期望前端在收到 401 后退出到登录页，而不是卡在管理页。测试在 Task 9。

---

## 文件结构

| 文件 | 职责 | 任务 |
|---|---|---|
| `ui/server/services/legacyMigration.js`（新） | 旧布局检测、快照、逐项搬入/归档/丢弃、标记、幂等续跑 | 1 |
| `ui/server/services/server-startup.js`、`ui/server/index.js` | 启动序列插入迁移（admin 引导之后、监听之前） | 1 |
| `scripts/migrate-user-storage.mjs`（新） | 操作者命令：`--dry-run`、`--assign-admin` | 2 |
| `scripts/lib-local-runtime.sh`、`scripts/bootstrap-pilotdeck-config.mjs`、`scripts/offline-runtime.sh`、`docker-entrypoint.sh`、`Dockerfile` | 不再预创建旧根骨架 | 2 |
| `src/cli/createLocalGateway.ts` | `router/` 目录与事件写入改为 `PILOTDECK_ROUTER_DEBUG=1` 才开启 | 2 |
| `src/cli/homeGuard.ts`（新）、`src/cli/pilotdeck.ts` | CLI/TUI 给到系统根时自动落到 admin 目录 | 3 |
| `ui/server/services/gatewayPool.js`、`ui/server/services/adminBootstrap.js` | 免登录模式下保留 always-on；写 `system/admin-home` | 3 |
| `src/pilot/retention.ts`（新）、`src/cli/pilotdeck.ts`、`src/pilot/config/parseMultiUserConfig.ts`（新） | 日志滚动、附件/归档清理 | 4 |
| `ui/server/index.js`、`ui/server/routes/{config,memory,user,plugins}.js`、`ui/server/services/wsScope.js`、`ui/server/routes/adminUsers.js` | 管理员门禁、脱敏修补、广播按角色、Shell 仅管理员、Git 配置按用户、DELETE 用户与存储用量 | 5 |
| `ui/server/services/pilotdeckConfig.js`、`ui/server/services/gatewayPool.js`、`ui/server/index.js` | 旧库路径配置告警、熔断按持续健康重置、shell/plugin socket 纳入撤销 | 6 |
| `ui/src/components/auth/**`、`ui/src/utils/api.js`、`ui/src/contexts/WebSocketContext.tsx`、`ui/src/components/chat/utils/chatStorage.ts` | 角色、注册、401/4401 处理、本地存储命名空间 | 7 |
| `ui/src/components/app-shell/SidebarV2.tsx`、`ui/src/components/settings/**` | 账号区、改密码、角色化菜单 | 8 |
| `ui/src/components/settings/view/users/**`（新） | 用户管理页 | 9 |
| `ui/server/multiUser.isolation.test.js`、`ui/server/adminGating.test.js`（新） | 门禁矩阵与迁移回归 | 10 |

---

### Task 1: 旧数据自动迁移服务

**Files:**
- Create: `ui/server/services/legacyMigration.js`
- Modify: `ui/server/services/server-startup.js`（新增 `migrateLegacyStorageFn` 槽位，顺序：initializeDatabase → ensureAdminUser → migrateLegacyStorage → configureWebPush）
- Modify: `ui/server/index.js`（`startServer()` 传入 `migrateLegacyStorageFn: () => migrateLegacyStorage({ userDb, log })`；catch 中 `error.code === 'LEGACY_MIGRATION_FAILED'` 打印并 `process.exit(1)`）
- Test: `ui/server/services/legacyMigration.test.js`

**Interfaces:**
- Consumes: `userDb.getAdminUser()`（计划一）、`ensureUserHomeSkeleton(userId, env)`、`resolvePilotRoot(env)`、`resolveUserHome(userId, env)`（`ui/server/utils/pilotPaths.js`）、`sessionNamesDb.setName(userId, sessionId, provider, name)`、`db`（计划一）
- Produces:

```js
export const LEGACY_DONE_MARKER = 'system/migration/legacy-done.json';
export function detectLegacyLayout(root) → { present: boolean, entries: string[] }   // entries = 根目录下匹配处理表的条目名
export function planLegacyMigration({ root, adminId, env }) → Array<{ name, action: 'move'|'archive'|'drop'|'keep', from, to?, reason }>
export async function migrateLegacyStorage({ userDb, env = process.env, log = console.log, now = () => new Date() })
  → { skipped: true, reason } | { skipped: false, snapshotDir, applied: Array<{name, action, from, to}> }
  // 失败：throw Error with code 'LEGACY_MIGRATION_FAILED'
```

处理规则（来自 spec §9.4，目标 `<home> = users/<adminId>`）：

| 根目录条目 | 动作 |
|---|---|
| `projects/`、`workspaces/`、`memory/`、`skills/`、`archives/`、`logs/`、`.pilotdeck/`、`.tmp/`、`.legacy-bundled-skills-migrated-v1` | `move` 到 `<home>/<同名>`；若目标已存在：目录则**逐子项合并**（子项不存在才移动，存在则把旧子项归档到 `system/migration/history/conflicts/<name>/<子项>`），文件则保留目标、旧文件归档 |
| `projects/<createProjectId(root)>/` | `move` 并改名为 `<home>/projects/<createProjectId(home)>/`（Review Focus 1） |
| `workspaces/general/` | 空则 `drop`；非空则 `move` 到 `<home>/workspaces/general/` |
| `auth.db`（含 `-wal`/`-shm`） | `archive` 到 `system/migration/history/legacy-auth.db`；迁移前把其中 `session_names` 行写入新库（`sessionNamesDb.setName(adminId, …)`，已存在则跳过） |
| `server-token` | `drop` |
| `router/`、`telemetry/`、`cron/` | `drop` |
| `migration-backups/`、`migration-reports/`、`.workspace-migration-v1.json` | `archive` 到 `system/migration/history/` |
| `pilotdeck.yaml`、`pilotdeck.yaml.bak-*`、`plugins/`、`system/`、`users/` | `keep` |
| 其他未知条目 | `archive` 到 `system/migration/history/unknown/` |

快照：执行前把所有 `move`/`archive`/`drop` 条目硬链接复制到 `archives/legacy-<ISO 时间戳>/`（`fs.cp` with `mode: fs.constants.COPYFILE_FICLONE`，失败回退 `link`，再失败回退普通复制）。标记内容 `{ at, adminId, snapshotDir, applied }`。

幂等（Review Focus 2）：`plan` 阶段对每个条目检查 `from` 是否仍存在；不存在则记为 `{ action: 'skip', reason: 'already-migrated' }`。标记只在全部完成后写。

- [ ] **Step 1: 写失败测试**

```js
// ui/server/services/legacyMigration.test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProjectId } from '../utils/pilotPaths.js';

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-mig-'));
  vi.stubEnv('PILOT_HOME', root); vi.stubEnv('DATABASE_PATH', '');
  vi.resetModules();
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

function seedLegacyRoot() {
  const w = (p, c = 'x') => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), c); };
  w('projects/general_med/general_med-aaa/meta.json', '{"type":"general_medicine"}');
  w('projects/trauma_med/trauma_med-bbb/meta.json', '{"type":"war_trauma"}');
  w(`projects/${createProjectId(root)}/chats/web:s_1.jsonl`, '{}');
  w('workspaces/general_med/general_med-aaa/inbox/a.txt');
  fs.mkdirSync(path.join(root, 'workspaces/general'), { recursive: true });
  w('memory/global/UserIdentity/profile.md', '# me');
  w('skills/my-skill/SKILL.md', '---\nname: my-skill\n---');
  w('logs/trauma-agent.jsonl', '{}');
  w('.pilotdeck/tool-results/t1.json', '{}');
  w('router/events.jsonl'); w('telemetry/queue.jsonl'); fs.mkdirSync(path.join(root, 'cron'));
  w('migration-reports/r.json', '{}'); w('.workspace-migration-v1.json', '{}');
  w('server-token', 'tok'); w('pilotdeck.yaml', 'schemaVersion: 1\n'); w('pilotdeck.yaml.bak-1', '');
  w('mystery/thing.txt');
  const legacy = new Database(path.join(root, 'auth.db'));
  legacy.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT, is_active BOOLEAN DEFAULT 1);
    CREATE TABLE session_names (id INTEGER PRIMARY KEY, session_id TEXT, provider TEXT, custom_name TEXT, created_at DATETIME, updated_at DATETIME, UNIQUE(session_id, provider));
    INSERT INTO users (username, password_hash) VALUES ('local', 'h');
    INSERT INTO session_names (session_id, provider, custom_name) VALUES ('web:s_1', 'pilotdeck', '旧名字');`);
  legacy.close();
}

async function boot() {
  const db = await import('../database/db.js'); await db.initializeDatabase();
  const { ensureAdminUser } = await import('./adminBootstrap.js');
  await ensureAdminUser({ userDb: db.userDb, log: () => {} });
  const { migrateLegacyStorage } = await import('./legacyMigration.js');
  return { db, migrateLegacyStorage, admin: db.userDb.getAdminUser() };
}

describe('legacy migration', () => {
  it('moves user data into the admin home, archives history, drops noise, keeps system files', async () => {
    seedLegacyRoot();
    const { db, migrateLegacyStorage, admin } = await boot();
    const result = await migrateLegacyStorage({ userDb: db.userDb, log: () => {} });
    expect(result.skipped).toBe(false);
    const home = path.join(root, 'users', String(admin.id));
    expect(fs.existsSync(path.join(home, 'projects/general_med/general_med-aaa/meta.json'))).toBe(true);
    expect(fs.existsSync(path.join(home, 'workspaces/general_med/general_med-aaa/inbox/a.txt'))).toBe(true);
    expect(fs.existsSync(path.join(home, 'memory/global/UserIdentity/profile.md'))).toBe(true);
    expect(fs.existsSync(path.join(home, 'skills/my-skill/SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(home, 'logs/trauma-agent.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.pilotdeck/tool-results/t1.json'))).toBe(true);
    // general container renamed to the new home-derived id (Review Focus 1)
    expect(fs.existsSync(path.join(home, 'projects', createProjectId(home), 'chats/web:s_1.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'projects'))).toBe(false);
    for (const gone of ['router', 'telemetry', 'cron', 'server-token', 'workspaces', 'memory', 'skills', 'logs', 'auth.db']) {
      expect(fs.existsSync(path.join(root, gone))).toBe(false);
    }
    expect(fs.existsSync(path.join(root, 'system/migration/history/legacy-auth.db'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'system/migration/history/migration-reports/r.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'system/migration/history/unknown/mystery/thing.txt'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'pilotdeck.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'pilotdeck.yaml.bak-1'))).toBe(true);
    const snapshot = fs.readdirSync(path.join(root, 'archives')).find((n) => n.startsWith('legacy-'));
    expect(fs.existsSync(path.join(root, 'archives', snapshot, 'router/events.jsonl'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'system/migration/legacy-done.json'), 'utf8')).adminId).toBe(admin.id);
    expect(db.sessionNamesDb.getName(admin.id, 'web:s_1', 'pilotdeck')).toBe('旧名字');
  });

  it('merges into an existing admin home and archives conflicting children', async () => {
    seedLegacyRoot();
    const { db, migrateLegacyStorage, admin } = await boot();
    const home = path.join(root, 'users', String(admin.id));
    fs.mkdirSync(path.join(home, 'projects/general_med/general_med-aaa'), { recursive: true });
    fs.writeFileSync(path.join(home, 'projects/general_med/general_med-aaa/meta.json'), 'NEW');
    await migrateLegacyStorage({ userDb: db.userDb, log: () => {} });
    expect(fs.readFileSync(path.join(home, 'projects/general_med/general_med-aaa/meta.json'), 'utf8')).toBe('NEW');
    expect(fs.existsSync(path.join(root, 'system/migration/history/conflicts/projects/general_med/general_med-aaa/meta.json'))).toBe(true);
    expect(fs.existsSync(path.join(home, 'projects/trauma_med/trauma_med-bbb/meta.json'))).toBe(true);
  });

  it('is idempotent and resumable after a partial run (Review Focus 2)', async () => {
    seedLegacyRoot();
    const { db, migrateLegacyStorage, admin } = await boot();
    const home = path.join(root, 'users', String(admin.id));
    // simulate a crash: projects already moved, no marker
    fs.mkdirSync(path.join(home, 'projects'), { recursive: true });
    fs.renameSync(path.join(root, 'projects/general_med'), path.join(home, 'projects/general_med'));
    const first = await migrateLegacyStorage({ userDb: db.userDb, log: () => {} });
    expect(first.skipped).toBe(false);
    expect(fs.existsSync(path.join(home, 'projects/general_med/general_med-aaa/meta.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'system/migration/history/conflicts/projects/general_med'))).toBe(false);
    const second = await migrateLegacyStorage({ userDb: db.userDb, log: () => {} });
    expect(second).toMatchObject({ skipped: true, reason: 'marker-present' });
  });

  it('does nothing on a fresh root', async () => {
    const { db, migrateLegacyStorage } = await boot();
    expect(await migrateLegacyStorage({ userDb: db.userDb, log: () => {} })).toMatchObject({ skipped: true, reason: 'no-legacy-layout' });
  });

  it('fails closed: a move error leaves no marker and throws LEGACY_MIGRATION_FAILED', async () => {
    seedLegacyRoot();
    const { db, migrateLegacyStorage } = await boot();
    const realRename = fs.promises.rename;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (a, b) => { if (String(a).endsWith('/memory')) throw new Error('EIO'); return realRename(a, b); });
    await expect(migrateLegacyStorage({ userDb: db.userDb, log: () => {} })).rejects.toMatchObject({ code: 'LEGACY_MIGRATION_FAILED' });
    expect(fs.existsSync(path.join(root, 'system/migration/legacy-done.json'))).toBe(false);
    expect(fs.readdirSync(path.join(root, 'archives')).some((n) => n.startsWith('legacy-'))).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm --prefix ui test -- server/services/legacyMigration.test.js`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现 `legacyMigration.js`**

```js
// ui/server/services/legacyMigration.js
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createProjectId, ensureUserHomeSkeleton, resolvePilotRoot, resolveUserHome } from '../utils/pilotPaths.js';
import { sessionNamesDb } from '../database/db.js';

export const LEGACY_DONE_MARKER = path.join('system', 'migration', 'legacy-done.json');
const HISTORY_DIR = path.join('system', 'migration', 'history');

const MOVE_ENTRIES = ['projects', 'workspaces', 'memory', 'skills', 'archives', 'logs', '.pilotdeck', '.tmp', '.legacy-bundled-skills-migrated-v1'];
const DROP_ENTRIES = ['router', 'telemetry', 'cron', 'server-token'];
const ARCHIVE_ENTRIES = ['migration-backups', 'migration-reports', '.workspace-migration-v1.json'];
const KEEP_ENTRIES = ['pilotdeck.yaml', 'plugins', 'system', 'users'];
const isKept = (name) => KEEP_ENTRIES.includes(name) || name.startsWith('pilotdeck.yaml.bak');
const isAuthDb = (name) => name === 'auth.db' || name === 'auth.db-wal' || name === 'auth.db-shm';

function fail(message, cause) {
  const error = new Error(`Legacy storage migration failed: ${message}`);
  error.code = 'LEGACY_MIGRATION_FAILED';
  if (cause) error.cause = cause;
  return error;
}

export function detectLegacyLayout(root) {
  if (!fs.existsSync(root)) return { present: false, entries: [] };
  const entries = fs.readdirSync(root).filter((name) => !isKept(name));
  const dataDirs = entries.filter((n) => MOVE_ENTRIES.includes(n) && fs.statSync(path.join(root, n)).isDirectory() && fs.readdirSync(path.join(root, n)).length > 0);
  return { present: dataDirs.length > 0 || entries.some(isAuthDb), entries };
}

export function planLegacyMigration({ root, adminId, env = process.env }) {
  const home = resolveUserHome(adminId, env);
  const history = path.join(root, HISTORY_DIR);
  const plan = [];
  for (const name of fs.readdirSync(root)) {
    const from = path.join(root, name);
    if (isKept(name)) { plan.push({ name, action: 'keep', from, reason: 'system file' }); continue; }
    if (isAuthDb(name)) { plan.push({ name, action: 'archive', from, to: path.join(history, name === 'auth.db' ? 'legacy-auth.db' : `legacy-${name}`), reason: 'legacy account db' }); continue; }
    if (DROP_ENTRIES.includes(name)) { plan.push({ name, action: 'drop', from, reason: 'regenerated or diagnostic' }); continue; }
    if (ARCHIVE_ENTRIES.includes(name)) { plan.push({ name, action: 'archive', from, to: path.join(history, name), reason: 'historic migration artifact' }); continue; }
    if (name === 'workspaces' && fs.existsSync(path.join(from, 'general')) && fs.readdirSync(path.join(from, 'general')).length === 0) {
      plan.push({ name: 'workspaces/general', action: 'drop', from: path.join(from, 'general'), reason: 'empty legacy general workspace' });
    }
    if (MOVE_ENTRIES.includes(name)) { plan.push({ name, action: 'move', from, to: path.join(home, name), reason: 'user data' }); continue; }
    plan.push({ name, action: 'archive', from, to: path.join(history, 'unknown', name), reason: 'unknown entry' });
  }
  const legacyGeneral = path.join(root, 'projects', createProjectId(root));
  if (fs.existsSync(legacyGeneral)) {
    plan.push({ name: `projects/${createProjectId(root)}`, action: 'move', from: legacyGeneral, to: path.join(home, 'projects', createProjectId(home)), reason: 'general container renamed for new home' });
  }
  // the renamed general container must run before the bulk projects/ move
  return plan.sort((a, b) => (a.name.startsWith('projects/') ? -1 : 0) - (b.name.startsWith('projects/') ? -1 : 0));
}

async function snapshot(root, plan, stamp) {
  const dir = path.join(root, 'archives', `legacy-${stamp}`);
  await fsp.mkdir(dir, { recursive: true });
  for (const step of plan) {
    if (step.action === 'keep' || !fs.existsSync(step.from)) continue;
    const dest = path.join(dir, path.relative(root, step.from));
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    try {
      await fsp.cp(step.from, dest, { recursive: true, mode: fs.constants.COPYFILE_FICLONE, errorOnExist: false, force: false });
    } catch (error) {
      throw fail(`snapshot of ${step.name}`, error);
    }
  }
  return dir;
}

async function moveMerging(from, to, conflictDir) {
  if (!fs.existsSync(to)) { await fsp.mkdir(path.dirname(to), { recursive: true }); await fsp.rename(from, to); return; }
  const fromStat = await fsp.stat(from);
  if (!fromStat.isDirectory()) { await fsp.mkdir(path.dirname(conflictDir), { recursive: true }); await fsp.rename(from, conflictDir); return; }
  for (const child of await fsp.readdir(from)) {
    await moveMerging(path.join(from, child), path.join(to, child), path.join(conflictDir, child));
  }
  await fsp.rmdir(from).catch(() => {});
}

function importLegacySessionNames(legacyDbPath, adminId) {
  const legacy = new Database(legacyDbPath, { readonly: true });
  try {
    const hasTable = legacy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_names'").get();
    if (!hasTable) return 0;
    let count = 0;
    for (const row of legacy.prepare('SELECT session_id, provider, custom_name FROM session_names').all()) {
      if (sessionNamesDb.getName(adminId, row.session_id, row.provider)) continue;
      sessionNamesDb.setName(adminId, row.session_id, row.provider, row.custom_name);
      count += 1;
    }
    return count;
  } finally {
    legacy.close();
  }
}

export async function migrateLegacyStorage({ userDb, env = process.env, log = console.log, now = () => new Date() }) {
  const root = resolvePilotRoot(env);
  if (fs.existsSync(path.join(root, LEGACY_DONE_MARKER))) return { skipped: true, reason: 'marker-present' };
  const detected = detectLegacyLayout(root);
  if (!detected.present) return { skipped: true, reason: 'no-legacy-layout' };
  const admin = userDb.getAdminUser();
  if (!admin) throw fail('no active administrator to own the legacy data');

  ensureUserHomeSkeleton(admin.id, env);
  const plan = planLegacyMigration({ root, adminId: admin.id, env });
  const stamp = now().toISOString().replace(/[:.]/g, '-');
  const snapshotDir = await snapshot(root, plan, stamp);
  log(`[migration] legacy layout detected; snapshot at ${snapshotDir}`);

  const legacyDb = path.join(root, 'auth.db');
  if (fs.existsSync(legacyDb)) {
    try { log(`[migration] imported ${importLegacySessionNames(legacyDb, admin.id)} session name(s) from legacy auth.db`); }
    catch (error) { throw fail('reading legacy auth.db', error); }
  }

  const applied = [];
  for (const step of plan) {
    if (step.action === 'keep') continue;
    if (!fs.existsSync(step.from)) { applied.push({ ...step, action: 'skip', reason: 'already-migrated' }); continue; }
    try {
      if (step.action === 'move') {
        await moveMerging(step.from, step.to, path.join(root, HISTORY_DIR, 'conflicts', path.relative(root, step.from)));
      } else if (step.action === 'archive') {
        await fsp.mkdir(path.dirname(step.to), { recursive: true });
        await fsp.rename(step.from, step.to);
      } else if (step.action === 'drop') {
        await fsp.rm(step.from, { recursive: true, force: true });
      }
      applied.push({ name: step.name, action: step.action, from: step.from, to: step.to ?? null });
      log(`[migration] ${step.action.padEnd(7)} ${step.name}`);
    } catch (error) {
      throw fail(`${step.action} ${step.name}`, error);
    }
  }
  await fsp.mkdir(path.dirname(path.join(root, LEGACY_DONE_MARKER)), { recursive: true });
  await fsp.writeFile(path.join(root, LEGACY_DONE_MARKER), JSON.stringify({ at: now().toISOString(), adminId: admin.id, snapshotDir, applied }, null, 2));
  log(`[migration] done; ${applied.length} step(s), marker written`);
  return { skipped: false, snapshotDir, applied };
}
```

`moveMerging` 对目录逐子项递归，所以 `projects/general_med/general_med-aaa` 这一层在目标已存在时，旧的 `meta.json` 单个文件被归档到 `conflicts/…`，而 `trauma_med` 子树因目标不存在被整体 `rename`。排序保证改名的 general 容器先于 `projects/` 整体搬迁执行。

- [ ] **Step 4: 接入启动序列**

`server-startup.js`：参数增加 `migrateLegacyStorageFn`（必填，TypeError 守卫同其他），在 `ensureAdminUserFn()` 之后 `await migrateLegacyStorageFn()`。`index.js` `startServer()`：

```js
import { migrateLegacyStorage } from './services/legacyMigration.js';
// ...
migrateLegacyStorageFn: () => migrateLegacyStorage({ userDb, log: (m) => console.log(`${c.info('[INFO]')} ${m}`) }),
```

catch 分支：`if (error.code === 'LEGACY_MIGRATION_FAILED') { console.error(c.warn('[ERROR]'), error.message, error.cause?.message ?? ''); process.exit(1); }`。

- [ ] **Step 5: 运行测试**

Run: `npm --prefix ui test -- server/services/legacyMigration.test.js server/services/adminBootstrap.test.js`
Expected: PASS（5 + 既有）

- [ ] **Step 6: 提交**

```bash
git add ui/server/services/legacyMigration.js ui/server/services/legacyMigration.test.js ui/server/services/server-startup.js ui/server/index.js
git commit -m "feat(multi-user): 启动时把旧布局迁移到管理员目录（快照、合并、幂等、失败即停）"
```

---

### Task 2: 操作者命令与旧根骨架清理

**Files:**
- Create: `scripts/migrate-user-storage.mjs`
- Modify: `scripts/lib-local-runtime.sh:102-115`、`scripts/bootstrap-pilotdeck-config.mjs:180-197`、`scripts/offline-runtime.sh:93-102`、`docker-entrypoint.sh:7-12`、`Dockerfile:72-77`
- Modify: `src/cli/createLocalGateway.ts:1062-1071`（router 目录）
- Test: `scripts/migrate-user-storage.test.mjs`（node:test）、`tests/cli/router-event-bus.spec.ts`

**Interfaces:**
- Consumes: `migrateLegacyStorage`、`planLegacyMigration`、`detectLegacyLayout`（Task 1）；`userDb`、`initializeDatabase`（`ui/server/database/db.js`）
- Produces: `node scripts/migrate-user-storage.mjs [--pilot-home <dir>] [--dry-run] [--assign-admin <username>]`，输出 JSON 报告；退出码 0 成功 / 1 失败 / 2 无事可做
- Produces: 引擎 `buildRouterEventBus` 仅在 `env.PILOTDECK_ROUTER_DEBUG === '1'` 时创建 `router/` 并写 `events.jsonl`，否则事件总线为空实现

- [ ] **Step 1: 写失败测试（脚本）**

```js
// scripts/migrate-user-storage.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = new URL('./migrate-user-storage.mjs', import.meta.url).pathname;
const run = (args, env = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, PILOTDECK_DISABLE_LOCAL_AUTH: '0', PILOTDECK_ADMIN_PASSWORD: 'x', ...env } });

test('dry-run prints the plan and changes nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'pd-cli-'));
  mkdirSync(join(root, 'projects/general_med/p1'), { recursive: true }); writeFileSync(join(root, 'projects/general_med/p1/meta.json'), '{}');
  const r = run(['--pilot-home', root, '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.dryRun, true);
  assert.ok(report.plan.some((s) => s.name === 'projects' && s.action === 'move'));
  assert.ok(existsSync(join(root, 'projects/general_med/p1/meta.json')));
  assert.ok(!existsSync(join(root, 'system/migration/legacy-done.json')));
  rmSync(root, { recursive: true, force: true });
});

test('apply migrates and a second run exits 2 (nothing to do)', () => {
  const root = mkdtempSync(join(tmpdir(), 'pd-cli-'));
  mkdirSync(join(root, 'memory/global'), { recursive: true }); writeFileSync(join(root, 'memory/global/a.md'), 'x');
  assert.equal(run(['--pilot-home', root]).status, 0);
  assert.ok(existsSync(join(root, 'users/1/memory/global/a.md')));
  assert.equal(run(['--pilot-home', root]).status, 2);
  rmSync(root, { recursive: true, force: true });
});

test('--assign-admin promotes an existing account when no admin exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'pd-cli-'));
  // seed a system db with a non-admin user only
  const seed = run(['--pilot-home', root, '--seed-user-for-test', 'doc1']);
  assert.equal(seed.status, 0, seed.stderr);
  const r = run(['--pilot-home', root, '--assign-admin', 'doc1', '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /"promoted":\s*"doc1"/);
  rmSync(root, { recursive: true, force: true });
});
```

`--seed-user-for-test` 是脚本的隐藏测试开关（仅在 `NODE_ENV=test` 或显式传参时启用），创建一个 `role='user'` 账号并把 `admin` 账号停用，用来复现「有用户但无管理员」。

- [ ] **Step 2: 运行确认失败**

Run: `node --test scripts/migrate-user-storage.test.mjs`
Expected: FAIL，脚本不存在

- [ ] **Step 3: 实现脚本**

```js
#!/usr/bin/env node
// scripts/migrate-user-storage.mjs
import path from 'node:path';
import os from 'node:os';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  'pilot-home': { type: 'string' }, 'dry-run': { type: 'boolean', default: false },
  'assign-admin': { type: 'string' }, 'seed-user-for-test': { type: 'string' },
} });
const pilotHome = path.resolve((values['pilot-home'] ?? process.env.PILOT_HOME ?? path.join(os.homedir(), '.pilotdeck')).replace(/^~(?=$|\/)/, os.homedir()));
process.env.PILOT_HOME = pilotHome;
process.env.DATABASE_PATH = '';

const { initializeDatabase, userDb } = await import('../ui/server/database/db.js');
const { ensureAdminUser } = await import('../ui/server/services/adminBootstrap.js');
const { migrateLegacyStorage, planLegacyMigration, detectLegacyLayout } = await import('../ui/server/services/legacyMigration.js');
const { resolvePilotRoot } = await import('../ui/server/utils/pilotPaths.js');

const report = { pilotHome, dryRun: values['dry-run'] };
try {
  await initializeDatabase();
  if (values['seed-user-for-test']) {
    const bcrypt = (await import('bcrypt')).default;
    await ensureAdminUser({ userDb, log: () => {} });
    const u = userDb.createUser(values['seed-user-for-test'], await bcrypt.hash('x', 4), 'user');
    userDb.setActive(userDb.getAdminUser().id, false);
    report.seeded = u.username;
    console.log(JSON.stringify(report, null, 2)); process.exit(0);
  }
  if (values['assign-admin']) {
    const target = userDb.getUserByUsername(values['assign-admin']);
    if (!target) throw Object.assign(new Error(`no such user: ${values['assign-admin']}`), { exitCode: 1 });
    if (!values['dry-run']) { userDb.setRole(target.id, 'admin'); userDb.setActive(target.id, true); userDb.bumpTokenVersion(target.id); }
    report.promoted = target.username;
  }
  if (!userDb.getAdminUser() && !values['assign-admin']) {
    throw Object.assign(new Error('no active administrator; pass --assign-admin <username>'), { exitCode: 1 });
  }
  const root = resolvePilotRoot(process.env);
  const detected = detectLegacyLayout(root);
  if (!detected.present) { report.result = 'nothing-to-do'; console.log(JSON.stringify(report, null, 2)); process.exit(2); }
  const adminId = userDb.getAdminUser()?.id ?? userDb.getUserByUsername(values['assign-admin']).id;
  report.plan = planLegacyMigration({ root, adminId }).map(({ name, action, to, reason }) => ({ name, action, to: to ?? null, reason }));
  if (values['dry-run']) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }
  const result = await migrateLegacyStorage({ userDb, log: (m) => console.error(m) });
  report.result = result;
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
} catch (error) {
  report.error = error.message;
  console.log(JSON.stringify(report, null, 2));
  process.exit(error.exitCode ?? 1);
}
```

- [ ] **Step 4: 停止预创建旧根骨架**

- `scripts/lib-local-runtime.sh` `ensure_project_pilot_home`：只保留 `mkdir -p "$PILOT_HOME_DIR/plugins" "$PILOT_HOME_DIR/system"` 与 med-tools 符号链接；删除 `skills projects memory cron logs workspaces/general/...` 的 mkdir。
- `scripts/bootstrap-pilotdeck-config.mjs:180-197`：同样只保留 `plugins`、`system`。
- `scripts/offline-runtime.sh:93-102`、`docker-entrypoint.sh:7-12`、`Dockerfile:72-77`：改为 `plugins system`。`docker-entrypoint.sh:162` 的 `rm -f "$PILOT_HOME/server-token"` 删除（已无意义）。

- [ ] **Step 5: router 目录改为调试开关**

```ts
// src/cli/createLocalGateway.ts — buildRouterEventBus
if (env.PILOTDECK_ROUTER_DEBUG !== "1") {
  return { emit: () => {}, close: () => {} };   // 与现有接口形状一致，按实际类型补齐
}
```

把 `mkdirSync(routerDir)` 与 legacy rename 移到该 guard 之后。测试 `tests/cli/router-event-bus.spec.ts`：用临时 `PILOT_HOME`，未设开关时启动后不存在 `router/`；设 `PILOTDECK_ROUTER_DEBUG=1` 时存在。若 `buildRouterEventBus` 不便直接导出，导出一个 `shouldWriteRouterEvents(env)` 谓词并测试它，再在构造处使用。

- [ ] **Step 6: 验证**

Run: `node --test scripts/migrate-user-storage.test.mjs`；`bash -n scripts/lib-local-runtime.sh scripts/offline-runtime.sh docker-entrypoint.sh`；`PILOTDECK_SKIP_BOOTSTRAP=1 npm run build && node --test --test-force-exit dist/tests/cli/router-event-bus.spec.js`
Expected: 全部 PASS

- [ ] **Step 7: 提交**

```bash
git add scripts/migrate-user-storage.mjs scripts/migrate-user-storage.test.mjs scripts/lib-local-runtime.sh scripts/bootstrap-pilotdeck-config.mjs scripts/offline-runtime.sh docker-entrypoint.sh Dockerfile src/cli/createLocalGateway.ts tests/cli/router-event-bus.spec.ts
git commit -m "feat(multi-user): 迁移操作者命令；启动脚本不再预建旧根骨架；router 事件改为调试开关"
```

---

### Task 3: 免登录模式与命令行入口落到 admin 目录

**Files:**
- Create: `src/cli/homeGuard.ts`
- Modify: `src/cli/pilotdeck.ts:28-33`（`main()` 入口）
- Modify: `ui/server/services/adminBootstrap.js`（写 `system/admin-home`）
- Modify: `ui/server/services/gatewayPool.js:~86-93`（`PILOTDECK_DISABLE_ALWAYS_ON` 只在多用户模式下设置）
- Modify: `scripts/config.env`（注释说明 CLI 行为）
- Test: `tests/cli/homeGuard.spec.ts`、`ui/server/services/gatewayPool.test.js`（新增用例）、`ui/server/services/adminBootstrap.test.js`（新增用例）

**Interfaces:**
- Produces（引擎）:

```ts
// src/cli/homeGuard.ts
export type HomeGuardResult =
  | { kind: "user-home"; pilotHome: string }
  | { kind: "redirected"; pilotHome: string; configPath: string; from: string }
  | { kind: "system-root-without-admin"; pilotHome: string };
/** 若 PILOT_HOME 是系统根（存在 system/auth.db），读取 system/admin-home 并改用该目录；同时把 PILOTDECK_CONFIG_PATH 指向根 yaml。 */
export function resolveCliHome(env: NodeJS.ProcessEnv): HomeGuardResult;
export function applyCliHome(env: NodeJS.ProcessEnv, log: (m: string) => void): void; // 修改 env.PILOT_HOME / env.PILOTDECK_CONFIG_PATH 并打印一行
```

- Produces（UI 服务器）: `ensureAdminUser()` 成功后写 `<root>/system/admin-home`，内容为 admin 用户目录的绝对路径（每次启动覆盖，保证 adminId 变化后仍正确）。
- Produces（池）: `defaultSpawnGateway` 的子进程 env 中 `PILOTDECK_DISABLE_ALWAYS_ON: '1'` 仅当 `options.multiUser === true`；`createGatewayPool` 新增选项 `multiUser`（默认 `!DISABLE_LOCAL_AUTH`，由 bridge 传入）。免登录模式下 admin 的 Gateway 保留 always-on / cron / IM（恢复计划一之前的单机行为）。

- [ ] **Step 1: 写失败测试（引擎）**

```ts
// tests/cli/homeGuard.spec.ts
// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveCliHome, applyCliHome } from "../../src/cli/homeGuard.js";

function systemRoot(withAdminHome = true) {
  const root = mkdtempSync(join(tmpdir(), "pd-guard-"));
  mkdirSync(join(root, "system"), { recursive: true });
  writeFileSync(join(root, "system", "auth.db"), "");
  writeFileSync(join(root, "pilotdeck.yaml"), "schemaVersion: 1\n");
  if (withAdminHome) {
    mkdirSync(join(root, "users", "1"), { recursive: true });
    writeFileSync(join(root, "system", "admin-home"), join(root, "users", "1") + "\n");
  }
  return root;
}

test("a plain user home is left alone", () => {
  const home = mkdtempSync(join(tmpdir(), "pd-guard-user-"));
  assert.deepEqual(resolveCliHome({ PILOT_HOME: home }), { kind: "user-home", pilotHome: home });
  rmSync(home, { recursive: true, force: true });
});

test("a system root redirects to the admin home and the root config", () => {
  const root = systemRoot();
  const r = resolveCliHome({ PILOT_HOME: root });
  assert.equal(r.kind, "redirected");
  assert.equal(r.pilotHome, join(root, "users", "1"));
  assert.equal(r.configPath, join(root, "pilotdeck.yaml"));
  const env = { PILOT_HOME: root };
  const lines = [];
  applyCliHome(env, (m) => lines.push(m));
  assert.equal(env.PILOT_HOME, join(root, "users", "1"));
  assert.equal(env.PILOTDECK_CONFIG_PATH, join(root, "pilotdeck.yaml"));
  assert.match(lines[0], /users\/1/);
  rmSync(root, { recursive: true, force: true });
});

test("an explicit PILOTDECK_CONFIG_PATH is not overridden", () => {
  const root = systemRoot();
  const env = { PILOT_HOME: root, PILOTDECK_CONFIG_PATH: "/etc/pd.yaml" };
  applyCliHome(env, () => {});
  assert.equal(env.PILOTDECK_CONFIG_PATH, "/etc/pd.yaml");
  rmSync(root, { recursive: true, force: true });
});

test("a system root without admin-home is reported, not guessed", () => {
  const root = systemRoot(false);
  assert.deepEqual(resolveCliHome({ PILOT_HOME: root }), { kind: "system-root-without-admin", pilotHome: root });
  rmSync(root, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `PILOTDECK_SKIP_BOOTSTRAP=1 npm run build && node --test --test-force-exit dist/tests/cli/homeGuard.spec.js`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现 `homeGuard.ts`**

```ts
// src/cli/homeGuard.ts
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolvePilotHome, PILOT_CONFIG_FILE_NAME } from "../pilot/paths.js";

export type HomeGuardResult =
  | { kind: "user-home"; pilotHome: string }
  | { kind: "redirected"; pilotHome: string; configPath: string; from: string }
  | { kind: "system-root-without-admin"; pilotHome: string };

export function resolveCliHome(env: NodeJS.ProcessEnv): HomeGuardResult {
  const pilotHome = resolvePilotHome(env);
  if (!existsSync(resolve(pilotHome, "system", "auth.db"))) return { kind: "user-home", pilotHome };
  const pointer = resolve(pilotHome, "system", "admin-home");
  if (!existsSync(pointer)) return { kind: "system-root-without-admin", pilotHome };
  const adminHome = readFileSync(pointer, "utf8").trim();
  if (!adminHome || !existsSync(adminHome)) return { kind: "system-root-without-admin", pilotHome };
  return { kind: "redirected", pilotHome: adminHome, configPath: resolve(pilotHome, PILOT_CONFIG_FILE_NAME), from: pilotHome };
}

export function applyCliHome(env: NodeJS.ProcessEnv, log: (m: string) => void): void {
  const r = resolveCliHome(env);
  if (r.kind === "redirected") {
    env.PILOT_HOME = r.pilotHome;
    if (!env.PILOTDECK_CONFIG_PATH?.trim()) env.PILOTDECK_CONFIG_PATH = r.configPath;
    log(`[pilotdeck] PILOT_HOME is a multi-user root; using the administrator home ${r.pilotHome}`);
    return;
  }
  if (r.kind === "system-root-without-admin") {
    log(`[pilotdeck] PILOT_HOME ${r.pilotHome} is a multi-user root but system/admin-home is missing; start the web server once to create it, or point PILOT_HOME at a user directory.`);
  }
}
```

`src/cli/pilotdeck.ts` `main()`：在 `const command = argv[0];` 之后、任何 `resolvePilotHome` 调用之前，对 `command !== "server"` 的分支调用 `applyCliHome(process.env, console.log)`（`server` 子命令由池或操作者显式给定 `PILOT_HOME`，不改写）。`src/cli/commands/gatewaySetup.ts` 的模块级 `PILOT_HOME` 常量改为函数内读取（否则 `applyCliHome` 对它无效）。

- [ ] **Step 4: UI 侧两处改动**

`adminBootstrap.js` `ensureAdminUser()`：无论本次是否创建，只要存在激活 admin，就 `fs.writeFileSync(path.join(resolvePilotRoot(env), 'system', 'admin-home'), ensureHome(admin.id) + '\n')`（`ensureHome` 返回用户目录；在测试里注入的 `ensureHome: () => {}` 改为返回一个临时路径，并新增用例断言文件内容）。

`gatewayPool.js`：`createGatewayPool(options)` 读取 `options.multiUser`（布尔，默认 `true`）；`defaultSpawnGateway({ …, multiUser })` 仅当 `multiUser` 时设置 `PILOTDECK_DISABLE_ALWAYS_ON: '1'`。`pilotdeck-bridge.js` 构造池时传 `multiUser: !DISABLE_LOCAL_AUTH`（从 `./constants/config.js` 导入）。测试：`gatewayPool.test.js` 新增两个用例，注入 `spawnGateway` 捕获 `env`，断言 `multiUser: true` 时含该变量、`false` 时不含。

`scripts/config.env` 末尾加注释：`# CLI/TUI 在免登录模式下自动使用 <PILOT_HOME>/users/<admin>/；多用户部署不要暴露 CLI。`

- [ ] **Step 5: 验证**

Run: `PILOTDECK_SKIP_BOOTSTRAP=1 npm run build && node --test --test-force-exit dist/tests/cli/homeGuard.spec.js dist/tests/cli/serverFeatureFlags.spec.js`；`npm --prefix ui test -- server/services/gatewayPool.test.js server/services/adminBootstrap.test.js`；`node scripts/check-module-level-pilot-home.mjs ui/server`
Expected: PASS；扫描 OK

手工：`PILOT_HOME=/tmp/pd-plan2 node dist/src/cli/pilotdeck.js skills list`（先用 Task 10 的隔离根跑过一次服务器以生成 `system/admin-home`）应打印重定向行并正常列出技能。

- [ ] **Step 6: 提交**

```bash
git add src/cli/homeGuard.ts src/cli/pilotdeck.ts src/cli/commands/gatewaySetup.ts tests/cli/homeGuard.spec.ts ui/server/services/adminBootstrap.js ui/server/services/adminBootstrap.test.js ui/server/services/gatewayPool.js ui/server/services/gatewayPool.test.js ui/server/pilotdeck-bridge.js scripts/config.env
git commit -m "feat(multi-user): CLI 遇到系统根自动落到管理员目录；免登录模式保留 always-on"
```

---

### Task 4: 清理策略（日志滚动、附件与归档过期）

**Files:**
- Create: `src/pilot/retention.ts`
- Create: `src/pilot/config/parseMultiUserConfig.ts`；Modify: `src/pilot/config/types.ts`、`src/pilot/config/loadPilotConfig.ts`（挂到 `config.multiUser`）
- Modify: `src/cli/pilotdeck.ts`（server 启动后运行一次，并每 24 h 运行；`stop` 时清定时器）
- Modify: `ui/server/index.js:~3470`（上传临时目录 `os.tmpdir()/pilotdeck-chat-attachments/<userId>` 启动时清理 7 天以上文件）
- Test: `tests/pilot/retention.spec.ts`、`tests/pilot/multi-user-config.spec.ts`

**Interfaces:**

```ts
// src/pilot/config/parseMultiUserConfig.ts
export type RetentionConfig = { logMaxBytes: number; logKeep: number; attachmentMaxAgeDays: number; archiveMaxAgeDays: number };
export type MultiUserConfig = { retention: RetentionConfig; gatewayPool?: Record<string, unknown> };
export const DEFAULT_RETENTION: RetentionConfig = { logMaxBytes: 20 * 1024 * 1024, logKeep: 5, attachmentMaxAgeDays: 7, archiveMaxAgeDays: 30 };
export function parseMultiUserConfig(raw: unknown, diagnostics: PilotConfigDiagnostic[]): MultiUserConfig;

// src/pilot/retention.ts
export type RetentionReport = { rotatedLogs: string[]; removedAttachments: number; removedArchives: string[] };
export function assertInsideHome(candidate: string, home: string): void;        // realpath 前缀校验，越界抛错（spec §10.5）
export async function runRetention(opts: { pilotHome: string; config: RetentionConfig; now?: () => Date; log?: (m: string) => void }): Promise<RetentionReport>;
export function startRetentionTimer(opts: Parameters<typeof runRetention>[0] & { intervalMs?: number }): { stop(): void };  // 默认 24 h，unref
```

规则：
- `logs/*.jsonl`：大小 ≥ `logMaxBytes` 时重命名为 `<name>.1`、旧的 `.1→.2` … 超过 `logKeep` 删除。
- `.tmp/chat-attachments/**`：mtime 早于 `attachmentMaxAgeDays` 天的文件删除，空目录删除。
- `archives/projects/<id>-<时间戳>/`：目录名末尾的时间戳（`YYYYMMDDTHHMMSSZ`，见 `formatProjectArchiveTimestamp`）早于 `archiveMaxAgeDays` 天的整目录删除；解析失败的目录跳过并记日志。
- 每个删除/重命名前 `assertInsideHome`。

- [ ] **Step 1: 写失败测试**

```ts
// tests/pilot/retention.spec.ts
// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, utimesSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runRetention, assertInsideHome } from "../../src/pilot/retention.js";
import { DEFAULT_RETENTION } from "../../src/pilot/config/parseMultiUserConfig.js";

const DAY = 86_400_000;
function home() {
  const h = mkdtempSync(join(tmpdir(), "pd-ret-"));
  for (const d of ["logs", ".tmp/chat-attachments/old", ".tmp/chat-attachments/new", "archives/projects"]) mkdirSync(join(h, d), { recursive: true });
  return h;
}
const old = (p, days) => { const t = (Date.now() - days * DAY) / 1000; utimesSync(p, t, t); };

test("rotates oversized logs and keeps logKeep generations", async () => {
  const h = home();
  writeFileSync(join(h, "logs/trauma-agent.jsonl"), "x".repeat(2048));
  for (let i = 1; i <= 5; i += 1) writeFileSync(join(h, `logs/trauma-agent.jsonl.${i}`), `gen${i}`);
  const r = await runRetention({ pilotHome: h, config: { ...DEFAULT_RETENTION, logMaxBytes: 1024, logKeep: 5 } });
  assert.deepEqual(r.rotatedLogs, ["trauma-agent.jsonl"]);
  assert.ok(!existsSync(join(h, "logs/trauma-agent.jsonl")) || readdirSync(join(h, "logs")).length <= 6);
  assert.ok(existsSync(join(h, "logs/trauma-agent.jsonl.1")));
  assert.ok(!existsSync(join(h, "logs/trauma-agent.jsonl.6")));
  rmSync(h, { recursive: true, force: true });
});

test("removes attachments older than attachmentMaxAgeDays and prunes empty dirs", async () => {
  const h = home();
  writeFileSync(join(h, ".tmp/chat-attachments/old/a.png"), "a"); old(join(h, ".tmp/chat-attachments/old/a.png"), 8);
  writeFileSync(join(h, ".tmp/chat-attachments/new/b.png"), "b");
  const r = await runRetention({ pilotHome: h, config: DEFAULT_RETENTION });
  assert.equal(r.removedAttachments, 1);
  assert.ok(!existsSync(join(h, ".tmp/chat-attachments/old")));
  assert.ok(existsSync(join(h, ".tmp/chat-attachments/new/b.png")));
  rmSync(h, { recursive: true, force: true });
});

test("removes project archives older than archiveMaxAgeDays by their name timestamp", async () => {
  const h = home();
  const fmt = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const oldDir = join(h, "archives/projects", `general_med-x-${fmt(new Date(Date.now() - 40 * DAY))}`);
  const newDir = join(h, "archives/projects", `general_med-y-${fmt(new Date(Date.now() - 2 * DAY))}`);
  mkdirSync(oldDir); mkdirSync(newDir); mkdirSync(join(h, "archives/projects/not-a-timestamp"));
  const r = await runRetention({ pilotHome: h, config: DEFAULT_RETENTION });
  assert.equal(r.removedArchives.length, 1);
  assert.ok(!existsSync(oldDir)); assert.ok(existsSync(newDir)); assert.ok(existsSync(join(h, "archives/projects/not-a-timestamp")));
  rmSync(h, { recursive: true, force: true });
});

test("never deletes through a symlink that escapes the home", async () => {
  const h = home(); const outside = mkdtempSync(join(tmpdir(), "pd-out-"));
  writeFileSync(join(outside, "secret.txt"), "s"); old(join(outside, "secret.txt"), 30);
  symlinkSync(outside, join(h, ".tmp/chat-attachments/escape"));
  await runRetention({ pilotHome: h, config: DEFAULT_RETENTION });
  assert.ok(existsSync(join(outside, "secret.txt")));
  assert.throws(() => assertInsideHome(join(h, ".tmp/chat-attachments/escape/secret.txt"), h), /outside/);
  rmSync(h, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true });
});
```

```ts
// tests/pilot/multi-user-config.spec.ts
// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { parseMultiUserConfig, DEFAULT_RETENTION } from "../../src/pilot/config/parseMultiUserConfig.js";

test("defaults when the section is absent", () => {
  assert.deepEqual(parseMultiUserConfig(undefined, []).retention, DEFAULT_RETENTION);
});
test("overrides are applied and invalid values fall back with a diagnostic", () => {
  const diags = [];
  const r = parseMultiUserConfig({ retention: { attachmentMaxAgeDays: 3, logKeep: "many" } }, diags);
  assert.equal(r.retention.attachmentMaxAgeDays, 3);
  assert.equal(r.retention.logKeep, DEFAULT_RETENTION.logKeep);
  assert.ok(diags.some((d) => /logKeep/.test(d.message)));
});
```

- [ ] **Step 2: 运行确认失败**

Run: `PILOTDECK_SKIP_BOOTSTRAP=1 npm run build 2>&1 | tail -3`
Expected: 编译失败（模块不存在）

- [ ] **Step 3: 实现**

```ts
// src/pilot/config/parseMultiUserConfig.ts
import type { PilotConfigDiagnostic } from "./types.js";
export type RetentionConfig = { logMaxBytes: number; logKeep: number; attachmentMaxAgeDays: number; archiveMaxAgeDays: number };
export type MultiUserConfig = { retention: RetentionConfig; gatewayPool?: Record<string, unknown> };
export const DEFAULT_RETENTION: RetentionConfig = { logMaxBytes: 20 * 1024 * 1024, logKeep: 5, attachmentMaxAgeDays: 7, archiveMaxAgeDays: 30 };

function num(raw: Record<string, unknown>, key: keyof RetentionConfig, fallback: number, diagnostics: PilotConfigDiagnostic[]): number {
  const v = raw[key];
  if (v === undefined) return fallback;
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  diagnostics.push({ level: "warn", message: `multiUser.retention.${key} must be a positive number; using ${fallback}` } as PilotConfigDiagnostic);
  return fallback;
}

export function parseMultiUserConfig(raw: unknown, diagnostics: PilotConfigDiagnostic[]): MultiUserConfig {
  const section = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const ret = section.retention && typeof section.retention === "object" ? (section.retention as Record<string, unknown>) : {};
  return {
    retention: {
      logMaxBytes: num(ret, "logMaxBytes", DEFAULT_RETENTION.logMaxBytes, diagnostics),
      logKeep: num(ret, "logKeep", DEFAULT_RETENTION.logKeep, diagnostics),
      attachmentMaxAgeDays: num(ret, "attachmentMaxAgeDays", DEFAULT_RETENTION.attachmentMaxAgeDays, diagnostics),
      archiveMaxAgeDays: num(ret, "archiveMaxAgeDays", DEFAULT_RETENTION.archiveMaxAgeDays, diagnostics),
    },
    gatewayPool: section.gatewayPool && typeof section.gatewayPool === "object" ? (section.gatewayPool as Record<string, unknown>) : undefined,
  };
}
```

`PilotConfigDiagnostic` 的实际字段名以 `src/pilot/config/types.ts` 为准（若是 `{ severity, message }` 就照用）。在 `types.ts` 的 `PilotConfig` 加 `multiUser: MultiUserConfig`；`loadPilotConfig.ts` 在解析其他段落的位置加 `multiUser: parseMultiUserConfig(rawConfig.multiUser, diagnostics)`；`validateTopLevel` 的已知顶层键列表加 `multiUser`。

```ts
// src/pilot/retention.ts
import { promises as fsp, realpathSync, existsSync } from "node:fs";
import { join, relative, resolve, basename, dirname } from "node:path";
import type { RetentionConfig } from "./config/parseMultiUserConfig.js";

export type RetentionReport = { rotatedLogs: string[]; removedAttachments: number; removedArchives: string[] };
const DAY = 86_400_000;

export function assertInsideHome(candidate: string, home: string): void {
  const realHome = realpathSync(home);
  const probe = existsSync(candidate) ? realpathSync(candidate) : resolve(realpathSync(dirname(candidate)), basename(candidate));
  const rel = relative(realHome, probe);
  if (rel.startsWith("..") || resolve(realHome, rel) !== probe) throw new Error(`retention refused: ${candidate} is outside ${home}`);
}

async function rotateLogs(home: string, cfg: RetentionConfig, out: RetentionReport): Promise<void> {
  const dir = join(home, "logs");
  if (!existsSync(dir)) return;
  for (const name of await fsp.readdir(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const file = join(dir, name);
    const stat = await fsp.lstat(file);
    if (!stat.isFile() || stat.size < cfg.logMaxBytes) continue;
    for (let i = cfg.logKeep; i >= 1; i -= 1) {
      const src = i === 1 ? file : `${file}.${i - 1}`;
      const dst = `${file}.${i}`;
      if (!existsSync(src)) continue;
      assertInsideHome(src, home);
      if (i === cfg.logKeep && existsSync(dst)) await fsp.rm(dst);
      await fsp.rename(src, dst);
    }
    out.rotatedLogs.push(name);
  }
}

async function pruneAttachments(home: string, cfg: RetentionConfig, now: number, out: RetentionReport): Promise<void> {
  const root = join(home, ".tmp", "chat-attachments");
  if (!existsSync(root)) return;
  const cutoff = now - cfg.attachmentMaxAgeDays * DAY;
  async function walk(dir: string): Promise<boolean> {
    let empty = true;
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isSymbolicLink()) { empty = false; continue; }          // never follow links
      if (entry.isDirectory()) { if (await walk(p)) { assertInsideHome(p, home); await fsp.rmdir(p); } else empty = false; continue; }
      const st = await fsp.lstat(p);
      if (st.mtimeMs < cutoff) { assertInsideHome(p, home); await fsp.rm(p); out.removedAttachments += 1; } else empty = false;
    }
    return empty;
  }
  await walk(root);
}

const ARCHIVE_TS = /-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;
async function pruneArchives(home: string, cfg: RetentionConfig, now: number, out: RetentionReport, log: (m: string) => void): Promise<void> {
  const dir = join(home, "archives", "projects");
  if (!existsSync(dir)) return;
  const cutoff = now - cfg.archiveMaxAgeDays * DAY;
  for (const name of await fsp.readdir(dir)) {
    const m = ARCHIVE_TS.exec(name);
    if (!m) { log(`[retention] skip archive without timestamp: ${name}`); continue; }
    const when = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    if (when >= cutoff) continue;
    const p = join(dir, name);
    assertInsideHome(p, home);
    await fsp.rm(p, { recursive: true, force: true });
    out.removedArchives.push(name);
  }
}

export async function runRetention(opts: { pilotHome: string; config: RetentionConfig; now?: () => Date; log?: (m: string) => void }): Promise<RetentionReport> {
  const log = opts.log ?? (() => {});
  const now = (opts.now ?? (() => new Date()))().getTime();
  const out: RetentionReport = { rotatedLogs: [], removedAttachments: 0, removedArchives: [] };
  await rotateLogs(opts.pilotHome, opts.config, out);
  await pruneAttachments(opts.pilotHome, opts.config, now, out);
  await pruneArchives(opts.pilotHome, opts.config, now, out, log);
  if (out.rotatedLogs.length || out.removedAttachments || out.removedArchives.length) log(`[retention] ${JSON.stringify(out)}`);
  return out;
}

export function startRetentionTimer(opts: Parameters<typeof runRetention>[0] & { intervalMs?: number }): { stop(): void } {
  const run = () => void runRetention(opts).catch((e) => (opts.log ?? console.warn)(`[retention] failed: ${(e as Error).message}`));
  run();
  const timer = setInterval(run, opts.intervalMs ?? DAY);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
```

`src/cli/pilotdeck.ts` `server` 分支：在 `startPilotDeckServer` 成功后 `const retention = startRetentionTimer({ pilotHome, config: snapshot.config.multiUser.retention, log: console.log });`，`stop()` 里 `retention.stop()`。

`ui/server/index.js` 上传临时目录：在监听回调里加一次性清理：遍历 `path.join(os.tmpdir(), 'pilotdeck-chat-attachments')` 下所有文件，mtime 超过 7 天的删除（try/catch，日志一行）。

- [ ] **Step 4: 验证**

Run: `PILOTDECK_SKIP_BOOTSTRAP=1 npm run build && node --test --test-force-exit --test-timeout 60000 dist/tests/pilot/retention.spec.js dist/tests/pilot/multi-user-config.spec.js dist/tests/pilot/config-path-override.spec.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/pilot/retention.ts src/pilot/config/parseMultiUserConfig.ts src/pilot/config/types.ts src/pilot/config/loadPilotConfig.ts src/cli/pilotdeck.ts tests/pilot/retention.spec.ts tests/pilot/multi-user-config.spec.ts ui/server/index.js
git commit -m "feat(multi-user): 用户目录清理策略（日志滚动、附件 7 天、归档 30 天），运行在各自 Gateway 内"
```

---

### Task 5: 管理员门禁、脱敏修补与用户删除

**Files:**
- Modify: `ui/server/index.js`（路由挂载 ~572–621、内联路由 649–834、1042、1484、1573；WS 分派 ~2664；`broadcastConfigReloaded` ~272）
- Modify: `ui/server/routes/config.js:198,594-632`（脱敏）、`ui/server/routes/memory.js:414-423`（`/settings` 管理员）、`ui/server/routes/user.js:61-80`（去掉 `git --global`）、`ui/server/routes/plugins.js`（只读端点放行）
- Modify: `ui/server/services/wsScope.js`（socket 上记录 role）、`ui/server/services/gatewayPool.js`（子进程 env 加 `GIT_CONFIG_GLOBAL`）
- Modify: `ui/server/routes/adminUsers.js`（`DELETE /users/:id`、列表加 `storageBytes`）
- Test: `ui/server/adminGating.test.js`（新）、`ui/server/routes/adminUsers.test.js`（新增用例）、`ui/server/routes/user.test.js`（新增用例）

**Interfaces:**
- Consumes: `requireAdmin`（计划一）、`toGatewayHttpError`、`closeUserSockets`、`SOCKET_USER_ID`（计划一）
- Produces: 挂载表（`requireAdminChain = [authenticateToken, userScopeMiddleware, requireAdmin]`）:

| 挂载 | 变更 |
|---|---|
| `/api/config`、`/api/mcp`、`/api/mcp-utils`、`/api/update`、`/api/gateway` | 整个 router → `requireAdminChain` |
| `/api/plugins` | `GET /`、`GET /:name/manifest`、`GET /:name/assets/*` 保持 `requireUser`；其余（enable/install/update/delete）在 router 内部对单个路由加 `requireAdmin` |
| `/api/memory` | `GET/POST /settings` 加 `requireAdmin`（路由内）；其余不变 |
| `/api/ccr/*`（6 个内联）、`/api/browse-filesystem`、`/api/create-folder`、`POST /api/projects/create`（手工路径） | `...requireAdminChain` |
| `/api/agents/runtime-config`、`/api/settings/*`、`/api/user/*`、`/api/skills/*`、`/api/commands/*` | 不变（按用户） |
| `/shell` WebSocket | `bindConnectionScope` 后检查 `scope.role === 'admin'`，否则 `ws.close(4403, 'ADMIN_REQUIRED')` |

- Produces: `GET /api/config/provider` 返回 `apiKey: MASK`（前端只需要「是否已配置」：加 `hasApiKey: boolean`）；`serializeConfigResponse` 解析失败分支 `raw: rawYamlToMaskedString(record.raw)`。
- Produces: `broadcastConfigReloaded` 只发给 `client[SOCKET_ROLE] === 'admin'` 的连接；`wsScope.bindConnectionScope` 在握手时把 `role` 写到 `ws.__pilotdeckRole`（导出常量 `SOCKET_ROLE`）。
- Produces: `POST /api/user/git-config` 不再执行 `git config --global`；写入 `users` 表并同步写 `<userHome>/.gitconfig`（`[user]\n\tname = …\n\temail = …`）；`gatewayPool` 子进程 env 增加 `GIT_CONFIG_GLOBAL=<userHome>/.gitconfig`。`GET /api/user/git-config` 不再回退到宿主机全局 git 身份，返回空字符串。
- Produces: `DELETE /api/admin/users/:id`：停用 + `bumpTokenVersion` + `onUserRevoked` + 把 `users/<id>/` 整体 `rename` 到 `<root>/archives/users/<id>-<timestamp>/`（不物理删除；`LAST_ADMIN` 保护同 PATCH）；`GET /api/admin/users` 每项增加 `storageBytes`（`du` 等价的递归求和，缓存 60 s）。

- [ ] **Step 1: 写失败测试（门禁矩阵）**

```js
// ui/server/adminGating.test.js
// @vitest-environment node
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let root; let server; let base; let tokens;
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-gate-'));
  fs.writeFileSync(path.join(root, 'pilotdeck.yaml'), 'schemaVersion: 1\nproviders:\n  - id: p1\n    apiKey: sk-secret\n');
  vi.stubEnv('PILOT_HOME', root); vi.stubEnv('DATABASE_PATH', ''); vi.stubEnv('PILOTDECK_DISABLE_LOCAL_AUTH', '0'); vi.stubEnv('PILOTDECK_ADMIN_PASSWORD', 'adminpass');
  vi.resetModules();
  vi.doMock('./services/gatewayPool.js', () => ({ createGatewayPool: () => ({ acquire: async () => ({ gateway: { listProjects: async () => ({ projects: [] }), reloadConfig: async () => {} }, release: () => {} }), markRevoked: () => {}, shutdown: async () => {}, snapshot: () => [] }) }));
  const db = await import('./database/db.js'); await db.initializeDatabase();
  const { ensureAdminUser } = await import('./services/adminBootstrap.js'); await ensureAdminUser({ userDb: db.userDb, log: () => {}, ensureHome: () => root });
  const { authenticateToken, generateToken } = await import('./middleware/auth.js');
  const { userScopeMiddleware } = await import('./middleware/userScope.js');
  const { requireAdmin } = await import('./middleware/requireAdmin.js');
  const { buildApiRouter } = await import('./apiRouter.js');          // Task 5 Step 3 extracts the mount table here
  const app = express(); app.use(express.json());
  app.use('/api', buildApiRouter({ authenticateToken, userScopeMiddleware, requireAdmin }));
  server = app.listen(0); base = `http://127.0.0.1:${server.address().port}`;
  const alice = db.userDb.createUser('alice', 'x', 'user');
  tokens = { admin: generateToken(db.userDb.getAdminUser()), alice: generateToken(db.userDb.getUserById(alice.id)) };
});
afterEach(async () => { await new Promise((r) => server.close(r)); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });
const call = (who, method, p) => fetch(`${base}${p}`, { method, headers: { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });

const ADMIN_ONLY = [
  ['GET', '/api/config'], ['PUT', '/api/config'], ['GET', '/api/config/provider'], ['POST', '/api/config/reload'],
  ['GET', '/api/mcp/config'], ['GET', '/api/mcp-utils/all-servers'], ['GET', '/api/update/status'], ['GET', '/api/gateway/status'],
  ['PUT', '/api/plugins/med-tools/enable'], ['POST', '/api/plugins/install'], ['GET', '/api/memory/settings'],
  ['GET', '/api/ccr/dashboard'], ['GET', '/api/browse-filesystem'], ['POST', '/api/create-folder'], ['POST', '/api/projects/create'],
];
const USER_OK = [['GET', '/api/plugins'], ['GET', '/api/agents/runtime-config'], ['GET', '/api/settings/api-keys'], ['GET', '/api/user/git-config'], ['GET', '/api/memory/overview']];

describe('admin gating matrix', () => {
  it.each(ADMIN_ONLY)('%s %s is 403 ADMIN_REQUIRED for a user and not 403 for admin', async (method, p) => {
    const u = await call('alice', method, p);
    expect(u.status).toBe(403);
    expect((await u.json()).code).toBe('ADMIN_REQUIRED');
    expect((await call('admin', method, p)).status).not.toBe(403);
  });
  it.each(USER_OK)('%s %s stays reachable for a user', async (method, p) => {
    expect((await call('alice', method, p)).status).not.toBe(403);
  });
  it('provider endpoint never returns the raw key, even to admin', async () => {
    const body = await (await call('admin', 'GET', '/api/config/provider?id=p1')).json();
    expect(JSON.stringify(body)).not.toContain('sk-secret');
    expect(body.hasApiKey).toBe(true);
  });
  it('a broken YAML is returned masked', async () => {
    fs.writeFileSync(path.join(root, 'pilotdeck.yaml'), 'providers:\n  - apiKey: sk-leak\n  bad: [\n');
    const body = await (await call('admin', 'GET', '/api/config')).json();
    expect(JSON.stringify(body)).not.toContain('sk-leak');
  });
});
```

`buildApiRouter` 是本任务把 `index.js` 里的 `app.use('/api/<x>', …)` 挂载表抽到 `ui/server/apiRouter.js` 的结果（`index.js` 改为 `app.use('/api', buildApiRouter({...}))`）。抽取时只搬「挂载」，各 router 文件不动；内联的 `app.get('/api/...')` 路由留在 `index.js`，但其中要改门禁的几条（ccr、browse-filesystem、create-folder、projects/create）也迁入 `apiRouter.js`，这样矩阵测试能覆盖。

- [ ] **Step 2: 写失败测试（用户管理与 git）**

`adminUsers.test.js` 新增：
```js
it('DELETE deactivates, revokes, archives the home and refuses the last admin', async () => {
  const { users } = await (await call('GET', '/api/admin/users', null, adminToken)).json();
  const alice = users.find((u) => u.username === 'alice');
  fs.mkdirSync(path.join(root, 'users', String(alice.id), 'projects'), { recursive: true });
  const res = await call('DELETE', `/api/admin/users/${alice.id}`, null, adminToken);
  expect(res.status).toBe(200);
  expect(revoked).toContain(alice.id);
  expect(fs.existsSync(path.join(root, 'users', String(alice.id)))).toBe(false);
  expect(fs.readdirSync(path.join(root, 'archives', 'users')).some((n) => n.startsWith(`${alice.id}-`))).toBe(true);
  const admin = users.find((u) => u.username === 'admin');
  expect((await call('DELETE', `/api/admin/users/${admin.id}`, null, adminToken)).status).toBe(409);
});
it('list carries storageBytes', async () => {
  const { users } = await (await call('GET', '/api/admin/users', null, adminToken)).json();
  expect(users.every((u) => typeof u.storageBytes === 'number')).toBe(true);
});
```

`user.test.js` 新增：`POST /api/user/git-config` 不调用 `git`（用 `vi.spyOn(child_process, 'exec')` 断言未被调用），并在 `<root>/users/1/.gitconfig` 写出 `[user]` 段；`GET` 在库为空时返回空字符串而不是宿主机身份。

- [ ] **Step 3: 运行确认失败**

Run: `npm --prefix ui test -- server/adminGating.test.js server/routes/adminUsers.test.js server/routes/user.test.js`
Expected: FAIL（`apiRouter.js` 不存在；DELETE 404；git 仍被调用）

- [ ] **Step 4: 实现**

`ui/server/apiRouter.js`：

```js
import express from 'express';
import authRoutes from './routes/auth.js';
import { createAdminUsersRouter } from './routes/adminUsers.js';
import configRoutes from './routes/config.js';
// … 其余 router 的 import 原样从 index.js 搬过来

export function buildApiRouter({ authenticateToken, userScopeMiddleware, requireAdmin, onUserRevoked = () => {} }) {
  const api = express.Router();
  const requireUser = [authenticateToken, userScopeMiddleware];
  const requireAdminChain = [authenticateToken, userScopeMiddleware, requireAdmin];
  api.use('/auth', authRoutes);
  api.use('/admin', ...requireAdminChain, createAdminUsersRouter({ onUserRevoked }));
  // admin-only system surfaces
  api.use('/config', ...requireAdminChain, configRoutes);
  api.use('/mcp', ...requireAdminChain, mcpRoutes);
  api.use('/mcp-utils', ...requireAdminChain, mcpUtilsRoutes);
  api.use('/update', ...requireAdminChain, updateRoutes);
  api.use('/gateway', ...requireAdminChain, gatewayRoutes);
  // per-user surfaces
  api.use('/plugins', ...requireUser, pluginsRoutes);          // write endpoints gated inside plugins.js
  api.use('/memory', ...requireUser, memoryRoutes);            // /settings gated inside memory.js
  api.use('/settings', ...requireUser, settingsRoutes);
  api.use('/user', ...requireUser, userRoutes);
  // … 其余 requireUser 挂载按 index.js 原顺序搬入
  return api;
}
```

`index.js` 中对应的 `app.use('/api/...')` 行删除，改为一行 `app.use('/api', buildApiRouter({ authenticateToken, userScopeMiddleware, requireAdmin, onUserRevoked: (id) => revokeUserRuntime(id) }));`。`/api/ccr/*`、`/api/browse-filesystem`、`/api/create-folder`、`/api/projects/create` 四组内联路由的处理函数从 `index.js` 抽成具名函数并通过 `buildApiRouter({ …, inline })` 传入，在 router 内挂 `requireAdminChain`：

```js
// index.js
app.use('/api', buildApiRouter({
  authenticateToken, userScopeMiddleware, requireAdmin,
  onUserRevoked: (id) => revokeUserRuntime(id),
  inline: { ccrDashboard, ccrHealth, ccrConfig, ccrStatsSummary, ccrSessionStats, ccrStatsReset, ccrConfigPut, browseFilesystem, createFolder, createProjectManual },
}));
// apiRouter.js
api.get('/ccr/dashboard', ...requireAdminChain, inline.ccrDashboard);
api.get('/ccr/health', ...requireAdminChain, inline.ccrHealth);
api.get('/ccr/config', ...requireAdminChain, inline.ccrConfig);
api.get('/ccr/stats/summary', ...requireAdminChain, inline.ccrStatsSummary);
api.get('/ccr/stats/sessions/:sessionId', ...requireAdminChain, inline.ccrSessionStats);
api.post('/ccr/stats/reset', ...requireAdminChain, inline.ccrStatsReset);
api.put('/ccr/config', ...requireAdminChain, inline.ccrConfigPut);
api.get('/browse-filesystem', ...requireAdminChain, inline.browseFilesystem);
api.post('/create-folder', ...requireAdminChain, inline.createFolder);
api.post('/projects/create', ...requireAdminChain, inline.createProjectManual);
```

`adminGating.test.js` 给 `inline` 传一组返回 `200 {}` 的桩函数，矩阵只验证门禁。

`plugins.js`：`router.put('/:name/enable', requireAdmin, …)`、`router.post('/install', requireAdmin, …)`、`router.post('/:name/update', requireAdmin, …)`、`router.delete('/:name', requireAdmin, …)`（从 `../middleware/requireAdmin.js` 导入）。`memory.js`：`router.get('/settings', requireAdmin, …)`、`router.post('/settings', requireAdmin, …)`。

`config.js:594-632` `/provider`：响应中 `apiKey: provider.apiKey ? MASK : ''`，增加 `hasApiKey: Boolean(provider.apiKey)`；`serializeConfigResponse` 解析失败分支改为 `raw: rawYamlToMaskedString(record.raw)`（若 `rawYamlToMaskedString` 需要可解析 YAML，则退化为正则把 `apiKey|token|secret` 行的值替换为 `********`，并加单测）。

`wsScope.js`：`export const SOCKET_ROLE = '__pilotdeckRole';` `bindConnectionScope` 返回 `{ userId, role }` 不变；`index.js` 握手处 `ws[SOCKET_ROLE] = scope.role`；`broadcastConfigReloaded` 过滤 `client[SOCKET_ROLE] === 'admin'`。`/shell`：`if (scope.role !== 'admin') { ws.close(4403, 'ADMIN_REQUIRED'); return; }`。

`user.js`：删除两处 `git config --global`；写 `path.join(resolveScopedHome(), '.gitconfig')`；GET 去掉 `getSystemGitConfig()` 回退。`gatewayPool.js` `defaultSpawnGateway` env 加 `GIT_CONFIG_GLOBAL: path.join(userHome, '.gitconfig')`。

`adminUsers.js`：

```js
router.delete('/users/:id', guard(async (req, res) => {
  const target = userDb.getUserById(Number(req.params.id));
  if (!target) return fail(res, 404, 'USER_NOT_FOUND', 'User not found');
  if (wouldRemoveLastAdmin(target, { isActive: false })) return fail(res, 409, 'LAST_ADMIN', 'Cannot remove the last administrator');
  userDb.setActive(target.id, false);
  userDb.bumpTokenVersion(target.id);
  onUserRevoked(target.id);
  const home = resolveUserHome(target.id);
  if (fs.existsSync(home)) {
    const dest = path.join(resolvePilotRoot(), 'archives', 'users', `${target.id}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.rename(home, dest);
  }
  res.json({ user: toPublic(userDb.getUserById(target.id)), archived: true });
}));
```

`storageBytes`：`services/storageUsage.js` 导出 `getUserStorageBytes(userId)`，递归 `lstat` 求和（跳过符号链接），结果按 userId 缓存 60 s；列表里并发计算。

- [ ] **Step 5: 验证**

Run: `npm --prefix ui test -- server/adminGating.test.js server/routes/adminUsers.test.js server/routes/user.test.js server/multiUser.isolation.test.js`；`node --check ui/server/index.js`；`npm --prefix ui run typecheck`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add ui/server/apiRouter.js ui/server/adminGating.test.js ui/server/index.js ui/server/routes/config.js ui/server/routes/memory.js ui/server/routes/user.js ui/server/routes/user.test.js ui/server/routes/plugins.js ui/server/routes/adminUsers.js ui/server/routes/adminUsers.test.js ui/server/services/wsScope.js ui/server/services/gatewayPool.js ui/server/services/storageUsage.js
git commit -m "feat(multi-user): 系统配置接口管理员门禁；配置脱敏修补；Shell 仅管理员；Git 身份按用户；删除用户归档目录"
```

---

### Task 6: 计划一遗留项：撤销关闭所有 socket、旧库路径告警、熔断重置

**Files:**
- Modify: `ui/server/index.js`（`/shell` 与 `/plugin-ws/*` 连接加入 `connectedClients` 或新 `auxClients` 集合，并在 `revokeUserRuntime` 中一并关闭）
- Modify: `ui/server/services/pilotdeckConfig.js:~418-425`（忽略旧 `databasePath` 时 `console.warn`）
- Modify: `ui/server/services/gatewayPool.js`（熔断：实例就绪并持有租约累计 ≥ `healthyAfterMs`（默认 5 分钟）后清零失败计数）
- Test: `ui/server/services/wsScope.test.js`（新增用例）、`ui/server/services/pilotdeckConfig.test.js`（新增用例）、`ui/server/services/gatewayPool.test.js`（新增用例）

**Interfaces:**
- Produces: `index.js` 维护 `auxClients: Set<ws>`（shell 与 plugin-ws），握手后 `ws[SOCKET_USER_ID] = scope.userId`；`revokeUserRuntime(userId)` 调用 `closeUserSockets(connectedClients, id)` 与 `closeUserSockets(auxClients, id)`；`gracefulShutdown` 同样关闭 `auxClients`（1001）。
- Produces: `buildRuntimeEnv` 在丢弃 `databasePath` 时打印 `[config] webui.runtime.databasePath points at the legacy <root>/auth.db and is ignored; the account database lives at system/auth.db`，每个进程只打印一次。
- Produces: 池内 `entry.readySince`；`release()` 时若 `now - readySince ≥ config.healthyAfterMs` 则 `failures.delete(userId)`；`healthyAfterMs` 加入 `readMultiUserConfig` 默认 5 分钟。

- [ ] **Step 1: 写失败测试**

```js
// gatewayPool.test.js — 新增
it('clears the breaker only after a sustained healthy lease', async () => {
  const f = makeFakes({ failUsers: new Set(['9']) }); const pool = mk(f, { healthyAfterMs: 1000 });
  for (let i = 0; i < 2; i += 1) await expect(pool.acquire(9)).rejects.toMatchObject({ code: 'GATEWAY_UNAVAILABLE' });
  f.failUsers.delete('9');
  const short = await pool.acquire(9); await clock.advance(500); short.release();       // not long enough
  const long = await pool.acquire(9); await clock.advance(1500); long.release();        // healthy ≥ 1000 ms → reset
  f.failUsers.add('9'); await pool.stopUser(9);
  await expect(pool.acquire(9)).rejects.toMatchObject({ code: 'GATEWAY_UNAVAILABLE' });  // 1st failure after reset
  // without the reset this would have been the 3rd consecutive failure and tripped the breaker: prove a spawn still happens
  expect(f.spawnGateway).toHaveBeenCalledTimes(5);
});
```

```js
// pilotdeckConfig.test.js — 新增
it('warns once when webui.runtime.databasePath points at the legacy root auth.db', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const env = buildRuntimeEnv({ webui: { runtime: { databasePath: 'auth.db' } } });   // 用模块实际导出的函数名
  expect(env.DATABASE_PATH).toBeUndefined();
  buildRuntimeEnv({ webui: { runtime: { databasePath: 'auth.db' } } });
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0][0]).toMatch(/legacy .*auth\.db.*ignored/);
});
```

```js
// wsScope.test.js — 新增
it('closeUserSockets works independently on the chat set and the aux set', () => {
  const mk = (uid) => ({ readyState: 1, [SOCKET_USER_ID]: uid, close: vi.fn() });
  const chat = new Set([mk(1), mk(2)]); const aux = new Set([mk(2), mk(3)]);
  closeUserSockets(chat, 2); closeUserSockets(aux, 2);
  expect([...chat].map((s) => s.close.mock.calls.length)).toEqual([0, 1]);
  expect([...aux].map((s) => s.close.mock.calls.length)).toEqual([1, 0]);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm --prefix ui test -- server/services/wsScope.test.js server/services/pilotdeckConfig.test.js server/services/gatewayPool.test.js`
Expected: FAIL（`healthyAfterMs` 未实现；无告警；aux 集合用例在 index.js 层无法直接测，wsScope 层应已通过——若通过则该用例只是回归保护）

- [ ] **Step 3: 实现**

`index.js`：`const auxClients = new Set();` 在 `handleShellConnection` 与 `handlePluginWsProxy` 握手成功后 `ws[SOCKET_USER_ID] = scope.userId; auxClients.add(ws); ws.on('close', () => auxClients.delete(ws));`；`revokeUserRuntime` 增加 `closeUserSockets(auxClients, id);`；`gracefulShutdown` 的 socket 关闭循环同样遍历 `auxClients`。`/plugin-ws/*` 现在没有作用域绑定——先 `bindConnectionScope(request)`，为空则 `ws.close(4401, 'UNAUTHENTICATED')`。

`pilotdeckConfig.js` `buildRuntimeEnv`：

```js
let warnedLegacyDbPath = false;
// 在忽略旧值的分支：
if (!warnedLegacyDbPath) {
  console.warn('[config] webui.runtime.databasePath points at the legacy <root>/auth.db and is ignored; the account database lives at system/auth.db');
  warnedLegacyDbPath = true;
}
```

`gatewayPool.js`：`entry.readySince = now()` 在进入 `idle` 时设置；`release()` 中 `if (entry.readySince != null && now() - entry.readySince >= config.healthyAfterMs) failures.delete(userId);`；`DEFAULTS.healthyAfterMs = 5 * 60_000`；`readMultiUserConfig().gatewayPool.healthyAfterMs` 同样默认 5 分钟。

- [ ] **Step 4: 验证**

Run: `npm --prefix ui test -- server/services/wsScope.test.js server/services/pilotdeckConfig.test.js server/services/gatewayPool.test.js`；`node --check ui/server/index.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add ui/server/index.js ui/server/services/wsScope.js ui/server/services/wsScope.test.js ui/server/services/pilotdeckConfig.js ui/server/services/pilotdeckConfig.test.js ui/server/services/gatewayPool.js ui/server/services/gatewayPool.test.js
git commit -m "fix(multi-user): 撤销时关闭 shell/plugin socket；旧库路径配置告警；熔断按持续健康重置"
```

---

### Task 7: 前端认证：角色、注册、401/4401 处理、本地存储命名空间

**Files:**
- Modify: `ui/src/components/auth/types.ts`、`ui/src/components/auth/context/AuthContext.tsx`、`ui/src/components/auth/view/ProtectedRoute.tsx`、`ui/src/components/auth/view/LoginForm.tsx`、`ui/src/components/auth/view/SetupForm.tsx`（改名为 `RegisterForm.tsx`，保留导出名兼容）
- Modify: `ui/src/utils/api.js:35-68`（401 处理、刷新令牌事件）
- Modify: `ui/src/contexts/WebSocketContext.tsx:160-180`（关闭码）、`ui/src/components/shell/hooks/useShellConnection.ts:~164`
- Modify: `ui/src/components/chat/utils/chatStorage.ts`（`safeLocalStorage` 加命名空间）、`ui/src/contexts/ThemeContext.jsx`、`ui/src/i18n/config.js`、`ui/src/utils/projectSortPreference.ts`（改用 `safeLocalStorage`）
- Modify: `ui/src/i18n/locales/{zh-CN,en}/auth.json`
- Test: `ui/src/components/auth/context/AuthContext.test.tsx`（新）、`ui/src/utils/api.auth.test.js`（新）、`ui/src/contexts/WebSocketContext.close.test.tsx`（新）、`ui/src/components/chat/utils/chatStorage.spec.ts`（新增用例）

**Interfaces:**
- Produces（types）: `AuthUser = { id: number | string; username: string; role: 'admin' | 'user' }`；`AuthStatusPayload = { authDisabled?: boolean; registrationOpen?: boolean; needsSetup?: boolean }`；`AuthContextValue` 增加 `registrationOpen: boolean`、`authDisabled: boolean`（来自 `/status`，免登录模式为 true）、`isAdmin: boolean`、`changePassword(current, next) → Promise<AuthActionResult>`。
- Produces（api.js）: `authenticatedFetch` 在收到 401 且响应体 `code ∈ TOKEN_REVOKED | USER_DISABLED | INVALID_TOKEN | USER_NOT_FOUND` 时：清除 `auth-token`，`window.dispatchEvent(new CustomEvent('pilotdeck:auth-revoked', { detail: { code } }))`；收到 `X-Refreshed-Token` 时除写 localStorage 外派发 `pilotdeck:token-refreshed`。`api.auth` 增加 `changePassword(currentPassword, newPassword)` → `POST /api/auth/password`。
- Produces（AuthContext）: 监听 `pilotdeck:auth-revoked` → `clearSession()` 并清空用户命名空间下的本地缓存；监听 `pilotdeck:token-refreshed` → `setToken`。`checkAuthStatus` 读取 `registrationOpen`。`logout()` 先 `await api.auth.logout()`（失败忽略）再 `clearSession()`，并派发 `pilotdeck:auth-logout` 让 WebSocket 关闭。
- Produces（ProtectedRoute）: `needsSetup` 逻辑删除；未登录显示 `LoginForm`，`LoginForm` 在 `registrationOpen` 时显示「注册」切换到 `RegisterForm`。
- Produces（WebSocket）: `onclose` 中 `event.code === 4401 || event.code === 4403` → 不重连，派发 `pilotdeck:auth-revoked`（4401）；`1001` → 按原逻辑退避重连。监听 `pilotdeck:auth-logout` → `ws.close(1000)` 且不重连。
- Produces（storage）: `safeLocalStorage` 的 key 自动加前缀 `u<userId>:`（当前用户 id 由 `setStorageUserId(id | null)` 设置，`AuthContext` 在用户变化时调用）；无用户时前缀为 `anon:`。`clearStorageForUser(id)` 删除该前缀下所有键。`themeMode`、`userLanguage`、`pilotdeck-settings`、`codeEditor*`、`activeTab`、`pilotdeck-model`、`permissionMode-*`、`thinkingMode-*`、`draft_input_*`、`command_history_*`、`tasks-enabled` 全部经 `safeLocalStorage` 读写。`auth-token` 不加前缀。

- [ ] **Step 1: 写失败测试**

```tsx
// ui/src/components/auth/context/AuthContext.test.tsx
// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
beforeEach(() => { localStorage.clear(); vi.stubGlobal('fetch', fetchMock); vi.resetModules(); });
afterEach(() => { vi.unstubAllGlobals(); });
const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

function Probe() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { useAuth } = require('./AuthContext');
  const a = useAuth();
  return <div>{a.isLoading ? 'loading' : a.user ? `${a.user.username}:${a.user.role}:${a.isAdmin}` : `anon:${a.registrationOpen}`}</div>;
}

describe('AuthContext (multi-user)', () => {
  it('exposes registrationOpen when logged out', async () => {
    fetchMock.mockImplementation((url: string) => url.endsWith('/api/auth/status') ? json(200, { authDisabled: false, registrationOpen: true }) : json(404, {}));
    const { AuthProvider } = await import('./AuthContext');
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByText('anon:true')).toBeTruthy());
  });
  it('loads role from /api/auth/user and flags admins', async () => {
    localStorage.setItem('auth-token', 't');
    fetchMock.mockImplementation((url: string) => url.endsWith('/status') ? json(200, { registrationOpen: false }) : json(200, { user: { id: 1, username: 'admin', role: 'admin' } }));
    const { AuthProvider } = await import('./AuthContext');
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByText('admin:admin:true')).toBeTruthy());
  });
  it('clears the session on pilotdeck:auth-revoked', async () => {
    localStorage.setItem('auth-token', 't'); localStorage.setItem('u1:themeMode', 'dark');
    fetchMock.mockImplementation((url: string) => url.endsWith('/status') ? json(200, {}) : json(200, { user: { id: 1, username: 'alice', role: 'user' } }));
    const { AuthProvider } = await import('./AuthContext');
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByText('alice:user:false')).toBeTruthy());
    act(() => { window.dispatchEvent(new CustomEvent('pilotdeck:auth-revoked', { detail: { code: 'TOKEN_REVOKED' } })); });
    await waitFor(() => expect(screen.getByText(/^anon:/)).toBeTruthy());
    expect(localStorage.getItem('auth-token')).toBeNull();
    expect(localStorage.getItem('u1:themeMode')).toBeNull();
  });
});
```

```js
// ui/src/utils/api.auth.test.js
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
describe('authenticatedFetch auth handling', () => {
  let events;
  beforeEach(() => { localStorage.setItem('auth-token', 'old'); events = []; window.addEventListener('pilotdeck:auth-revoked', (e) => events.push(e.detail)); vi.resetModules(); });
  afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });
  it('clears the token and dispatches on a revoked 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'x', code: 'TOKEN_REVOKED' }), { status: 401 })));
    const { authenticatedFetch } = await import('./api.js');
    const res = await authenticatedFetch('/api/projects');
    expect(res.status).toBe(401);
    expect(localStorage.getItem('auth-token')).toBeNull();
    expect(events).toEqual([{ code: 'TOKEN_REVOKED' }]);
  });
  it('leaves the token alone on an unrelated 401 (e.g. BAD_CREDENTIALS) and on 403', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'ADMIN_REQUIRED' }), { status: 403 })));
    const { authenticatedFetch } = await import('./api.js');
    await authenticatedFetch('/api/config');
    expect(localStorage.getItem('auth-token')).toBe('old');
    expect(events).toEqual([]);
  });
  it('dispatches token-refreshed when the header is present', async () => {
    const refreshed = []; window.addEventListener('pilotdeck:token-refreshed', (e) => refreshed.push(e.detail.token));
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'X-Refreshed-Token': 'new' } })));
    const { authenticatedFetch } = await import('./api.js');
    await authenticatedFetch('/api/projects');
    expect(localStorage.getItem('auth-token')).toBe('new');
    expect(refreshed).toEqual(['new']);
  });
});
```

```tsx
// ui/src/contexts/WebSocketContext.close.test.tsx
// @vitest-environment jsdom
import { render, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
class FakeWS { static instances: FakeWS[] = []; onopen: any; onclose: any; onmessage: any; onerror: any; readyState = 1; url: string;
  constructor(url: string) { this.url = url; FakeWS.instances.push(this); } send() {} close() { this.onclose?.({ code: 1000 }); } }
beforeEach(() => { FakeWS.instances = []; vi.useFakeTimers(); vi.stubGlobal('WebSocket', FakeWS); vi.resetModules(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('WebSocketContext close codes', () => {
  it('does not reconnect after 4401 and dispatches auth-revoked', async () => {
    vi.doMock('../components/auth/context/AuthContext', () => ({ useAuth: () => ({ token: 't', user: { id: 1 } }) }));
    const events: unknown[] = []; window.addEventListener('pilotdeck:auth-revoked', (e: any) => events.push(e.detail));
    const { WebSocketProvider } = await import('./WebSocketContext');
    render(<WebSocketProvider><div /></WebSocketProvider>);
    expect(FakeWS.instances).toHaveLength(1);
    act(() => { FakeWS.instances[0].onclose({ code: 4401, reason: 'TOKEN_REVOKED' }); });
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(FakeWS.instances).toHaveLength(1);
    expect(events).toEqual([{ code: 'TOKEN_REVOKED' }]);
  });
  it('reconnects with backoff after an ordinary close', async () => {
    vi.doMock('../components/auth/context/AuthContext', () => ({ useAuth: () => ({ token: 't', user: { id: 1 } }) }));
    const { WebSocketProvider } = await import('./WebSocketContext');
    render(<WebSocketProvider><div /></WebSocketProvider>);
    act(() => { FakeWS.instances[0].onclose({ code: 1006 }); });
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(FakeWS.instances).toHaveLength(2);
  });
});
```

`chatStorage.spec.ts` 新增：`setStorageUserId(7)` 后 `safeLocalStorage.setItem('themeMode','dark')` 实际写入 `u7:themeMode`；切到 `setStorageUserId(8)` 后读不到；`clearStorageForUser(7)` 只删 `u7:` 前缀键；`auth-token` 不受影响。

- [ ] **Step 2: 运行确认失败**

Run: `npm --prefix ui test -- src/components/auth src/utils/api.auth.test.js src/contexts/WebSocketContext.close.test.tsx src/components/chat/utils/chatStorage.spec.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`api.js` `authenticatedFetch` 的 `.then` 内增加：

```js
    if (response.status === 401) {
      const clone = response.clone();
      clone.json().then((body) => {
        if (['TOKEN_REVOKED', 'USER_DISABLED', 'INVALID_TOKEN', 'USER_NOT_FOUND'].includes(body?.code)) {
          localStorage.removeItem('auth-token');
          window.dispatchEvent(new CustomEvent('pilotdeck:auth-revoked', { detail: { code: body.code } }));
        }
      }).catch(() => {});
    }
    if (refreshedToken) window.dispatchEvent(new CustomEvent('pilotdeck:token-refreshed', { detail: { token: refreshedToken } }));
```

（测试里 `await authenticatedFetch(...)` 后断言事件：`clone.json()` 是微任务，断言前加 `await Promise.resolve()`；若仍竞态，改为 `await` 读取 body 再返回 response。）`api.auth.changePassword` 用 `authenticatedFetch('/api/auth/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) })`。

`AuthContext.tsx`：
- state 增加 `registrationOpen`；`checkAuthStatus` 里 `setRegistrationOpen(Boolean(statusPayload?.registrationOpen))`；删除 `needsSetup` 分支（保留字段恒为 false 以兼容 types）。
- `useEffect` 监听三个事件：`pilotdeck:auth-revoked` → `clearStorageForUser(user?.id)` 后 `clearSession()`；`pilotdeck:token-refreshed` → `setToken(detail.token)`；用户变化时 `setStorageUserId(user?.id ?? null)`。
- `logout`：`try { await api.auth.logout(); } catch {}` → `window.dispatchEvent(new Event('pilotdeck:auth-logout'))` → `clearStorageForUser(user?.id)` → `clearSession()`。
- `changePassword(current, next)`：成功时 `setSession(user, payload.token)`（新令牌），返回 `{ success: true }`。
- `isAdmin = user?.role === 'admin'`。免登录模式分支里把假用户改为 `{ id: 'local', username: 'local-user', role: 'admin' }`。

`ProtectedRoute.tsx`：`if (!user) return <LoginForm />;`，删除 `needsSetup`。`LoginForm.tsx` 增加 `const { registrationOpen } = useAuth(); const [mode, setMode] = useState<'login'|'register'>('login');`，`mode === 'register'` 时渲染 `<RegisterForm onBack={() => setMode('login')} />`，否则在提交按钮下方渲染 `registrationOpen ? <button type="button" onClick={() => setMode('register')}>{t('login.registerLink')}</button> : null`。`SetupForm.tsx` 重命名为 `RegisterForm.tsx`（`git mv`），标题用 `t('register.title')`，提交调用 `register()`，加 `onBack` 返回链接；`SetupForm` 名字以 `export { default as SetupForm } from './RegisterForm'` 保留给旧引用。

`WebSocketContext.tsx` `onclose`：

```ts
websocket.onclose = (event) => {
  if (connectIdRef.current !== id) return;
  setIsConnected(false); wsRef.current = null;
  if (event.code === 4401 || event.code === 4403) {
    setReconnectInfo({ attempt: 0, nextRetryMs: 0, status: 'disconnected' });
    if (event.code === 4401) window.dispatchEvent(new CustomEvent('pilotdeck:auth-revoked', { detail: { code: event.reason || 'TOKEN_REVOKED' } }));
    return;
  }
  // …原退避逻辑
};
```

并在 provider 的 effect 里 `window.addEventListener('pilotdeck:auth-logout', () => { connectIdRef.current += 1; wsRef.current?.close(1000); })`。`useShellConnection.ts` 同样处理 4401/4403（4403 显示「仅管理员可用终端」提示，不重连）。

`chatStorage.ts`：

```ts
let storageUserId: string | number | null = null;
export const setStorageUserId = (id: string | number | null) => { storageUserId = id; };
const UNSCOPED = new Set(['auth-token']);
const scoped = (key: string) => (UNSCOPED.has(key) ? key : `${storageUserId == null ? 'anon' : `u${storageUserId}`}:${key}`);
export const clearStorageForUser = (id: string | number | null | undefined) => {
  const prefix = id == null ? 'anon:' : `u${id}:`;
  for (const k of Object.keys(localStorage)) if (k.startsWith(prefix)) localStorage.removeItem(k);
};
// safeLocalStorage.getItem/setItem/removeItem 内部统一用 scoped(key)
```

把 `ThemeContext.jsx`、`i18n/config.js`、`projectSortPreference.ts`、`useSettingsController.ts`、`useProjectsState.ts`、`useChatProviderState.ts`、`useChatComposerState.ts`、`useSlashCommands.ts`、`TasksSettingsContext.jsx`、`ChatInterfaceV2.tsx` 中的直接 `localStorage.*` 调用改为 `safeLocalStorage.*`（`grep -rn "localStorage\.\(get\|set\|remove\)Item(" ui/src --include=*.ts --include=*.tsx --include=*.js --include=*.jsx | grep -v chatStorage.ts | grep -v auth-token | grep -v test` 应为空）。主题与语言在登录前也要可用：它们在 `anon:` 下读写，登录后首次读不到就回退默认，这是可接受的。

`auth.json`（zh-CN）新增：`"login.registerLink": "没有账号？注册"`, `"register.back": "返回登录"`, `"register.closed": "注册已关闭，请联系管理员开通"`, `"password.title": "修改密码"`, `"password.current": "当前密码"`, `"password.new": "新密码"`, `"password.confirm": "确认新密码"`, `"password.submit": "更新密码"`, `"password.success": "密码已更新"`, `"errors.revoked": "登录已失效，请重新登录"`, `"errors.disabled": "该账号已被停用"`, `"errors.adminRequired": "仅管理员可用"`；`en` 对应英文。

- [ ] **Step 4: 验证**

Run: `npm --prefix ui test -- src/components/auth src/utils src/contexts src/components/chat/utils`；`npm --prefix ui run typecheck`；`npm --prefix ui run build`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add ui/src/components/auth ui/src/utils/api.js ui/src/utils/api.auth.test.js ui/src/contexts ui/src/components/chat/utils/chatStorage.ts ui/src/components/chat/utils/chatStorage.spec.ts ui/src/i18n/locales/zh-CN/auth.json ui/src/i18n/locales/en/auth.json ui/src/components/shell/hooks/useShellConnection.ts $(git diff --name-only ui/src | tr '\n' ' ')
git commit -m "feat(ui): 角色感知的认证上下文、注册入口、401/4401 下线处理、本地存储按用户命名空间"
```

---

### Task 8: 侧栏账号区、修改密码、角色化设置菜单

**Files:**
- Modify: `ui/src/components/app-shell/SidebarV2.tsx:1158-1170`
- Create: `ui/src/components/app-shell/SidebarAccountArea.tsx`
- Create: `ui/src/components/settings/view/account/index.tsx`、`ui/src/components/settings/view/account/ChangePasswordForm.tsx`
- Modify: `ui/src/components/settings/view/SettingsSidebar.tsx:13-36`、`ui/src/components/settings/view/SettingsContent.tsx:31-48`、`ui/src/components/settings/types.ts`、`ui/src/components/settings/Settings.tsx:146`
- Modify: `ui/src/i18n/locales/{zh-CN,en}/sidebar.json`、`settings.json`
- Test: `ui/src/components/app-shell/SidebarAccountArea.test.tsx`、`ui/src/components/settings/view/SettingsSidebar.test.tsx`、`ui/src/components/settings/view/account/ChangePasswordForm.test.tsx`

**Interfaces:**
- Consumes: `useAuth()` → `{ user, isAdmin, logout, changePassword }`（Task 7）
- Produces: `SidebarAccountArea`（用户名、角色标签「管理员/普通用户」、退出按钮；免登录模式下显示「本机模式」且无退出按钮）。
- Produces: `SettingsMenuKey` 增加 `'account' | 'users'`；`MENU_ITEMS` 变为函数 `getMenuItems(isAdmin: boolean)`：普通用户只得到 `account`、`general`、`agentMemory`（本人记忆）、`privacy`；管理员得到全部（含新 `users`，见 Task 9）。
- Produces: `Settings.tsx` 只在 `isAdmin` 时包 `PilotDeckConfigProvider`（普通用户不加载 `/api/config`；`agentMemory`、`privacy` 页面内凡是依赖 `usePilotDeckConfig` 的管理员字段，在非管理员下隐藏；需要 provider 存在的 hook 改为可选：provider 缺失时返回 `{ raw: null, loading: false, readOnly: true }`）。
- Produces: 账号页：显示用户名与角色、`ChangePasswordForm`（当前密码、新密码、确认；成功后提示并保持登录）。

- [ ] **Step 1: 写失败测试**

```tsx
// ui/src/components/app-shell/SidebarAccountArea.test.tsx
// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, o?: any) => o?.defaultValue ?? k }) }));
const logout = vi.fn();
vi.mock('../auth/context/AuthContext', () => ({ useAuth: () => ({ user: { id: 2, username: 'alice', role: 'user' }, isAdmin: false, logout, authDisabled: false }) }));
import SidebarAccountArea from './SidebarAccountArea';
describe('SidebarAccountArea', () => {
  it('shows username, role badge and a working logout', () => {
    render(<SidebarAccountArea onOpenAccount={() => {}} />);
    expect(screen.getByText('alice')).toBeTruthy();
    expect(screen.getByText('sidebar:account.roleUser')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'sidebar:account.logout' }));
    expect(logout).toHaveBeenCalled();
  });
});
```

```tsx
// ui/src/components/settings/view/SettingsSidebar.test.tsx
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
import { getMenuItems } from './SettingsSidebar';
describe('settings menu by role', () => {
  it('normal users see only account/general/agentMemory/privacy', () => {
    const keys = getMenuItems(false).flatMap((i) => (i.children ? i.children.map((c) => c.key) : [i.key]));
    expect(keys).toEqual(['account', 'general', 'agentMemory', 'privacy']);
  });
  it('admins see everything including users', () => {
    const keys = getMenuItems(true).flatMap((i) => (i.children ? i.children.map((c) => c.key) : [i.key]));
    expect(keys).toEqual(expect.arrayContaining(['account', 'users', 'modelPool', 'mcpServers', 'advanced', 'about']));
  });
});
```

```tsx
// ui/src/components/settings/view/account/ChangePasswordForm.test.tsx
// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
const changePassword = vi.fn(async () => ({ success: true }));
vi.mock('../../../auth/context/AuthContext', () => ({ useAuth: () => ({ changePassword }) }));
import ChangePasswordForm from './ChangePasswordForm';
describe('ChangePasswordForm', () => {
  it('validates confirmation and submits', async () => {
    render(<ChangePasswordForm />);
    fireEvent.change(screen.getByLabelText('password.current'), { target: { value: 'old1234' } });
    fireEvent.change(screen.getByLabelText('password.new'), { target: { value: 'new12345' } });
    fireEvent.change(screen.getByLabelText('password.confirm'), { target: { value: 'different' } });
    fireEvent.click(screen.getByRole('button', { name: 'password.submit' }));
    expect(changePassword).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('password.confirm'), { target: { value: 'new12345' } });
    fireEvent.click(screen.getByRole('button', { name: 'password.submit' }));
    await waitFor(() => expect(changePassword).toHaveBeenCalledWith('old1234', 'new12345'));
    expect(await screen.findByText('password.success')).toBeTruthy();
  });
});
```

```tsx
// ui/src/hooks/usePilotDeckConfig.noProvider.test.tsx  (Review Focus 3)
// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
describe('usePilotDeckConfig without a provider (normal user)', () => {
  it('returns a read-only empty state and never fetches /api/config', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { usePilotDeckConfig } = await import('./usePilotDeckConfig');
    const { result } = renderHook(() => usePilotDeckConfig());
    expect(result.current).toMatchObject({ raw: null, loading: false, readOnly: true });
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm --prefix ui test -- src/components/app-shell/SidebarAccountArea.test.tsx src/components/settings/view/SettingsSidebar.test.tsx src/components/settings/view/account src/hooks/usePilotDeckConfig.noProvider.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**

```tsx
// ui/src/components/app-shell/SidebarAccountArea.tsx
import { LogOut, ShieldCheck, User as UserIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/context/AuthContext';

export default function SidebarAccountArea({ onOpenAccount }: { onOpenAccount: () => void }) {
  const { t } = useTranslation();
  const { user, isAdmin, logout, authDisabled } = useAuth();
  if (!user) return null;
  return (
    <div className="flex items-center gap-2 px-3 py-2 text-[13px]">
      <button type="button" onClick={onOpenAccount} className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 hover:bg-accent" title={t('sidebar:account.open', { defaultValue: 'Account' }) as string}>
        {isAdmin ? <ShieldCheck className="h-4 w-4 shrink-0" /> : <UserIcon className="h-4 w-4 shrink-0" />}
        <span className="truncate font-medium">{user.username}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
          {authDisabled ? t('sidebar:account.localMode') : isAdmin ? t('sidebar:account.roleAdmin') : t('sidebar:account.roleUser')}
        </span>
      </button>
      {authDisabled ? null : (
        <button type="button" onClick={() => void logout()} aria-label={t('sidebar:account.logout') as string} title={t('sidebar:account.logout') as string} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground">
          <LogOut className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
```

`AuthContext` 需暴露 `authDisabled`（来自 `/status`，免登录模式为 true）。`SidebarV2.tsx` 在 Settings 按钮上方插入 `<SidebarAccountArea onOpenAccount={() => onShowSettings('account')} />`；`onShowSettings` 的签名扩成 `(initialTab?: string) => void`，`useProjectsState.ts:902` 与 `AppShellV2.tsx:381` 透传到 `<Settings initialTab=…>`（`mapInitialTabToMenuKey` 增加 `'account' → 'account'`、`'users' → 'users'`）。

`SettingsSidebar.tsx`：

```ts
export function getMenuItems(isAdmin: boolean): SettingsMenuItemI18n[] {
  const account = { key: 'account', labelKey: 'settingsPage.menu.account' } as const;
  if (!isAdmin) {
    return [account, { key: 'general', labelKey: 'settingsPage.menu.general' }, { key: 'agentMemory', labelKey: 'settingsPage.menu.agentMemory' }, { key: 'privacy', labelKey: 'settingsPage.menu.privacy' }];
  }
  return [account, ...MENU_ITEMS_ADMIN /* 原 MENU_ITEMS */, { key: 'users', labelKey: 'settingsPage.menu.users' }];
}
```

组件内 `const { isAdmin } = useAuth(); const items = useMemo(() => getMenuItems(isAdmin), [isAdmin]);`。`SettingsContent.tsx`：`MENU_TITLE_KEYS` 加 `account`、`users`；映射加 `account → <AccountSettings />`、`users → <UsersSettings />`（Task 9 提供，本任务先放占位组件并在 Task 9 替换）。`Settings.tsx:146`：`isAdmin ? <PilotDeckConfigProvider>{content}</PilotDeckConfigProvider> : content`；`usePilotDeckConfig()` 在无 provider 时不再抛错，返回只读空态（在 hook 内 `const ctx = useContext(...); if (!ctx) return READ_ONLY_EMPTY;`）。`agentMemory` 页：非管理员只渲染「本人记忆开关 + 查看/删除/导入导出」区块，隐藏模型与维护策略区块（按 `isAdmin` 条件渲染）。

`account/index.tsx`：用户名、角色、`ChangePasswordForm`。`ChangePasswordForm.tsx`：三个 `AuthInputField`（复用 auth 目录的组件，`label` 用 `t('auth:password.*')`，`id` 分别 `current-password`/`new-password`/`confirm-password`），本地校验（新密码 ≥6、两次一致），提交 `changePassword`，成功显示 `t('auth:password.success')`。

i18n：`sidebar.json` 增加 `account: { open: "账号", logout: "退出登录", roleAdmin: "管理员", roleUser: "普通用户", localMode: "本机模式" }`；`settings.json` 增加 `settingsPage.menu.account: "账号"`, `settingsPage.menu.users: "用户管理"`, `settingsPage.titles.account`, `settingsPage.titles.users`；`en` 对应。

- [ ] **Step 4: 验证**

Run: `npm --prefix ui test -- src/components/app-shell src/components/settings`；`npm --prefix ui run typecheck`；`npm --prefix ui run build`
Expected: PASS（既有 `SidebarV2.test.tsx` 可能需要 mock `useAuth`，在测试侧加 `vi.mock('../auth/context/AuthContext', …)`）

- [ ] **Step 5: 提交**

```bash
git add ui/src/components/app-shell ui/src/components/settings ui/src/hooks/useProjectsState.ts ui/src/hooks/usePilotDeckConfig.tsx ui/src/hooks/usePilotDeckConfig.noProvider.test.tsx ui/src/components/app-shell/AppShellV2.tsx ui/src/i18n/locales
git commit -m "feat(ui): 侧栏账号区与退出；账号页改密码；设置菜单按角色裁剪，普通用户不加载系统配置"
```

---

### Task 9: 管理员「用户管理」页

**Files:**
- Create: `ui/src/components/settings/view/users/index.tsx`、`ui/src/components/settings/view/users/useUsersAdmin.ts`、`ui/src/components/settings/view/users/CreateUserDialog.tsx`
- Modify: `ui/src/utils/api.js`（`api.admin.*`）、`ui/src/components/settings/view/SettingsContent.tsx`（替换 Task 8 的占位）
- Modify: `ui/src/i18n/locales/{zh-CN,en}/settings.json`
- Test: `ui/src/components/settings/view/users/useUsersAdmin.test.ts`、`ui/src/components/settings/view/users/UsersSettings.test.tsx`

**Interfaces:**
- Consumes: Task 5 的 `/api/admin/*`（`GET /users`、`POST /users`、`PATCH /users/:id`、`POST /users/:id/reset-password`、`DELETE /users/:id`、`GET/PUT /settings/registration`）
- Produces（api.js）:

```js
admin: {
  listUsers: () => authenticatedFetch('/api/admin/users'),
  createUser: (username, password, role) => authenticatedFetch('/api/admin/users', { method: 'POST', body: JSON.stringify({ username, password, role }) }),
  patchUser: (id, patch) => authenticatedFetch(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  resetPassword: (id) => authenticatedFetch(`/api/admin/users/${id}/reset-password`, { method: 'POST' }),
  deleteUser: (id) => authenticatedFetch(`/api/admin/users/${id}`, { method: 'DELETE' }),
  getRegistration: () => authenticatedFetch('/api/admin/settings/registration'),
  setRegistration: (allow) => authenticatedFetch('/api/admin/settings/registration', { method: 'PUT', body: JSON.stringify({ allowPublicRegistration: allow }) }),
}
```

- Produces（hook）: `useUsersAdmin() → { users, loading, error, registrationOpen, refresh, createUser, setRole, setActive, resetPassword, deleteUser, setRegistration }`；每个动作返回 `{ ok: true, data? } | { ok: false, code, message }`，`LAST_ADMIN` 与 `RESERVED_USERNAME` 映射为可读文案。
- Produces（页面）: 表格列：用户名、角色（下拉切换）、状态（启用/停用开关）、创建时间、最近登录、存储用量（`storageBytes` 格式化）、操作（重置密码 → 弹窗一次性显示新密码；删除 → 二次确认，说明「目录将归档」）；顶部：注册开关、「新建用户」按钮（弹窗：用户名、密码、角色）。对当前登录的管理员自己的行，降级与停用按钮带确认文案「这将使你自己退出登录」（Review Focus 5）。

- [ ] **Step 1: 写失败测试**

```ts
// ui/src/components/settings/view/users/useUsersAdmin.test.ts
// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const calls: Array<[string, RequestInit | undefined]> = [];
vi.mock('../../../../utils/api', () => ({
  api: { admin: {
    listUsers: () => (calls.push(['list', undefined]), Promise.resolve(new Response(JSON.stringify({ users: [{ id: 1, username: 'admin', role: 'admin', isActive: true, storageBytes: 10 }, { id: 2, username: 'alice', role: 'user', isActive: true, storageBytes: 20 }] })))),
    getRegistration: () => Promise.resolve(new Response(JSON.stringify({ allowPublicRegistration: true }))),
    patchUser: (id: number, patch: unknown) => (calls.push([`patch:${id}`, patch as any]), Promise.resolve(new Response(JSON.stringify({ error: 'x', code: 'LAST_ADMIN' }), { status: 409 }))),
    resetPassword: () => Promise.resolve(new Response(JSON.stringify({ password: 'Abc123XyZ987' }))),
    createUser: () => Promise.resolve(new Response(JSON.stringify({ user: { id: 3, username: 'bob', role: 'user', isActive: true } }), { status: 201 })),
    deleteUser: () => Promise.resolve(new Response(JSON.stringify({ archived: true }))),
    setRegistration: () => Promise.resolve(new Response(JSON.stringify({ allowPublicRegistration: false }))),
  } },
}));
import { useUsersAdmin } from './useUsersAdmin';
describe('useUsersAdmin', () => {
  beforeEach(() => { calls.length = 0; });
  it('loads users and registration flag', async () => {
    const { result } = renderHook(() => useUsersAdmin());
    await waitFor(() => expect(result.current.users).toHaveLength(2));
    expect(result.current.registrationOpen).toBe(true);
  });
  it('surfaces LAST_ADMIN as a readable error and does not mutate local state', async () => {
    const { result } = renderHook(() => useUsersAdmin());
    await waitFor(() => expect(result.current.users).toHaveLength(2));
    let outcome: any;
    await act(async () => { outcome = await result.current.setRole(1, 'user'); });
    expect(outcome).toMatchObject({ ok: false, code: 'LAST_ADMIN' });
    expect(result.current.users.find((u) => u.id === 1)?.role).toBe('admin');
  });
  it('returns the one-time password on reset', async () => {
    const { result } = renderHook(() => useUsersAdmin());
    await waitFor(() => expect(result.current.users).toHaveLength(2));
    let outcome: any;
    await act(async () => { outcome = await result.current.resetPassword(2); });
    expect(outcome).toMatchObject({ ok: true, data: { password: 'Abc123XyZ987' } });
  });
});
```

```tsx
// ui/src/components/settings/view/users/UsersSettings.test.tsx
// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, o?: any) => (o && typeof o === 'object' && 'count' in o ? `${k}:${o.count}` : k) }) }));
vi.mock('../../../auth/context/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, username: 'admin', role: 'admin' }, isAdmin: true }) }));
const setActive = vi.fn(async () => ({ ok: true }));
vi.mock('./useUsersAdmin', () => ({ useUsersAdmin: () => ({
  users: [{ id: 1, username: 'admin', role: 'admin', isActive: true, createdAt: '2026-10-01', lastLogin: null, storageBytes: 1024 }, { id: 2, username: 'alice', role: 'user', isActive: true, createdAt: '2026-10-02', lastLogin: null, storageBytes: 2048 }],
  loading: false, error: null, registrationOpen: true, refresh: vi.fn(), createUser: vi.fn(), setRole: vi.fn(), setActive, resetPassword: vi.fn(), deleteUser: vi.fn(), setRegistration: vi.fn(),
}) }));
import UsersSettings from './index';
describe('UsersSettings', () => {
  it('renders rows and asks for confirmation before deactivating yourself', async () => {
    render(<UsersSettings />);
    expect(screen.getByText('alice')).toBeTruthy();
    const toggles = screen.getAllByRole('switch', { name: 'settingsPage.users.active' });
    fireEvent.click(toggles[1]);                         // alice: no confirm
    await waitFor(() => expect(setActive).toHaveBeenCalledWith(2, false));
    fireEvent.click(toggles[0]);                         // admin (self): confirm dialog
    expect(screen.getByText('settingsPage.users.selfLockoutWarning')).toBeTruthy();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm --prefix ui test -- src/components/settings/view/users`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现**

```ts
// ui/src/components/settings/view/users/useUsersAdmin.ts
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../../utils/api';

export type AdminUser = { id: number; username: string; role: 'admin' | 'user'; isActive: boolean; createdAt?: string; lastLogin?: string | null; storageBytes?: number };
export type ActionResult<T = unknown> = { ok: true; data?: T } | { ok: false; code: string; message: string };

async function readResult<T>(res: Response): Promise<ActionResult<T>> {
  const body = await res.json().catch(() => ({}));
  if (res.ok) return { ok: true, data: body as T };
  return { ok: false, code: body?.code ?? `HTTP_${res.status}`, message: body?.error ?? res.statusText };
}

export function useUsersAdmin() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [u, r] = await Promise.all([api.admin.listUsers(), api.admin.getRegistration()]);
      const uj = await u.json(); const rj = await r.json();
      if (!u.ok) throw new Error(uj?.error ?? 'failed');
      setUsers(uj.users ?? []); setRegistrationOpen(Boolean(rj?.allowPublicRegistration));
    } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const after = <T,>(p: Promise<Response>) => p.then(readResult<T>).then(async (r) => { if (r.ok) await refresh(); return r; });
  return {
    users, loading, error, registrationOpen, refresh,
    createUser: (username: string, password: string, role: 'admin' | 'user') => after(api.admin.createUser(username, password, role)),
    setRole: (id: number, role: 'admin' | 'user') => after(api.admin.patchUser(id, { role })),
    setActive: (id: number, isActive: boolean) => after(api.admin.patchUser(id, { isActive })),
    resetPassword: (id: number) => api.admin.resetPassword(id).then(readResult<{ password: string }>),
    deleteUser: (id: number) => after(api.admin.deleteUser(id)),
    setRegistration: (allow: boolean) => after(api.admin.setRegistration(allow)),
  };
}
```

`index.tsx`：表格 + 顶部开关与新建按钮；状态开关 `role="switch"` 且 `aria-label={t('settingsPage.users.active')}`；对 `user.id === me.id` 的行，停用/降级前先设置 `confirm = { kind, id }` 并渲染内联确认块（文案 `settingsPage.users.selfLockoutWarning`，按钮确认/取消）；重置密码成功后弹出只读输入框显示一次性密码，附「复制」按钮；删除前确认块说明 `settingsPage.users.deleteExplain`（目录归档到 `archives/users/`）。`storageBytes` 用现有的字节格式化工具（`grep -rn "formatBytes" ui/src` 找到后复用，没有就在本目录写一个 8 行的）。`CreateUserDialog.tsx`：用户名、密码、角色下拉；`RESERVED_USERNAME`/`USERNAME_TAKEN`/`WEAK_CREDENTIALS` 映射为 `settingsPage.users.errors.*`。

`SettingsContent.tsx` 把 Task 8 的占位换成 `<UsersSettings />`。`settings.json`（zh-CN）新增 `settingsPage.users.{title, newUser, username, role, roleAdmin, roleUser, active, createdAt, lastLogin, storage, actions, resetPassword, resetDone, copy, delete, deleteExplain, confirm, cancel, selfLockoutWarning, registration, registrationOn, registrationOff, errors.{LAST_ADMIN, RESERVED_USERNAME, USERNAME_TAKEN, WEAK_CREDENTIALS, generic}}`；`en` 对应。

- [ ] **Step 4: 验证**

Run: `npm --prefix ui test -- src/components/settings`；`npm --prefix ui run typecheck`；`npm --prefix ui run build`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add ui/src/components/settings/view/users ui/src/components/settings/view/SettingsContent.tsx ui/src/utils/api.js ui/src/i18n/locales
git commit -m "feat(ui): 管理员用户管理页（列表、创建、角色、停用、重置密码、删除、注册开关）"
```

---

### Task 10: 回归、脚本化冒烟与人工走查清单

**Files:**
- Modify: `ui/server/multiUser.isolation.test.js`（新增迁移后隔离与门禁联动用例）
- Create: `scripts/smoke-multi-user.sh`（脚本化冒烟，隔离端口，供人复跑）
- Modify: `docs/superpowers/plans/2026-10-15-multi-user-migration-admin-frontend.md`（本节末尾填写执行记录，由执行者完成后追加）

**Interfaces:**
- Consumes: Task 1–9 全部产出
- Produces: `bash scripts/smoke-multi-user.sh [--root /tmp/pd-plan2] [--port 3151] [--gateway-base 19200]`，步骤全部断言失败即非零退出；默认不触碰 `.pilotdeck-home`

- [ ] **Step 1: 扩展隔离测试**

在 `multiUser.isolation.test.js` 增加：
- `legacy data migrated at boot lands in admin's home only`：在临时根预置旧布局（复用 `legacyMigration.test.js` 的 `seedLegacyRoot`），走完整启动序列（`initializeDatabase → ensureAdminUser → migrateLegacyStorage`），然后以 admin 列项目能看到旧病例，以 alice 看不到；根目录无 `projects/`。
- `revoked user loses chat and shell sockets`：两个假 socket（`SOCKET_USER_ID` 分别为 alice 的 id，一个放 `connectedClients` 一个放 `auxClients`），调用 `closeUserSockets` 两次后都被 4401 关闭。
- `normal user cannot reach system config even through the settings page endpoints`：`GET /api/config`、`GET /api/memory/settings`、`PUT /api/plugins/med-tools/enable` → 403。

- [ ] **Step 2: 写冒烟脚本**

```bash
#!/usr/bin/env bash
# scripts/smoke-multi-user.sh — isolated end-to-end smoke; never touches .pilotdeck-home
set -euo pipefail
ROOT=/tmp/pd-plan2; PORT=3151; GW=19200
while [ $# -gt 0 ]; do case "$1" in --root) ROOT=$2; shift 2;; --port) PORT=$2; shift 2;; --gateway-base) GW=$2; shift 2;; *) echo "unknown arg $1"; exit 1;; esac; done
REPO=$(cd "$(dirname "$0")/.." && pwd)
rm -rf "$ROOT"; mkdir -p "$ROOT"
cp "$REPO/.pilotdeck-home/pilotdeck.yaml" "$ROOT/"; ln -s "$REPO/.pilotdeck-home/plugins" "$ROOT/plugins"
# seed a legacy layout so the boot-time migration is exercised
mkdir -p "$ROOT/projects/general_med/general_med-legacy1" "$ROOT/memory/global"; echo '{"type":"general_medicine","displayName":"旧病例"}' > "$ROOT/projects/general_med/general_med-legacy1/meta.json"
export PILOT_HOME="$ROOT" SERVER_PORT=$PORT PILOTDECK_GATEWAY_PORT_BASE=$GW PILOTDECK_DISABLE_LOCAL_AUTH=0 PILOTDECK_ADMIN_PASSWORD=adminpass
( cd "$REPO" && nohup npm --prefix ui run dev:server > "$ROOT/server.log" 2>&1 & echo $! > "$ROOT/server.pid" )
for i in $(seq 1 60); do curl -sf "localhost:$PORT/api/auth/status" >/dev/null && break; sleep 1; done
fail() { echo "SMOKE FAIL: $*"; kill -TERM "$(cat "$ROOT/server.pid")" 2>/dev/null || true; exit 1; }
json() { node -pe "JSON.parse(require('fs').readFileSync(0,'utf8'))$1"; }
post() { curl -s -X POST "localhost:$PORT$1" -H 'content-type: application/json' ${3:+-H "Authorization: Bearer $3"} -d "$2"; }
get()  { curl -s "localhost:$PORT$1" -H "Authorization: Bearer $2"; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

ADM=$(post /api/auth/login '{"username":"admin","password":"adminpass"}' | json .token)
A=$(post /api/auth/register '{"username":"alice","password":"secret1"}' | json .token)
B=$(post /api/auth/register '{"username":"bob","password":"secret1"}' | json .token)
[ -f "$ROOT/system/migration/legacy-done.json" ] || fail "migration marker missing"
[ ! -d "$ROOT/projects" ] || fail "legacy projects/ still at root"
get /api/projects "$ADM" | grep -q '旧病例' || fail "admin cannot see migrated legacy project"
get /api/projects "$A"   | grep -q '旧病例' && fail "alice can see admin's legacy project"
post /api/projects/create-system '{"displayName":"病例A","type":"general_medicine"}' "$A" >/dev/null
[ "$(ls "$ROOT/users/" | wc -l | tr -d ' ')" -ge 3 ] || fail "expected admin+alice+bob homes"
[ "$(code localhost:$PORT/api/config -H "Authorization: Bearer $A")" = 403 ] || fail "user reached /api/config"
[ "$(code localhost:$PORT/api/config -H "Authorization: Bearer $ADM")" = 200 ] || fail "admin blocked from /api/config"
get /api/config "$ADM" | grep -q 'sk-' && fail "api key leaked in /api/config"
BOB_ID=$(get /api/admin/users "$ADM" | json ".users.find(u=>u.username==='bob').id")
node -e "
const WebSocket=require('$REPO/ui/node_modules/ws');const ws=new WebSocket('ws://localhost:$PORT/ws?token=$B');
ws.on('open',()=>{require('fs').writeFileSync('$ROOT/ws-open','1')});ws.on('close',(c)=>{require('fs').writeFileSync('$ROOT/ws-close',String(c));process.exit(0)});setTimeout(()=>process.exit(2),20000);" &
WSPID=$!; for i in $(seq 1 20); do [ -f "$ROOT/ws-open" ] && break; sleep 0.5; done
curl -s -X PATCH "localhost:$PORT/api/admin/users/$BOB_ID" -H "Authorization: Bearer $ADM" -H 'content-type: application/json' -d '{"isActive":false}' >/dev/null
wait $WSPID || true; [ "$(cat "$ROOT/ws-close" 2>/dev/null)" = 4401 ] || fail "bob's socket not closed with 4401"
[ "$(code localhost:$PORT/api/projects -H "Authorization: Bearer $B")" = 401 ] || fail "bob still authorized"
kill -TERM "$(cat "$ROOT/server.pid")"; for i in $(seq 1 30); do kill -0 "$(cat "$ROOT/server.pid")" 2>/dev/null || break; sleep 1; done
[ "$(cat "$ROOT/system/gateway-pids.json")" = "{}" ] || fail "pid file not empty after shutdown"
pgrep -f "$ROOT" >/dev/null && fail "leftover gateway process"
# no-login mode on the same root: admin's data is visible without a token
unset PILOTDECK_DISABLE_LOCAL_AUTH
( cd "$REPO" && nohup npm --prefix ui run dev:server > "$ROOT/server2.log" 2>&1 & echo $! > "$ROOT/server.pid" )
for i in $(seq 1 60); do curl -sf "localhost:$PORT/api/auth/status" >/dev/null && break; sleep 1; done
curl -s "localhost:$PORT/api/projects" | grep -q '旧病例' || fail "no-login mode does not show admin's projects"
kill -TERM "$(cat "$ROOT/server.pid")"; sleep 3
echo "SMOKE OK"
```

- [ ] **Step 3: 运行**

Run: `npm --prefix ui run test:isolation && npm --prefix ui test && npm --prefix ui run typecheck && npm --prefix ui run build && npm test && bash scripts/smoke-multi-user.sh`
Expected: 全部通过，脚本打印 `SMOKE OK`。执行时不要设 `PILOTDECK_SKIP_BOOTSTRAP`（它会让两个配置引导用例失败）。

- [ ] **Step 4: 人工走查清单（留给使用者）**

1. `start-local` 启动后，旧对话与病例回到界面；侧栏底部出现账号区显示 `admin / 本机模式`。
2. 另开隔离根（上面的脚本留下的 `/tmp/pd-plan2`，`PILOTDECK_DISABLE_LOCAL_AUTH=0`）：登录页出现「注册」，两个浏览器各注册一人，各自只见自己的项目；发一条消息走通真实模型。
3. 管理员设置页出现「用户管理」，停用其中一人，其页面立刻回到登录页。
4. 普通用户设置页只有账号 / 通用 / 记忆 / 隐私四项，改密码后仍保持登录。
5. 管理员页里「模型池」「MCP」「关于 / 更新」正常；浏览器控制台没有 403 报错刷屏。

- [ ] **Step 5: 提交**

```bash
git add ui/server/multiUser.isolation.test.js scripts/smoke-multi-user.sh
git commit -m "test(multi-user): 迁移与门禁回归用例；脚本化端到端冒烟"
```

---

## 完成标准

- Task 1–10 全部勾选；`npm --prefix ui test`、`npm --prefix ui run typecheck`、`npm --prefix ui run build`、`npm test` 通过；`scripts/smoke-multi-user.sh` 打印 `SMOKE OK`。
- 使用者按 Task 10 Step 4 走查五步无异常。
- 明确不在本计划：用户目录沙箱（spec §16，计划三）；Agent 工具权限策略（spec §17，多用户完成后再议）；跨用户记忆、共享技能、SSO（spec §1.3）。

## 执行记录（2026-10-15，subagent-driven 执行，分支 feat/multi-user-v2，提交范围 b0a9ffb..33de507）

全部 10 个任务完成，每个任务经独立评审（spec 符合性 + 代码质量）与修复循环；Task 1、2、5、7、8、10 各走了一轮修复，Task 3、4、6、9 首评即通过。整分支终审：一轮（opus）给出 APPROVED WITH FIXES：1 Critical + 3 Important + 7 Minor；单轮修复（5 个提交 4a5020a..33de507）后定向复审全部通过，无新增 Critical/Important。验证：UI 套件 148 文件 / 1070 通过，引擎套件 661 通过，typecheck（含模块级 home 扫描）通过，UI build 通过，`scripts/smoke-multi-user.sh` 在隔离根 `/tmp/pd-plan2`（端口 3151 / 19200+）上打印 `SMOKE OK`。使用者的 `.pilotdeck-home` 与 3020/5170/18800 全程未触碰。

### 执行期间的裁决（按时间顺序，每条含出错代价）

- Ruling: work directly in this checkout on feat/multi-user-v2 (same as Plan 1) — the user's dev server runs from here on 3020/5170/18800; all implementer boots use /tmp roots and ports 3151+/19200+ — cost if wrong: an intermediate commit lands on the branch the dev server runs from (recoverable).
- Ruling: `seedLegacyRoot()` lives in a shared test helper `ui/server/testUtils/legacyRoot.js` created in Task 1 and imported by both legacyMigration.test.js and multiUser.isolation.test.js — why: T10 cannot import from another test file — cost if wrong: none.
- Ruling: migrate-user-storage.mjs exits 0 when `--assign-admin` was given (promotion done or planned) even if there is no legacy data to move; exit 2 "nothing-to-do" only applies when no promotion was requested — why: the brief's test 3 requires it and a promotion is itself useful work — cost if wrong: operators scripting on exit codes see 0 for "only promoted".
- Ruling (plan defect, Task 1): the migration snapshot dir lives inside legacy `archives/`, so snapshotting/moving `archives/` would recurse into itself → `archives/legacy-*` excluded from snapshot/move/detect (+test); conflict archives get a unique suffix on re-run; file/dir type mismatches are archived, not thrown — cost if wrong: an operator-created `archives/legacy-*` entry is never migrated.
- Resolved by controller (Task 1): reviewer flagged "renamed general container unreadable until pilotPaths defaults re-scope" — Plan 1 Task 7 already resolves request-time paths via resolveScopedHome(); no action.
- Ruling (Task 2): `--dry-run` must be zero-write → db-free `legacyLayout.js` split out; dry-run never imports db.js; `--seed-user-for-test` only honoured under NODE_ENV=test; parseArgs errors reported as JSON; Docker-generated config sets `router.stats.enabled: false` — cost if wrong: none (behaviour-preserving split).
- Ruling (Task 5): non-admin callers of /api/memory/snapshot and /overview get only `{ enabled }` under settings (policy fields stripped) — why: spec D10 "维护策略全部管理员" — cost if wrong: a normal user's memory page must not render policy fields (Task 8 hides them).
- Ruling (Task 5→6): shell-socket revocation (Important #4 of the Task 5 review) carried to Task 6's `auxClients` instead of a Task 5 fix round — why: Task 6 owns that wiring — cost if wrong: one task window where a revoked admin's shell socket stays open.
- Ruling (Task 7): one-time marker-gated migration moves all unprefixed non-UNSCOPED localStorage keys into the first logged-in user's namespace (`pilotdeck-storage-migrated-v1`) — why: user-authored drafts/renames are not re-derivable; on single→multi upgrade the first login is the incumbent — cost if wrong: on a shared browser the first person to log in after upgrade inherits the previous single user's local prefs/drafts.
- Ruling (Task 7 Critical fix): the server closes the caller's own socket with 4401 on logout and password change; the frontend treats 4401 as a revoke only outside a 5 s "expected revoke" window, the 401 handler only deletes the token when it equals the one that failed, and logout never wipes the `anon:` namespace — cost if wrong: a genuine revoke arriving inside the window is handled on the next request instead of instantly.
- Ruling (Task 8): the two remaining non-admin `/api/config` reads (i18n alwaysOn language sync; thinking-model context) are role-gated through an in-memory `setStorageUserRole/getStorageUserRole` in safeStorage, set from AuthContext — why: both modules live outside React context; a 403 per language change is noise and a leak signal — cost if wrong: non-admins lose the always-on language sync (admin-only feature anyway).
- Ruling (Task 8 fix): the Office preview status fallback that hits `/api/config` runs only for admins — cost if wrong: non-admins see the default preview status when the dedicated endpoint fails.
- Ruling (Task 9): reset-password is disabled on the acting admin's own row (a self-reset would revoke the acting session); use the account page instead — cost if wrong: none.
- Resolved by controller (Task 10): the plan-doc execution record is appended by the controller at finish (as in Plan 1), not by the Task 10 implementer.
- Ruling (Task 10 fix): the smoke script only kills pids it recorded (`server.pid`, `node.pid`, `gw.pids`), sets `OWNED=1` only after the busy-port pre-flight passes, validates `--root` (absolute, under TMPDIR or /tmp, not the repo, not `/tmp` itself), keeps the root and tails 60 log lines on failure, and skips the masking assertion with a notice when the yaml holds no `sk-` key — cost if wrong: none.

### 终审
终审发现与处理（提交范围 406a1cb..33de507）：

- C1（Critical，已修）：迁移只检查 `legacy-done.json`，没有实现 spec §9.1 的「`users/` 为空」门禁，且整个 `archives/` 被列为搬入项；一个天生多用户的系统在管理员删除用户后重启，会把 `archives/users/<id>-*` 整体搬进管理员目录。修复：`users/` 下除 `users/<adminId>` 外有任何条目即跳过；`archives` 改为只搬 `archives/projects` 子目录，其他子项原地不动；脚本 dry-run 同步。
- I1（Important，已修）：快照没有硬链接层，`COPYFILE_FICLONE` 在 ext4/overlay 上静默退化为整份复制。修复：逐文件 `link`，失败才 `copyFile`；复制前先打印条目数。注意：硬链接意味着快照与搬入后的文件共享 inode，原地改写会同步改到快照（spec §9.2 原文如此，可接受）。
- I2（Important，按裁决有界修复）：旧 `auth.db` 仅导入 session_names。修复：旧库恰有一个账号（免登录时代的 `local`）时把它的 `api_keys` 与 `user_credentials` 导入管理员；多账号则打印醒目警告（仅列用户名），账号需管理员重建。保留「归档 + 导入」而非 spec §9.2 第 3 步的整文件搬移（与 §9.1 的初始化顺序冲突，已记为偏差）。
- I3（Important，已修）：UI 服务端自己执行的 git 命令没有带 `GIT_CONFIG_GLOBAL`，容器内提交会报 Author identity unknown；升级前保存的身份也没有回填。修复：`services/userGitConfig.js`，`routes/git.js` 的每次 git spawn 注入用户 `.gitconfig`，`GET /git-config` 与提交前惰性回填；不 include 宿主机全局配置。
- M1/M2/M3/M4(最小)/M6/M7（已修）：无变化的 PATCH 不再吊销；DELETE 先等待该用户 Gateway 停止再搬目录；office-preview 状态对普通用户不再返回宿主机路径；保留清理前打印将删除的归档名；git 姓名只禁换行；免登录模式隐藏「用户管理」。
- M5（搁置）：管理员用户列表同步遍历全部目录统计体积（60 s 缓存）；spec §5.6 要求异步可缓存。
- §10.5 存储页「立即清空」按钮与待删条目数（搁置）：本计划只加了删除前日志。
- D12 偏差（保留）：CLI/TUI 在多用户根下自动落到管理员目录而非提示退出（计划文件表已认可；能跑 CLI 的人本就拥有服务账号）。

定向复审后搁置的残留小项（未阻塞）：
- 迁移中断后重跑，`user_credentials` 会重复导入（该表无唯一约束，`INSERT OR IGNORE` 不去重）；建议先查后插并包事务。
- `.gitconfig` 回填不再校验旧库里的 git 姓名/邮箱；若旧行含换行，该用户的所有 git 命令会报 bad config line（应在 `ensureUserGitConfigFile` 内校验后再写）。
- 快照复制退化到 `copyFile` 时遇到 FIFO 可能阻塞（仅跨文件系统且 `.tmp/` 内有 FIFO 时）。
- `hasOtherUserHomes` 对 `users/` 下任何杂项（含 `.DS_Store`）都会跳过迁移并只打一行日志。

### 交给计划三 / 后续的事项

- 插件通道未按用户隔离：`/plugin-ws/<name>` 与 `/api/plugins/:name/rpc/*` 是任何已登录用户进入共享插件进程的通道（计划一已有；spec D10/§16 的后续）。
- 被吊销管理员的分离式 shell PTY 可存活至 PTY_SESSION_TIMEOUT（30 min），且 PTY key 不含用户分量（任一管理员可重连）→ 在 4401 时杀 PTY 并按用户建 key。
- `plugins` 符号链接给了 Gateway 一条到 `<root>/pilotdeck.yaml` 的词法路径 → 计划三的 realpath 校验需求（已记入 spec §16.2）。
- `commands.js` 的 `/model`、`/cost`、`/status` 向普通用户暴露 provider id 与模型名；`/update` 检查执行固定 `git fetch`（D10 后续）。
- `maskRawYamlText` 按行锚定：block scalar / flow map / 被 YAML 截断的错误行可逃逸（仅管理员可见的面）。
- 带碰撞后缀的归档目录 `<id>-<ts>-<base36>` 永不过期（保留正则锚定在 `Z$`）。
- 普通用户 RegisterForm 直接渲染英文服务端错误串 → 按 code 映射 i18n。
- 旧用户此前保存过的 git 身份没有回填到 `.gitconfig`（需手动再保存一次）。

### 各任务评审中记录的次要问题（未阻塞合并）

- Task 1: a persistent migration failure mints a fresh full snapshot per boot (cheap on APFS via FICLONE, costly on plain copy; prior snapshots are copied into the new one); EXDEV cross-device moves fail closed with no copy fallback; spurious `skip/already-migrated` records for skeleton-created entries; no test for -wal/-shm sidecar archiving; swallowed rmdir remains (backstopped by assertNoResidue); no server-startup test pins the startup order.
- Task 2: existing-DB dry-run WAL branch likely untested; dry-run copy not atomic vs a live writer; `--dry-run` + `--seed` silently ignores seed; router stats (stats.jsonl) still create `router/` when `router.stats.enabled` is true (per-user under the pool; default off).
- Task 3: homeGuard edge cases (stale pointer dir, empty pointer, `~` root) unpinned; admin-home write failure aborts startup (acceptable); pre-existing `gatewaySetup.ts` saveWeixinCredentials mkdirs `~/.pilotdeck` but writes to weixinCredsPath().
- Task 4: retention test gaps (home-itself rejection, symlinked roots, tool-results untouched, stale .N prune, overlap guard); empty-dir removal has no age floor; float/near-zero retention values accepted; UI temp cleanup untested; retention config captured at start (no hot reload).
- Task 5: DELETE user rename failure after deactivation → bare 500 (return archived:false instead); no self-target guard on DELETE/PATCH server-side (UI guards); last disabled admin's home can be archived.
- Task 6: `readySince` is cumulative-from-ready (looser than "持有租约累计"); trackAuxSocket runs before plugin-name validation (harmless).
- Task 7: token-refresh reconnect drops frames emitted during the handshake window; shell 4401 sets no deniedRef; a stale-token 401 on page load wipes preferences (spec-compliant but punitive — consider splitting cache vs preferences); legacy-key migration has no per-key try/catch (quota failure mid-loop leaves the marker unset); no test for legacy+anon coexisting; expected-revoke window never cleared (harmless).
- Task 8: admin's first-load always-on language mirror skipped because role is null at i18n init; useChatProviderState config fetch has `[]` deps (relies on ProtectedRoute remount); READ_ONLY config controller save() is a silent no-op.
- Task 9: isSelf uses strict `===` between number|string auth id and number API id (use String() both sides); create dialog lacks client-side ≥3/≥6 validation; no loading/empty state; refresh ignores getRegistration failure; stale actionError not cleared on cancel; dialogs lack focus trap/Escape; third private formatBytes copy.
- Task 10: sockets test re-implements the index.js two-set sweep (cannot catch removal of the auxClients line); if boot 1 never comes up only the npm wrapper pid is recorded (node child could be orphaned); the `sk-` masking assertion is skipped on the repo yaml (no key present) so key masking is not exercised by the smoke today.
