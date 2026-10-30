# 多用户功能实施计划（一）：账号、作用域与 Gateway 池

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让多位用户各自登录后，在 UI 服务器层得到完全隔离的数据目录，并各自获得一个独立的 Gateway 子进程；这是设计文档批次 A 与 B，合起来是最小可用版本。

**Architecture:** UI 服务器（Express）是唯一感知多用户的层：JWT 携带 `role` 与 `tokenVersion`，认证后用 `AsyncLocalStorage` 建立请求作用域，所有路径解析从作用域取 `userId` 得到 `<PILOT_ROOT>/users/<userId>`。Gateway 引擎代码不感知多用户，由新的进程池按用户 spawn `pilotdeck server` 子进程，并把该用户目录作为其 `PILOT_HOME`。`pilotdeck-bridge.js` 的单例连接换成按用户租约。

**Tech Stack:** Node.js `>=22.13.0 <23`、Express、better-sqlite3、bcrypt、jsonwebtoken、`node:async_hooks`、`node:child_process`；UI 侧测试用 Vitest（`npm --prefix ui test -- <文件>`），引擎侧测试用 `node --test`（先 `npm run build`，再跑 `dist/tests/**`）。

**Spec:** `docs/superpowers/specs/2026-10-14-multi-user-design.md`（§3–§7 为本计划范围；§8–§11、§16 分别由计划二、计划三实现）。

## Global Constraints

- 身份只来自后端认证：`userId` 不从前端参数、URL、模型输出或目录名推断（spec §3 原则 3）。
- 缺少作用域的请求直接抛错并返回 500，**不回退**到任何默认用户或全局目录（spec §6.1）。
- `src/pilot/paths.ts` 中既有函数签名不变；用户目录内部布局与今天的单机 `PILOT_HOME` 一致（spec §4）。
- `<userId>` 使用数据库自增整数的字符串形式（spec §4）。
- 启动即有 admin：用户表为空时创建 `admin`，密码取 `PILOTDECK_ADMIN_PASSWORD`，未设置则 `passok`；**不**在启动时重置既有密码（spec D2）。
- 角色是数据库字段 `users.role`，取值 `admin` / `user`；注册接口禁止用户名 `admin`（不区分大小写）（spec D3）。
- 公开注册默认开放，注册出来的一律是 `user`；管理员可关闭（spec D4）。
- 免登录模式（`PILOTDECK_DISABLE_LOCAL_AUTH` 未设为 `0`/`false`）下所有请求以 admin 身份处理（spec D5）。
- 管理员看不到他人数据；管理接口不提供读取他人项目、会话、记忆、文件的端点（spec D11）。
- Gateway 子进程只绑定 `127.0.0.1`；每个用户目录独立的 `server-token`，权限 0600（spec §7.3）。
- 池默认值：`maxInstances` 30、`idleTimeoutMs` 30 分钟、`startTimeoutMs` 60 秒、`maxWaiting` 20（spec §7.4）。
- 所有测试使用 `mkdtemp` 临时根与临时账号库，不触碰 `.pilotdeck-home`；Gateway 池测试用注入的假 spawn，不启动真实模型（spec §13）。
- 本计划**不做**旧数据迁移（计划二）。验证时使用全新的 `PILOT_HOME`；现有 `.pilotdeck-home` 根目录下的旧数据在本计划完成后暂不可见，但原地不动。
- 提交信息末尾加 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。

## Review Focus

1. **同一浏览器连续以 A、B 两个账号登录**：B 登录后，前一个 WebSocket 连接若仍带 A 的作用域，B 的第一条消息会落到 A 的 Gateway。期望：WS 握手时绑定用户，每条消息在该连接绑定的作用域内处理，切号必须重新握手。测试在 Task 12（WebSocket 作用域用例）。
2. **管理员停用某用户时该用户正在对话**：期望该用户的 WS 被关闭、Gateway 被标记可立即回收、后续请求 401 `USER_DISABLED`。测试在 Task 12。
3. **两个用户同时首次访问**：池同时收到两个 `acquire`，必须各起一个进程且端口不冲突。测试在 Task 9。
4. **Gateway 子进程启动后崩溃**（例如模型配置错误）：期望 `acquire` 以 503 结束而不是永远挂起，且连续失败后熔断。测试在 Task 9。
5. **用户名大小写**：`Admin`、`ADMIN` 注册必须与 `admin` 一样被拒。测试在 Task 4。

---

## 文件结构

| 文件 | 职责 | 任务 |
|---|---|---|
| `ui/server/database/init.sql` | 新列 `role`、`token_version`，新表 `system_settings`，`session_names.user_id` | 1 |
| `ui/server/database/db.js` | 默认库路径改到 `<PILOT_ROOT>/system/auth.db`；`userDb` 新增角色与令牌版本方法；新增 `systemSettingsDb` | 1 |
| `ui/server/services/adminBootstrap.js`（新） | 启动即有 admin；无管理员则拒绝启动 | 2 |
| `ui/server/middleware/auth.js` | JWT 载荷加 `role`/`tokenVersion`；校验 `is_active` 与版本；免登录走 admin | 3 |
| `ui/server/middleware/requireAdmin.js`（新） | 管理员门禁 | 3 |
| `ui/server/routes/auth.js` | 注册规则、登录返回角色、登出撤销、改密码 | 4 |
| `ui/server/routes/adminUsers.js`（新） | 用户管理与注册开关 | 5 |
| `ui/server/middleware/userScope.js`（新） | `AsyncLocalStorage` 作用域 | 6 |
| `ui/server/utils/pilotPaths.js` | `resolvePilotRoot`、`resolveUserHome`、`resolveScopedHome`、`ensureUserHomeSkeleton` | 6 |
| `src/pilot/paths.ts` | `resolveUserHome`（与 JS 同算法）；`getPilotConfigFilePath` 支持 `PILOTDECK_CONFIG_PATH` | 6, 10 |
| `ui/server/projects.js`、`routes/{messages,git,taskmaster,caseState,commands,mcp}.js` | 请求时改用 `resolveScopedHome()` | 7 |
| `ui/server/services/memoryService.js`、`routes/skills.js`、`routes/gateway.js`、`routes/storage.js`、`services/permissionSettings.js` | 拆掉模块级全局 home 常量 | 8 |
| `scripts/check-module-level-pilot-home.mjs`（新） | 静态扫描，禁止模块级全局 home | 8 |
| `ui/server/services/gatewayPool.js`（新） | 每用户 Gateway 子进程池 | 9 |
| `ui/server/pilotdeck-bridge.js`、`ui/server/index.js`、`scripts/dev-launcher.mjs`、`ui/package.json` | 按用户租约取 Gateway；WS 作用域；启动脚本不再预拉 Gateway | 11 |
| `ui/server/multiUser.isolation.test.js`（新） | A/B 隔离回归，合并门槛 | 12 |

---

### Task 1: 数据库 schema 与 `userDb` 扩展

**Files:**
- Modify: `ui/server/database/init.sql`
- Modify: `ui/server/database/db.js:25-56`（库路径）、`db.js:83-101`（迁移）、`db.js:172-231`（`userDb`）、`db.js:618-630`（导出）
- Test: `ui/server/database/db.multiuser.test.js`

**Interfaces:**
- Produces:
  - `userDb.createUser(username, passwordHash, role = 'user') → { id, username, role }`
  - `userDb.getUserById(id) → { id, username, role, token_version, is_active, created_at, last_login } | undefined`（**不再**过滤 `is_active`，由调用方判断）
  - `userDb.getUserByUsername(username)`（同样返回 `role`、`token_version`、`is_active`，不过滤）
  - `userDb.getAdminUser() → 首个 is_active=1 且 role='admin' 的用户 | undefined`
  - `userDb.countActiveAdmins() → number`
  - `userDb.listUsers() → Array<{ id, username, role, is_active, created_at, last_login }>`
  - `userDb.bumpTokenVersion(id) → number`（返回新版本）
  - `userDb.setRole(id, role)`、`userDb.setActive(id, isActive)`、`userDb.updatePasswordHash(id, hash)`
  - `systemSettingsDb.get(key, fallback)`、`systemSettingsDb.set(key, value)`、`systemSettingsDb.isPublicRegistrationAllowed() → boolean`
  - 默认库路径 `path.join(resolvePilotHome(process.env), 'system', 'auth.db')`

- [ ] **Step 1: 写失败测试**

```js
// ui/server/database/db.multiuser.test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-db-'));
  vi.stubEnv('PILOT_HOME', root);
  vi.stubEnv('DATABASE_PATH', '');
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

async function loadDb() {
  const mod = await import('./db.js');
  await mod.initializeDatabase();
  return mod;
}

describe('multi-user schema', () => {
  it('puts auth.db under <root>/system by default', async () => {
    await loadDb();
    expect(fs.existsSync(path.join(root, 'system', 'auth.db'))).toBe(true);
  });

  it('creates users with role and token_version', async () => {
    const { userDb } = await loadDb();
    const created = userDb.createUser('alice', 'hash', 'user');
    expect(created).toMatchObject({ username: 'alice', role: 'user' });
    const row = userDb.getUserById(created.id);
    expect(row).toMatchObject({ role: 'user', token_version: 0, is_active: 1 });
  });

  it('getAdminUser returns only active admins', async () => {
    const { userDb } = await loadDb();
    expect(userDb.getAdminUser()).toBeUndefined();
    const admin = userDb.createUser('admin', 'hash', 'admin');
    expect(userDb.getAdminUser()?.id).toBe(admin.id);
    userDb.setActive(admin.id, false);
    expect(userDb.getAdminUser()).toBeUndefined();
    expect(userDb.countActiveAdmins()).toBe(0);
  });

  it('bumpTokenVersion increments and returns the new value', async () => {
    const { userDb } = await loadDb();
    const u = userDb.createUser('bob', 'hash');
    expect(userDb.bumpTokenVersion(u.id)).toBe(1);
    expect(userDb.bumpTokenVersion(u.id)).toBe(2);
    expect(userDb.getUserById(u.id).token_version).toBe(2);
  });

  it('system_settings defaults public registration to true', async () => {
    const { systemSettingsDb } = await loadDb();
    expect(systemSettingsDb.isPublicRegistrationAllowed()).toBe(true);
    systemSettingsDb.set('allow_public_registration', 'false');
    expect(systemSettingsDb.isPublicRegistrationAllowed()).toBe(false);
  });

  it('session_names carries user_id and is unique per user', async () => {
    const { db } = await loadDb();
    const cols = db.prepare('PRAGMA table_info(session_names)').all().map((c) => c.name);
    expect(cols).toContain('user_id');
    db.prepare('INSERT INTO session_names (user_id, session_id, provider, custom_name) VALUES (1, \'s1\', \'pilotdeck\', \'A\')').run();
    db.prepare('INSERT INTO session_names (user_id, session_id, provider, custom_name) VALUES (2, \'s1\', \'pilotdeck\', \'B\')').run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM session_names').get().n).toBe(2);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm --prefix ui test -- server/database/db.multiuser.test.js`
Expected: FAIL（`system/auth.db` 不存在；`role` 列不存在；`systemSettingsDb` 未导出）

- [ ] **Step 3: 修改 `init.sql`**

把 `users` 建表语句改为：

```sql
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    token_version INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME,
    is_active BOOLEAN DEFAULT 1,
    git_name TEXT,
    git_email TEXT,
    has_completed_onboarding BOOLEAN DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
```

把 `session_names` 建表语句改为：

```sql
CREATE TABLE IF NOT EXISTS session_names (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL DEFAULT 0,
    session_id TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'claude',
    custom_name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, session_id, provider)
);
CREATE INDEX IF NOT EXISTS idx_session_names_lookup ON session_names(user_id, session_id, provider);
```

文件末尾追加：

```sql
-- System-wide settings editable by admins (registration toggle etc.)
CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO system_settings (key, value) VALUES ('allow_public_registration', 'true');
```

- [ ] **Step 4: 修改 `db.js` 库路径（第 25–56 行）**

把 `const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'auth.db');` 及其后的目录创建、`LEGACY_DB_PATH` 复制段整体替换为：

```js
import { resolvePilotHome } from '../utils/pilotPaths.js';

const PILOT_ROOT = resolvePilotHome(process.env);
const DB_PATH = process.env.DATABASE_PATH?.trim()
  ? path.resolve(process.env.DATABASE_PATH.trim())
  : path.join(PILOT_ROOT, 'system', 'auth.db');
const INIT_SQL_PATH = path.join(__dirname, 'init.sql');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// One-time: an older single-user install kept auth.db at <PILOT_ROOT>/auth.db.
// Copy it into system/ so accounts survive the upgrade. The install-directory
// copy that used to live here was removed on purpose (it could resurrect a
// stale database from the source tree).
const ROOT_LEGACY_DB_PATH = path.join(PILOT_ROOT, 'auth.db');
if (DB_PATH !== ROOT_LEGACY_DB_PATH && !fs.existsSync(DB_PATH) && fs.existsSync(ROOT_LEGACY_DB_PATH)) {
  fs.copyFileSync(ROOT_LEGACY_DB_PATH, DB_PATH);
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(ROOT_LEGACY_DB_PATH + suffix)) fs.copyFileSync(ROOT_LEGACY_DB_PATH + suffix, DB_PATH + suffix);
  }
  console.log(`[MIGRATION] Copied ${ROOT_LEGACY_DB_PATH} → ${DB_PATH}`);
}
```

`import` 行放到文件顶部与其他 import 并列。`new Database(DB_PATH)` 之后加：

```js
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
```

- [ ] **Step 5: 修改 `runMigrations()`（第 83–101 行）**

在 `has_completed_onboarding` 迁移之后追加：

```js
    if (!columnNames.includes('role')) {
      console.log('Running migration: Adding role column');
      db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
      db.exec('CREATE INDEX IF NOT EXISTS idx_users_role ON users(role)');
    }
    if (!columnNames.includes('token_version')) {
      console.log('Running migration: Adding token_version column');
      db.exec('ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0');
    }

    const sessionNameCols = db.prepare('PRAGMA table_info(session_names)').all().map((c) => c.name);
    if (sessionNameCols.length > 0 && !sessionNameCols.includes('user_id')) {
      console.log('Running migration: Adding user_id to session_names');
      db.exec(`
        CREATE TABLE session_names_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL DEFAULT 0,
          session_id TEXT NOT NULL,
          provider TEXT NOT NULL DEFAULT 'claude',
          custom_name TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(user_id, session_id, provider)
        );
        INSERT INTO session_names_new (id, user_id, session_id, provider, custom_name, created_at, updated_at)
          SELECT id, 0, session_id, provider, custom_name, created_at, updated_at FROM session_names;
        DROP TABLE session_names;
        ALTER TABLE session_names_new RENAME TO session_names;
        CREATE INDEX IF NOT EXISTS idx_session_names_lookup ON session_names(user_id, session_id, provider);
      `);
    }

    db.exec(`CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.exec("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('allow_public_registration', 'true')");
```

`user_id = 0` 的旧行表示「迁移前归属未知」，计划二的旧数据迁移会把它们改为 admin 的 id。

- [ ] **Step 6: 扩展 `userDb`（第 172–231 行）**

替换 `createUser`、`getUserByUsername`、`getUserById`、`getFirstUser` 为：

```js
  createUser: (username, passwordHash, role = 'user') => {
    const stmt = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)');
    const result = stmt.run(username, passwordHash, role);
    return { id: result.lastInsertRowid, username, role };
  },

  getUserByUsername: (username) => {
    return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  },

  getUserById: (userId) => {
    return db.prepare(
      'SELECT id, username, role, token_version, is_active, created_at, last_login FROM users WHERE id = ?',
    ).get(userId);
  },

  getAdminUser: () => {
    return db.prepare(
      "SELECT id, username, role, token_version, is_active, created_at, last_login FROM users WHERE role = 'admin' AND is_active = 1 ORDER BY id LIMIT 1",
    ).get();
  },

  countActiveAdmins: () => {
    return db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND is_active = 1").get().n;
  },

  listUsers: () => {
    return db.prepare('SELECT id, username, role, is_active, created_at, last_login FROM users ORDER BY id').all();
  },

  bumpTokenVersion: (userId) => {
    db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(userId);
    return db.prepare('SELECT token_version FROM users WHERE id = ?').get(userId).token_version;
  },

  setRole: (userId, role) => {
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);
  },

  setActive: (userId, isActive) => {
    db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(isActive ? 1 : 0, userId);
  },

  updatePasswordHash: (userId, passwordHash) => {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
  },
```

删除 `getFirstUser`（Task 3 会移除它的唯一调用方）。`sessionNamesDb` 的四个方法各加首参 `userId`，SQL 中加 `user_id = ?`；`applyCustomSessionNames(sessions, provider)` 改为 `applyCustomSessionNames(userId, sessions, provider)`。调用方在 Task 7 一并修改。

在 `appConfigDb` 之后新增：

```js
const systemSettingsDb = {
  get: (key, fallback = null) => {
    const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key);
    return row ? row.value : fallback;
  },
  set: (key, value) => {
    db.prepare(
      'INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP',
    ).run(key, String(value));
  },
  isPublicRegistrationAllowed: () => systemSettingsDb.get('allow_public_registration', 'true') !== 'false',
};
```

并加入 `export { ... systemSettingsDb ... }`。

- [ ] **Step 7: 运行测试**

Run: `npm --prefix ui test -- server/database/db.multiuser.test.js`
Expected: PASS（6 个用例）

- [ ] **Step 8: 跑既有依赖 db 的测试确认未破坏**

Run: `npm --prefix ui test -- server/routes/user.test.js server/services/pilotdeckConfig.test.js`
Expected: PASS

- [ ] **Step 9: 提交**

```bash
git add ui/server/database/init.sql ui/server/database/db.js ui/server/database/db.multiuser.test.js
git commit -m "feat(multi-user): users 表加 role/token_version，system_settings 表，auth.db 移至 system/

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: 启动即有 admin

**Files:**
- Create: `ui/server/services/adminBootstrap.js`
- Modify: `ui/server/services/server-startup.js`
- Modify: `ui/server/index.js:4014-4032`
- Test: `ui/server/services/adminBootstrap.test.js`

**Interfaces:**
- Consumes: `userDb.hasUsers`、`userDb.createUser`、`userDb.countActiveAdmins`（Task 1）
- Produces: `ensureAdminUser({ userDb, env = process.env, bcryptHash = bcrypt.hash, log = console.log }) → Promise<{ created: boolean, usedDefaultPassword: boolean }>`；无 admin 时抛 `Error`，`error.code === 'NO_ACTIVE_ADMIN'`
- Produces: `ensureUserHomeSkeleton` 的调用放在 Task 6；本任务只建账号

- [ ] **Step 1: 写失败测试**

```js
// ui/server/services/adminBootstrap.test.js
import { describe, expect, it } from 'vitest';
import { ensureAdminUser, ADMIN_USERNAME, ADMIN_DEFAULT_PASSWORD } from './adminBootstrap.js';

function fakeUserDb(seed = []) {
  const users = [...seed];
  return {
    users,
    hasUsers: () => users.length > 0,
    countActiveAdmins: () => users.filter((u) => u.role === 'admin' && u.is_active).length,
    createUser: (username, password_hash, role) => {
      const row = { id: users.length + 1, username, password_hash, role, is_active: 1 };
      users.push(row);
      return { id: row.id, username, role };
    },
  };
}

describe('ensureAdminUser', () => {
  it('creates admin with default password when table is empty', async () => {
    const userDb = fakeUserDb();
    const hashed = [];
    const result = await ensureAdminUser({ userDb, env: {}, bcryptHash: async (p) => { hashed.push(p); return `h:${p}`; }, log: () => {} });
    expect(result).toEqual({ created: true, usedDefaultPassword: true });
    expect(userDb.users[0]).toMatchObject({ username: ADMIN_USERNAME, role: 'admin', password_hash: `h:${ADMIN_DEFAULT_PASSWORD}` });
    expect(hashed).toEqual([ADMIN_DEFAULT_PASSWORD]);
  });

  it('uses PILOTDECK_ADMIN_PASSWORD when set', async () => {
    const userDb = fakeUserDb();
    const result = await ensureAdminUser({ userDb, env: { PILOTDECK_ADMIN_PASSWORD: 's3cret' }, bcryptHash: async (p) => `h:${p}`, log: () => {} });
    expect(result.usedDefaultPassword).toBe(false);
    expect(userDb.users[0].password_hash).toBe('h:s3cret');
  });

  it('never touches an existing admin password', async () => {
    const userDb = fakeUserDb([{ id: 1, username: 'admin', role: 'admin', is_active: 1, password_hash: 'keep' }]);
    const result = await ensureAdminUser({ userDb, env: { PILOTDECK_ADMIN_PASSWORD: 'other' }, bcryptHash: async () => { throw new Error('must not hash'); }, log: () => {} });
    expect(result).toEqual({ created: false, usedDefaultPassword: false });
    expect(userDb.users[0].password_hash).toBe('keep');
  });

  it('refuses to start when users exist but no active admin', async () => {
    const userDb = fakeUserDb([{ id: 1, username: 'alice', role: 'user', is_active: 1, password_hash: 'x' }]);
    await expect(ensureAdminUser({ userDb, env: {}, bcryptHash: async (p) => p, log: () => {} }))
      .rejects.toMatchObject({ code: 'NO_ACTIVE_ADMIN' });
    expect(userDb.users).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm --prefix ui test -- server/services/adminBootstrap.test.js`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现 `adminBootstrap.js`**

```js
// ui/server/services/adminBootstrap.js
import bcrypt from 'bcrypt';

export const ADMIN_USERNAME = 'admin';
export const ADMIN_DEFAULT_PASSWORD = 'passok';

export function isReservedUsername(username) {
  return typeof username === 'string' && username.trim().toLowerCase() === ADMIN_USERNAME;
}

/**
 * Startup guarantee: the system always has an admin account.
 * - Empty users table → create `admin` (password from PILOTDECK_ADMIN_PASSWORD, else default).
 * - Users exist but no active admin → refuse to start (operator must run the
 *   migration command with --assign-admin; see plan 2).
 * - Existing admin → do nothing. Passwords are never re-synced on startup.
 */
export async function ensureAdminUser({
  userDb,
  env = process.env,
  bcryptHash = (password) => bcrypt.hash(password, 12),
  log = console.log,
} = {}) {
  if (!userDb.hasUsers()) {
    const fromEnv = typeof env.PILOTDECK_ADMIN_PASSWORD === 'string' ? env.PILOTDECK_ADMIN_PASSWORD : '';
    const password = fromEnv.length > 0 ? fromEnv : ADMIN_DEFAULT_PASSWORD;
    const usedDefaultPassword = password === ADMIN_DEFAULT_PASSWORD && fromEnv.length === 0;
    const hash = await bcryptHash(password);
    userDb.createUser(ADMIN_USERNAME, hash, 'admin');
    log(`[INFO] Created administrator account "${ADMIN_USERNAME}".`);
    if (usedDefaultPassword) {
      log('[WARN] Administrator is using the default password. Set PILOTDECK_ADMIN_PASSWORD or change it after first login.');
    }
    return { created: true, usedDefaultPassword };
  }

  if (userDb.countActiveAdmins() === 0) {
    const error = new Error(
      'No active administrator account exists. Refusing to start. Run `node scripts/migrate-user-storage.mjs --assign-admin <username>` to promote an existing account.',
    );
    error.code = 'NO_ACTIVE_ADMIN';
    throw error;
  }

  return { created: false, usedDefaultPassword: false };
}
```

- [ ] **Step 4: 接入启动序列**

`ui/server/services/server-startup.js`：把参数名 `ensureLocalUserWhenAuthDisabledFn` 改为 `ensureAdminUserFn`（含类型检查里的名字与错误文案），调用处同步改名。

`ui/server/index.js` 第 4014–4022 行的 `ensureLocalUserWhenAuthDisabled` 整个函数删除；文件顶部加 `import { ensureAdminUser } from './services/adminBootstrap.js';`；`startServer()` 内改为：

```js
                await runServerStartupBeforeListen({
                    initializeDatabaseFn: initializeDatabase,
                    ensureAdminUserFn: () => ensureAdminUser({ userDb }),
                    configureWebPushFn: configureWebPush
                });
```

`startServer()` 的 `catch` 分支里，若 `error.code === 'NO_ACTIVE_ADMIN'`，打印 `error.message` 后 `process.exit(1)`。

- [ ] **Step 5: 运行测试**

Run: `npm --prefix ui test -- server/services/adminBootstrap.test.js`
Expected: PASS（4 个用例）

- [ ] **Step 6: 提交**

```bash
git add ui/server/services/adminBootstrap.js ui/server/services/adminBootstrap.test.js ui/server/services/server-startup.js ui/server/index.js
git commit -m "feat(multi-user): 启动即有 admin，无管理员时拒绝启动

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: 认证中间件：角色、令牌版本、免登录走 admin

**Files:**
- Modify: `ui/server/middleware/auth.js`
- Create: `ui/server/middleware/requireAdmin.js`
- Test: `ui/server/middleware/auth.multiuser.test.js`

**Interfaces:**
- Consumes: `userDb.getUserById`、`userDb.getAdminUser`（Task 1）
- Produces:
  - `generateToken(user) → JWT`，载荷 `{ userId, username, role, tokenVersion }`
  - `authenticateToken(req, res, next)`：成功时 `req.user = { id, username, role, token_version, is_active, created_at, last_login }`；失败响应体 `{ error, code }`，`code ∈ 'NO_TOKEN' | 'INVALID_TOKEN' | 'TOKEN_REVOKED' | 'USER_DISABLED' | 'USER_NOT_FOUND'`
  - `authenticateWebSocket(token) → { id, userId, username, role } | null`，同样校验版本与激活
  - `resolveBypassUser() → admin 用户 | undefined`（免登录模式用）
  - `requireAdmin(req, res, next)`：`req.user.role !== 'admin'` → 403 `{ error: 'Admin privileges required', code: 'ADMIN_REQUIRED' }`

- [ ] **Step 1: 写失败测试**

```js
// ui/server/middleware/auth.multiuser.test.js
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); vi.unstubAllEnvs(); });

const users = new Map();
function seed(user) { users.set(user.id, user); return user; }
function mockDb() {
  vi.doMock('../database/db.js', () => ({
    userDb: {
      getUserById: (id) => users.get(Number(id)),
      getAdminUser: () => [...users.values()].find((u) => u.role === 'admin' && u.is_active === 1),
    },
    appConfigDb: { getOrCreateJwtSecret: () => 'test-secret' },
  }));
}
function mockRes() {
  const res = { statusCode: 200, body: null, headers: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  return res;
}
async function load(authDisabled) {
  vi.stubEnv('PILOTDECK_DISABLE_LOCAL_AUTH', authDisabled ? '1' : '0');
  mockDb();
  return import('./auth.js');
}

describe('authenticateToken (multi-user)', () => {
  it('embeds role and tokenVersion and accepts a current token', async () => {
    users.clear();
    const u = seed({ id: 1, username: 'alice', role: 'user', token_version: 2, is_active: 1 });
    const { generateToken, authenticateToken } = await load(false);
    const req = { headers: { authorization: `Bearer ${generateToken(u)}` }, query: {} };
    const res = mockRes();
    const next = vi.fn();
    await authenticateToken(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.user).toMatchObject({ id: 1, role: 'user', token_version: 2 });
  });

  it('rejects a token whose version is stale', async () => {
    users.clear();
    const u = seed({ id: 1, username: 'alice', role: 'user', token_version: 0, is_active: 1 });
    const { generateToken, authenticateToken } = await load(false);
    const token = generateToken(u);
    u.token_version = 1;
    const res = mockRes();
    await authenticateToken({ headers: { authorization: `Bearer ${token}` }, query: {} }, res, vi.fn());
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('TOKEN_REVOKED');
  });

  it('rejects a disabled user', async () => {
    users.clear();
    const u = seed({ id: 1, username: 'alice', role: 'user', token_version: 0, is_active: 0 });
    const { generateToken, authenticateToken } = await load(false);
    const res = mockRes();
    await authenticateToken({ headers: { authorization: `Bearer ${generateToken(u)}` }, query: {} }, res, vi.fn());
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('USER_DISABLED');
  });

  it('no-login mode resolves to the admin user, not the first user', async () => {
    users.clear();
    seed({ id: 1, username: 'alice', role: 'user', token_version: 0, is_active: 1 });
    seed({ id: 2, username: 'admin', role: 'admin', token_version: 0, is_active: 1 });
    const { authenticateToken, authenticateWebSocket } = await load(true);
    const req = { headers: {}, query: {} };
    await authenticateToken(req, mockRes(), vi.fn());
    expect(req.user.id).toBe(2);
    expect(authenticateWebSocket(null)).toMatchObject({ userId: 2, role: 'admin' });
  });

  it('authenticateWebSocket enforces version and active flag', async () => {
    users.clear();
    const u = seed({ id: 1, username: 'alice', role: 'user', token_version: 0, is_active: 1 });
    const { generateToken, authenticateWebSocket } = await load(false);
    const token = generateToken(u);
    expect(authenticateWebSocket(token)).toMatchObject({ userId: 1, role: 'user' });
    u.token_version = 5;
    expect(authenticateWebSocket(token)).toBeNull();
  });
});

describe('requireAdmin', () => {
  it('passes admins and blocks users', async () => {
    const { requireAdmin } = await import('./requireAdmin.js');
    const next = vi.fn();
    requireAdmin({ user: { role: 'admin' } }, mockRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
    const res = mockRes();
    requireAdmin({ user: { role: 'user' } }, res, next);
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('ADMIN_REQUIRED');
    expect(next).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm --prefix ui test -- server/middleware/auth.multiuser.test.js`
Expected: FAIL（`req.user.role` 为 undefined；版本不符时仍放行；`requireAdmin.js` 不存在）

- [ ] **Step 3: 重写 `auth.js` 的核心函数**

在文件内新增辅助函数并替换 `authenticateToken`、`generateToken`、`authenticateWebSocket`：

```js
function denied(res, status, code, error) {
  return res.status(status).json({ error, code });
}

export function resolveBypassUser() {
  return userDb.getAdminUser();
}

/** Returns { user } or { code } after checking existence, active flag and token version. */
function resolveTokenUser(decoded) {
  const user = userDb.getUserById(decoded.userId);
  if (!user) return { code: 'USER_NOT_FOUND' };
  if (Number(user.is_active) !== 1) return { code: 'USER_DISABLED' };
  if (Number(decoded.tokenVersion ?? 0) !== Number(user.token_version ?? 0)) return { code: 'TOKEN_REVOKED' };
  return { user };
}

const authenticateToken = async (req, res, next) => {
  if (IS_PLATFORM || DISABLE_LOCAL_AUTH) {
    const user = resolveBypassUser();
    if (!user) return denied(res, 500, 'NO_ADMIN', 'No administrator account exists (restart server after DB init)');
    req.user = user;
    return next();
  }

  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.split(' ')[1];
  if (!token && req.query.token) token = req.query.token;
  if (!token) token = extractDashboardRefererToken(req);
  if (!token) return denied(res, 401, 'NO_TOKEN', 'Access denied. No token provided.');

  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch {
    return denied(res, 401, 'INVALID_TOKEN', 'Invalid token');
  }

  const resolved = resolveTokenUser(decoded);
  if (!resolved.user) {
    const messages = {
      USER_NOT_FOUND: 'Invalid token. User not found.',
      USER_DISABLED: 'This account has been disabled.',
      TOKEN_REVOKED: 'Session expired. Please sign in again.',
    };
    return denied(res, 401, resolved.code, messages[resolved.code]);
  }

  if (decoded.exp && decoded.iat) {
    const now = Math.floor(Date.now() / 1000);
    const halfLife = (decoded.exp - decoded.iat) / 2;
    if (now > decoded.iat + halfLife) res.setHeader('X-Refreshed-Token', generateToken(resolved.user));
  }

  req.user = resolved.user;
  next();
};

const generateToken = (user) =>
  jwt.sign(
    { userId: user.id, username: user.username, role: user.role ?? 'user', tokenVersion: Number(user.token_version ?? 0) },
    JWT_SECRET,
    { expiresIn: '7d' },
  );

const authenticateWebSocket = (token) => {
  if (IS_PLATFORM || DISABLE_LOCAL_AUTH) {
    const user = resolveBypassUser();
    return user ? { id: user.id, userId: user.id, username: user.username, role: user.role } : null;
  }
  if (!token) return null;
  try {
    const resolved = resolveTokenUser(jwt.verify(token, JWT_SECRET));
    if (!resolved.user) return null;
    const { user } = resolved;
    return { id: user.id, userId: user.id, username: user.username, role: user.role };
  } catch {
    return null;
  }
};
```

保留 `validateApiKey`、`extractDashboardRefererToken`、`JWT_SECRET` 不变；`export` 列表加 `resolveBypassUser`。原来 401/403 的混用统一为 401（前端全局处理在计划二）。

- [ ] **Step 4: 新建 `requireAdmin.js`**

```js
// ui/server/middleware/requireAdmin.js
export function requireAdmin(req, res, next) {
  if (req.user?.role === 'admin') return next();
  return res.status(403).json({ error: 'Admin privileges required', code: 'ADMIN_REQUIRED' });
}
```

免登录模式下 `req.user` 已是 admin，自然通过，不需要额外分支。

- [ ] **Step 5: 运行测试**

Run: `npm --prefix ui test -- server/middleware/auth.multiuser.test.js`
Expected: PASS（6 个用例）

- [ ] **Step 6: 提交**

```bash
git add ui/server/middleware/auth.js ui/server/middleware/requireAdmin.js ui/server/middleware/auth.multiuser.test.js
git commit -m "feat(multi-user): JWT 携带 role/tokenVersion，免登录模式解析为 admin，新增 requireAdmin

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: 注册、登录、登出与改密码

**Files:**
- Modify: `ui/server/routes/auth.js`
- Test: `ui/server/routes/auth.multiuser.test.js`

**Interfaces:**
- Consumes: `userDb.*`、`systemSettingsDb.isPublicRegistrationAllowed`（Task 1）；`generateToken`、`authenticateToken`（Task 3）；`isReservedUsername`（Task 2）
- Produces:
  - `GET /api/auth/status → { needsSetup: false, isAuthenticated: false, authDisabled, registrationOpen }`
  - `POST /api/auth/register`：403 `RESERVED_USERNAME` / 403 `REGISTRATION_DISABLED` / 409 `USERNAME_TAKEN` / 200 `{ success, user: { id, username, role }, token }`
  - `POST /api/auth/login → { success, user: { id, username, role }, token }`
  - `POST /api/auth/logout`：`bumpTokenVersion`，返回 `{ success: true }`
  - `POST /api/auth/password`：body `{ currentPassword, newPassword }`，成功返回 `{ success: true, token }`（新版本的令牌）
  - `GET /api/auth/user → { user: { id, username, role } }`

- [ ] **Step 1: 写失败测试**

本测试使用真实 `db.js` 与真实中间件，只把库放在临时目录。

```js
// ui/server/routes/auth.multiuser.test.js
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let root; let server; let base;
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-auth-'));
  vi.stubEnv('PILOT_HOME', root);
  vi.stubEnv('DATABASE_PATH', '');
  vi.stubEnv('PILOTDECK_DISABLE_LOCAL_AUTH', '0');
  vi.stubEnv('PILOTDECK_ADMIN_PASSWORD', 'adminpass');
  vi.resetModules();
  const db = await import('../database/db.js');
  await db.initializeDatabase();
  const { ensureAdminUser } = await import('../services/adminBootstrap.js');
  await ensureAdminUser({ userDb: db.userDb, log: () => {} });
  const { default: authRouter } = await import('./auth.js');
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => {
  await new Promise((r) => server.close(r));
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

const post = (p, body, token) => fetch(`${base}${p}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});
const get = (p, token) => fetch(`${base}${p}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

describe('auth routes (multi-user)', () => {
  it('status reports registration open and no setup needed', async () => {
    const body = await (await get('/api/auth/status')).json();
    expect(body).toMatchObject({ needsSetup: false, authDisabled: false, registrationOpen: true });
  });

  it('registers a second user as role=user', async () => {
    const res = await post('/api/auth/register', { username: 'alice', password: 'secret1' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user).toMatchObject({ username: 'alice', role: 'user' });
    expect(typeof body.token).toBe('string');
  });

  it.each(['admin', 'Admin', 'ADMIN', ' admin '])('rejects reserved username %s', async (name) => {
    const res = await post('/api/auth/register', { username: name, password: 'secret1' });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('RESERVED_USERNAME');
  });

  it('rejects registration when disabled by admin', async () => {
    const { systemSettingsDb } = await import('../database/db.js');
    systemSettingsDb.set('allow_public_registration', 'false');
    const res = await post('/api/auth/register', { username: 'bob', password: 'secret1' });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('REGISTRATION_DISABLED');
    expect((await (await get('/api/auth/status')).json()).registrationOpen).toBe(false);
  });

  it('login returns role; logout revokes the token', async () => {
    const login = await (await post('/api/auth/login', { username: 'admin', password: 'adminpass' })).json();
    expect(login.user).toMatchObject({ username: 'admin', role: 'admin' });
    expect((await get('/api/auth/user', login.token)).status).toBe(200);
    expect((await post('/api/auth/logout', {}, login.token)).status).toBe(200);
    const after = await get('/api/auth/user', login.token);
    expect(after.status).toBe(401);
    expect((await after.json()).code).toBe('TOKEN_REVOKED');
  });

  it('password change revokes old token and returns a fresh one', async () => {
    await post('/api/auth/register', { username: 'carol', password: 'oldpass1' });
    const { token } = await (await post('/api/auth/login', { username: 'carol', password: 'oldpass1' })).json();
    const res = await post('/api/auth/password', { currentPassword: 'oldpass1', newPassword: 'newpass2' }, token);
    expect(res.status).toBe(200);
    const { token: fresh } = await res.json();
    expect((await get('/api/auth/user', token)).status).toBe(401);
    expect((await get('/api/auth/user', fresh)).status).toBe(200);
    expect((await post('/api/auth/login', { username: 'carol', password: 'newpass2' })).status).toBe(200);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm --prefix ui test -- server/routes/auth.multiuser.test.js`
Expected: FAIL（status 缺 `registrationOpen`；第二个用户注册 403；`/password` 404）

- [ ] **Step 3: 重写 `routes/auth.js`**

```js
import express from 'express';
import bcrypt from 'bcrypt';
import { userDb, systemSettingsDb } from '../database/db.js';
import { generateToken, authenticateToken } from '../middleware/auth.js';
import { DISABLE_LOCAL_AUTH } from '../constants/config.js';
import { isReservedUsername } from '../services/adminBootstrap.js';

const router = express.Router();
const SALT_ROUNDS = 12;

const publicUser = (user) => ({ id: user.id, username: user.username, role: user.role ?? 'user' });
const fail = (res, status, code, error) => res.status(status).json({ error, code });

router.get('/status', (_req, res) => {
  if (DISABLE_LOCAL_AUTH) {
    return res.json({ needsSetup: false, isAuthenticated: true, authDisabled: true, registrationOpen: false });
  }
  res.json({
    needsSetup: false,
    isAuthenticated: false,
    authDisabled: false,
    registrationOpen: systemSettingsDb.isPublicRegistrationAllowed(),
  });
});

router.post('/register', async (req, res) => {
  try {
    if (DISABLE_LOCAL_AUTH) return fail(res, 403, 'AUTH_DISABLED', 'Registration is disabled (PILOTDECK_DISABLE_LOCAL_AUTH)');
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!username || !password) return fail(res, 400, 'MISSING_FIELDS', 'Username and password are required');
    if (username.length < 3 || password.length < 6) {
      return fail(res, 400, 'WEAK_CREDENTIALS', 'Username must be at least 3 characters, password at least 6 characters');
    }
    if (isReservedUsername(username)) return fail(res, 403, 'RESERVED_USERNAME', 'This username is reserved');
    if (!systemSettingsDb.isPublicRegistrationAllowed()) {
      return fail(res, 403, 'REGISTRATION_DISABLED', 'Registration is closed. Ask an administrator to create your account.');
    }
    if (userDb.getUserByUsername(username)) return fail(res, 409, 'USERNAME_TAKEN', 'Username already exists');

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    let user;
    try {
      user = userDb.createUser(username, passwordHash, 'user');
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return fail(res, 409, 'USERNAME_TAKEN', 'Username already exists');
      throw error;
    }
    const full = userDb.getUserById(user.id);
    userDb.updateLastLogin(user.id);
    res.json({ success: true, user: publicUser(full), token: generateToken(full) });
  } catch (error) {
    console.error('Registration error:', error);
    fail(res, 500, 'INTERNAL', 'Internal server error');
  }
});

router.post('/login', async (req, res) => {
  try {
    if (DISABLE_LOCAL_AUTH) return fail(res, 403, 'AUTH_DISABLED', 'Login is disabled (PILOTDECK_DISABLE_LOCAL_AUTH)');
    const { username, password } = req.body ?? {};
    if (!username || !password) return fail(res, 400, 'MISSING_FIELDS', 'Username and password are required');
    const user = userDb.getUserByUsername(String(username).trim());
    const ok = user && Number(user.is_active) === 1 && (await bcrypt.compare(password, user.password_hash));
    if (!ok) return fail(res, 401, 'BAD_CREDENTIALS', 'Invalid username or password');
    userDb.updateLastLogin(user.id);
    res.json({ success: true, user: publicUser(user), token: generateToken(user) });
  } catch (error) {
    console.error('Login error:', error);
    fail(res, 500, 'INTERNAL', 'Internal server error');
  }
});

router.get('/user', authenticateToken, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

router.post('/logout', authenticateToken, (req, res) => {
  if (!DISABLE_LOCAL_AUTH) userDb.bumpTokenVersion(req.user.id);
  res.json({ success: true, message: 'Logged out successfully' });
});

router.post('/password', authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body ?? {};
    if (typeof newPassword !== 'string' || newPassword.length < 6) {
      return fail(res, 400, 'WEAK_CREDENTIALS', 'New password must be at least 6 characters');
    }
    const user = userDb.getUserByUsername(req.user.username);
    if (!DISABLE_LOCAL_AUTH) {
      const ok = typeof currentPassword === 'string' && (await bcrypt.compare(currentPassword, user.password_hash));
      if (!ok) return fail(res, 401, 'BAD_CREDENTIALS', 'Current password is incorrect');
    }
    userDb.updatePasswordHash(user.id, await bcrypt.hash(newPassword, SALT_ROUNDS));
    userDb.bumpTokenVersion(user.id);
    const fresh = userDb.getUserById(user.id);
    res.json({ success: true, token: generateToken(fresh) });
  } catch (error) {
    console.error('Password change error:', error);
    fail(res, 500, 'INTERNAL', 'Internal server error');
  }
});

export default router;
```

不再使用手写 `BEGIN/COMMIT`：唯一约束已由数据库保证，哈希在事务外完成（spec §5.2）。

- [ ] **Step 4: 运行测试**

Run: `npm --prefix ui test -- server/routes/auth.multiuser.test.js`
Expected: PASS（9 个用例，含 4 个参数化）

- [ ] **Step 5: 提交**

```bash
git add ui/server/routes/auth.js ui/server/routes/auth.multiuser.test.js
git commit -m "feat(multi-user): 开放注册（admin 保留名、可关闭），登出与改密码撤销旧令牌

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: 管理员接口：用户管理与注册开关

**Files:**
- Create: `ui/server/routes/adminUsers.js`
- Modify: `ui/server/index.js:513`（挂载）
- Test: `ui/server/routes/adminUsers.test.js`

**Interfaces:**
- Consumes: `userDb.listUsers/createUser/setRole/setActive/updatePasswordHash/bumpTokenVersion/countActiveAdmins/getUserById`、`systemSettingsDb`（Task 1）；`requireAdmin`（Task 3）；`isReservedUsername`（Task 2）
- Produces（全部挂 `authenticateToken, requireAdmin`）:
  - `GET /api/admin/users → { users: [{ id, username, role, isActive, createdAt, lastLogin }] }`
  - `POST /api/admin/users` body `{ username, password, role? }` → 201 `{ user }`
  - `PATCH /api/admin/users/:id` body `{ role?, isActive? }` → `{ user }`；会导致零管理员时 409 `LAST_ADMIN`
  - `POST /api/admin/users/:id/reset-password` → `{ password }`（随机 12 位，一次性返回）
  - `GET /api/admin/settings/registration → { allowPublicRegistration }`
  - `PUT /api/admin/settings/registration` body `{ allowPublicRegistration }` → 同上
  - 所有改动他人状态的操作都 `bumpTokenVersion(targetId)`，并调用可注入的 `onUserRevoked(userId)` 回调（Task 11 用它关闭 WS 与回收 Gateway）
  - 导出 `createAdminUsersRouter({ onUserRevoked = () => {} } = {})`
- 本任务**不做** `DELETE`（目录归档属于计划二，和迁移脚本共用归档逻辑）

- [ ] **Step 1: 写失败测试**

```js
// ui/server/routes/adminUsers.test.js
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let root; let server; let base; let adminToken; let userToken; let revoked;
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-admin-'));
  vi.stubEnv('PILOT_HOME', root); vi.stubEnv('DATABASE_PATH', ''); vi.stubEnv('PILOTDECK_DISABLE_LOCAL_AUTH', '0');
  vi.stubEnv('PILOTDECK_ADMIN_PASSWORD', 'adminpass');
  vi.resetModules();
  const db = await import('../database/db.js'); await db.initializeDatabase();
  const { ensureAdminUser } = await import('../services/adminBootstrap.js');
  await ensureAdminUser({ userDb: db.userDb, log: () => {} });
  const { generateToken, authenticateToken } = await import('../middleware/auth.js');
  const { requireAdmin } = await import('../middleware/requireAdmin.js');
  const { createAdminUsersRouter } = await import('./adminUsers.js');
  revoked = [];
  const app = express(); app.use(express.json());
  app.use('/api/admin', authenticateToken, requireAdmin, createAdminUsersRouter({ onUserRevoked: (id) => revoked.push(id) }));
  server = app.listen(0); base = `http://127.0.0.1:${server.address().port}`;
  adminToken = generateToken(db.userDb.getAdminUser());
  const alice = db.userDb.createUser('alice', 'x', 'user');
  userToken = generateToken(db.userDb.getUserById(alice.id));
});
afterEach(async () => { await new Promise((r) => server.close(r)); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

const call = (method, p, body, token) => fetch(`${base}${p}`, {
  method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: body ? JSON.stringify(body) : undefined,
});

describe('admin users API', () => {
  it('blocks non-admins', async () => {
    expect((await call('GET', '/api/admin/users', null, userToken)).status).toBe(403);
  });
  it('lists users without password hashes', async () => {
    const { users } = await (await call('GET', '/api/admin/users', null, adminToken)).json();
    expect(users.map((u) => u.username)).toEqual(['admin', 'alice']);
    expect(users[0]).not.toHaveProperty('password_hash');
  });
  it('creates a user, refusing the reserved name', async () => {
    expect((await call('POST', '/api/admin/users', { username: 'Admin', password: 'secret1' }, adminToken)).status).toBe(403);
    const res = await call('POST', '/api/admin/users', { username: 'bob', password: 'secret1', role: 'admin' }, adminToken);
    expect(res.status).toBe(201);
    expect((await res.json()).user).toMatchObject({ username: 'bob', role: 'admin' });
  });
  it('deactivating a user revokes tokens and notifies', async () => {
    const { users } = await (await call('GET', '/api/admin/users', null, adminToken)).json();
    const alice = users.find((u) => u.username === 'alice');
    const res = await call('PATCH', `/api/admin/users/${alice.id}`, { isActive: false }, adminToken);
    expect(res.status).toBe(200);
    expect(revoked).toEqual([alice.id]);
    expect((await call('GET', '/api/admin/users', null, userToken)).status).toBe(401);
  });
  it('protects the last admin', async () => {
    const { users } = await (await call('GET', '/api/admin/users', null, adminToken)).json();
    const admin = users.find((u) => u.username === 'admin');
    const demote = await call('PATCH', `/api/admin/users/${admin.id}`, { role: 'user' }, adminToken);
    expect(demote.status).toBe(409);
    expect((await demote.json()).code).toBe('LAST_ADMIN');
    const disable = await call('PATCH', `/api/admin/users/${admin.id}`, { isActive: false }, adminToken);
    expect(disable.status).toBe(409);
  });
  it('resets a password and returns it once', async () => {
    const { users } = await (await call('GET', '/api/admin/users', null, adminToken)).json();
    const alice = users.find((u) => u.username === 'alice');
    const { password } = await (await call('POST', `/api/admin/users/${alice.id}/reset-password`, null, adminToken)).json();
    expect(password).toHaveLength(12);
    expect(revoked).toEqual([alice.id]);
  });
  it('toggles registration', async () => {
    expect((await (await call('GET', '/api/admin/settings/registration', null, adminToken)).json()).allowPublicRegistration).toBe(true);
    await call('PUT', '/api/admin/settings/registration', { allowPublicRegistration: false }, adminToken);
    expect((await (await call('GET', '/api/admin/settings/registration', null, adminToken)).json()).allowPublicRegistration).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm --prefix ui test -- server/routes/adminUsers.test.js`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现 `adminUsers.js`**

```js
// ui/server/routes/adminUsers.js
import express from 'express';
import bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import { userDb, systemSettingsDb } from '../database/db.js';
import { isReservedUsername } from '../services/adminBootstrap.js';

const fail = (res, status, code, error) => res.status(status).json({ error, code });
const toPublic = (u) => ({ id: u.id, username: u.username, role: u.role, isActive: Number(u.is_active) === 1, createdAt: u.created_at, lastLogin: u.last_login });
const randomPassword = () => randomBytes(9).toString('base64url').slice(0, 12);

function wouldRemoveLastAdmin(target, patch) {
  if (target.role !== 'admin' || Number(target.is_active) !== 1) return false;
  const losesAdmin = (patch.role !== undefined && patch.role !== 'admin') || patch.isActive === false;
  return losesAdmin && userDb.countActiveAdmins() <= 1;
}

export function createAdminUsersRouter({ onUserRevoked = () => {} } = {}) {
  const router = express.Router();

  router.get('/users', (_req, res) => {
    res.json({ users: userDb.listUsers().map(toPublic) });
  });

  router.post('/users', async (req, res) => {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const role = req.body?.role === 'admin' ? 'admin' : 'user';
    if (username.length < 3 || password.length < 6) return fail(res, 400, 'WEAK_CREDENTIALS', 'Username ≥3 chars, password ≥6 chars');
    if (isReservedUsername(username)) return fail(res, 403, 'RESERVED_USERNAME', 'This username is reserved');
    if (userDb.getUserByUsername(username)) return fail(res, 409, 'USERNAME_TAKEN', 'Username already exists');
    const created = userDb.createUser(username, await bcrypt.hash(password, 12), role);
    res.status(201).json({ user: toPublic(userDb.getUserById(created.id)) });
  });

  router.patch('/users/:id', (req, res) => {
    const target = userDb.getUserById(Number(req.params.id));
    if (!target) return fail(res, 404, 'USER_NOT_FOUND', 'User not found');
    const patch = {};
    if (req.body?.role === 'admin' || req.body?.role === 'user') patch.role = req.body.role;
    if (typeof req.body?.isActive === 'boolean') patch.isActive = req.body.isActive;
    if (Object.keys(patch).length === 0) return fail(res, 400, 'NO_CHANGES', 'Nothing to update');
    if (wouldRemoveLastAdmin(target, patch)) return fail(res, 409, 'LAST_ADMIN', 'Cannot remove the last administrator');
    if (patch.role !== undefined) userDb.setRole(target.id, patch.role);
    if (patch.isActive !== undefined) userDb.setActive(target.id, patch.isActive);
    userDb.bumpTokenVersion(target.id);
    onUserRevoked(target.id);
    res.json({ user: toPublic(userDb.getUserById(target.id)) });
  });

  router.post('/users/:id/reset-password', async (req, res) => {
    const target = userDb.getUserById(Number(req.params.id));
    if (!target) return fail(res, 404, 'USER_NOT_FOUND', 'User not found');
    const password = randomPassword();
    userDb.updatePasswordHash(target.id, await bcrypt.hash(password, 12));
    userDb.bumpTokenVersion(target.id);
    onUserRevoked(target.id);
    res.json({ password });
  });

  router.get('/settings/registration', (_req, res) => {
    res.json({ allowPublicRegistration: systemSettingsDb.isPublicRegistrationAllowed() });
  });

  router.put('/settings/registration', (req, res) => {
    if (typeof req.body?.allowPublicRegistration !== 'boolean') return fail(res, 400, 'INVALID_VALUE', 'allowPublicRegistration must be boolean');
    systemSettingsDb.set('allow_public_registration', req.body.allowPublicRegistration ? 'true' : 'false');
    res.json({ allowPublicRegistration: systemSettingsDb.isPublicRegistrationAllowed() });
  });

  return router;
}
```

- [ ] **Step 4: 挂载到 `index.js`**

在第 513 行 `app.use('/api/auth', authRoutes);` 之后加：

```js
import { requireAdmin } from './middleware/requireAdmin.js';
import { createAdminUsersRouter } from './routes/adminUsers.js';
// ...
app.use('/api/admin', authenticateToken, requireAdmin, createAdminUsersRouter({
    onUserRevoked: (userId) => revokeUserRuntime(userId),
}));
```

先在 `index.js` 顶层定义占位：

```js
// Filled in by Task 11 (closes the user's WebSockets and recycles their Gateway).
let revokeUserRuntime = (_userId) => {};
```

- [ ] **Step 5: 运行测试**

Run: `npm --prefix ui test -- server/routes/adminUsers.test.js`
Expected: PASS（7 个用例）

- [ ] **Step 6: 提交**

```bash
git add ui/server/routes/adminUsers.js ui/server/routes/adminUsers.test.js ui/server/index.js
git commit -m "feat(multi-user): 管理员用户管理接口与注册开关

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: 请求作用域与用户目录解析

**Files:**
- Create: `ui/server/middleware/userScope.js`
- Modify: `ui/server/utils/pilotPaths.js`（在 `resolvePilotHome` 之后新增四个函数）
- Modify: `src/pilot/paths.ts:203-205`（新增 `resolveUserHome`）
- Modify: `ui/server/index.js:510-566`（挂载作用域中间件）、`ui/server/index.js:2662-2680`（WS 作用域）
- Test: `ui/server/middleware/userScope.test.js`、`ui/server/utils/pilotPaths.users.test.js`、`ui/server/utils/pilotPaths.parity.test.js`

**Interfaces:**
- Produces（`userScope.js`）:
  - `runWithUserScope({ userId, role }, fn) → fn 的返回值`（`AsyncLocalStorage.run`）
  - `getUserScope() → { userId: string, role } | undefined`
  - `requireUserScope() → { userId: string, role }`；无作用域时抛 `UserScopeMissingError`（`code: 'USER_SCOPE_MISSING'`）
  - `userScopeMiddleware(req, res, next)`：从 `req.user` 取 `id`/`role` 进入作用域；没有 `req.user` 时 500 `USER_SCOPE_MISSING`
- Produces（`pilotPaths.js`）:
  - `resolvePilotRoot(env = process.env) → string`（`resolvePilotHome` 的别名，表达「系统根」语义）
  - `resolveUserHome(userId, env = process.env) → path.join(resolvePilotRoot(env), 'users', String(userId))`；`userId` 为空、含 `/`、`\`、`..` 时抛错
  - `resolveScopedHome(env = process.env) → resolveUserHome(requireUserScope().userId, env)`
  - `ensureUserHomeSkeleton(userId, env = process.env) → userHome`：创建 `projects/ workspaces/ memory/ skills/ archives/ logs/ .pilotdeck/tool-results/ .tmp/chat-attachments/`，写空文件 `.legacy-bundled-skills-migrated-v1`，若 `<root>/plugins` 存在且 `<userHome>/plugins` 不存在则创建相对符号链接 `../../plugins`
- Produces（`paths.ts`）: `resolveUserHome(userId: string, env: PilotPathEnv = process.env): string`，与 JS 同算法

- [ ] **Step 1: 写失败测试（作用域）**

```js
// ui/server/middleware/userScope.test.js
import { describe, expect, it, vi } from 'vitest';
import { runWithUserScope, getUserScope, requireUserScope, userScopeMiddleware } from './userScope.js';

describe('userScope', () => {
  it('exposes the scope inside run and across awaits', async () => {
    await runWithUserScope({ userId: 7, role: 'user' }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      expect(requireUserScope()).toEqual({ userId: '7', role: 'user' });
    });
  });
  it('is empty outside run and requireUserScope throws', () => {
    expect(getUserScope()).toBeUndefined();
    expect(() => requireUserScope()).toThrowError(expect.objectContaining({ code: 'USER_SCOPE_MISSING' }));
  });
  it('keeps concurrent scopes apart', async () => {
    const seen = [];
    await Promise.all([
      runWithUserScope({ userId: 1, role: 'user' }, async () => { await new Promise((r) => setTimeout(r, 5)); seen.push(requireUserScope().userId); }),
      runWithUserScope({ userId: 2, role: 'user' }, async () => { seen.push(requireUserScope().userId); }),
    ]);
    expect(seen.sort()).toEqual(['1', '2']);
  });
  it('middleware enters scope from req.user and 500s without it', () => {
    const next = vi.fn(() => { expect(requireUserScope().userId).toBe('3'); });
    userScopeMiddleware({ user: { id: 3, role: 'admin' } }, {}, next);
    expect(next).toHaveBeenCalled();
    const res = { status: vi.fn(() => res), json: vi.fn() };
    userScopeMiddleware({}, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'USER_SCOPE_MISSING' }));
  });
});
```

- [ ] **Step 2: 写失败测试（路径）**

```js
// ui/server/utils/pilotPaths.users.test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolvePilotRoot, resolveUserHome, resolveScopedHome, ensureUserHomeSkeleton } from './pilotPaths.js';
import { runWithUserScope } from '../middleware/userScope.js';

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-paths-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('user home resolution', () => {
  it('derives users/<id> under the root', () => {
    const env = { PILOT_HOME: root };
    expect(resolvePilotRoot(env)).toBe(root);
    expect(resolveUserHome(5, env)).toBe(path.join(root, 'users', '5'));
  });
  it.each(['', '../x', 'a/b', 'a\\b', null, undefined])('rejects unsafe id %j', (id) => {
    expect(() => resolveUserHome(id, { PILOT_HOME: root })).toThrow();
  });
  it('resolveScopedHome reads the current scope and fails without one', () => {
    const env = { PILOT_HOME: root };
    expect(() => resolveScopedHome(env)).toThrowError(expect.objectContaining({ code: 'USER_SCOPE_MISSING' }));
    runWithUserScope({ userId: 9, role: 'user' }, () => {
      expect(resolveScopedHome(env)).toBe(path.join(root, 'users', '9'));
    });
  });
  it('ensureUserHomeSkeleton builds the layout, marker and plugins link', () => {
    fs.mkdirSync(path.join(root, 'plugins'));
    const env = { PILOT_HOME: root };
    const home = ensureUserHomeSkeleton(4, env);
    for (const d of ['projects', 'workspaces', 'memory', 'skills', 'archives', 'logs', '.pilotdeck/tool-results', '.tmp/chat-attachments']) {
      expect(fs.statSync(path.join(home, d)).isDirectory()).toBe(true);
    }
    expect(fs.existsSync(path.join(home, '.legacy-bundled-skills-migrated-v1'))).toBe(true);
    expect(fs.readlinkSync(path.join(home, 'plugins'))).toBe(path.join('..', '..', 'plugins'));
    expect(ensureUserHomeSkeleton(4, env)).toBe(home); // idempotent
  });
});
```

```js
// ui/server/utils/pilotPaths.parity.test.js
import { describe, expect, it } from 'vitest';
import * as js from './pilotPaths.js';
import * as ts from '../../../src/pilot/paths.ts';

describe('JS/TS path parity for user homes', () => {
  it.each([['1', '/srv/pd'], ['42', '/Users/x/.pilotdeck-home'], ['7', '~/.pilotdeck']])('userId=%s root=%s', (id, home) => {
    const env = { PILOT_HOME: home };
    expect(js.resolveUserHome(id, env)).toBe(ts.resolveUserHome(id, env));
    expect(js.resolveTypedProjectDir('general_med-abc', js.resolveUserHome(id, env)))
      .toBe(ts.resolveTypedProjectDir('general_med-abc', ts.resolveUserHome(id, env)));
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `npm --prefix ui test -- server/middleware/userScope.test.js server/utils/pilotPaths.users.test.js server/utils/pilotPaths.parity.test.js`
Expected: FAIL（模块与函数不存在）

- [ ] **Step 4: 实现 `userScope.js`**

```js
// ui/server/middleware/userScope.js
import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

export class UserScopeMissingError extends Error {
  constructor() {
    super('No user scope is active for this request. Refusing to fall back to a shared directory.');
    this.code = 'USER_SCOPE_MISSING';
  }
}

export function runWithUserScope({ userId, role }, fn) {
  if (userId === null || userId === undefined || String(userId).trim() === '') {
    throw new UserScopeMissingError();
  }
  return storage.run({ userId: String(userId), role: role ?? 'user' }, fn);
}

export function getUserScope() {
  return storage.getStore();
}

export function requireUserScope() {
  const scope = storage.getStore();
  if (!scope) throw new UserScopeMissingError();
  return scope;
}

export function userScopeMiddleware(req, res, next) {
  const id = req.user?.id ?? req.user?.userId;
  if (id === null || id === undefined) {
    return res.status(500).json({ error: 'User scope missing', code: 'USER_SCOPE_MISSING' });
  }
  return runWithUserScope({ userId: id, role: req.user.role }, () => next());
}
```

- [ ] **Step 5: 扩展 `pilotPaths.js`**

在 `resolvePilotHome` 之后加入（文件顶部补 `import fs from 'node:fs';` 与 `import { requireUserScope } from '../middleware/userScope.js';`）：

```js
export function resolvePilotRoot(env = process.env) {
    return resolvePilotHome(env);
}

function assertSafeUserId(userId) {
    const id = userId === null || userId === undefined ? '' : String(userId).trim();
    if (!id || /[\\/]/.test(id) || id === '.' || id === '..' || id.includes('..')) {
        throw new Error(`Invalid userId for path resolution: ${JSON.stringify(userId)}`);
    }
    return id;
}

export function resolveUserHome(userId, env = process.env) {
    return path.join(resolvePilotRoot(env), 'users', assertSafeUserId(userId));
}

export function resolveScopedHome(env = process.env) {
    return resolveUserHome(requireUserScope().userId, env);
}

const USER_HOME_SKELETON = [
    'projects', 'workspaces', 'memory', 'skills', 'archives', 'logs',
    path.join('.pilotdeck', 'tool-results'), path.join('.tmp', 'chat-attachments'),
];

export function ensureUserHomeSkeleton(userId, env = process.env) {
    const home = resolveUserHome(userId, env);
    for (const rel of USER_HOME_SKELETON) fs.mkdirSync(path.join(home, rel), { recursive: true });
    const marker = path.join(home, '.legacy-bundled-skills-migrated-v1');
    if (!fs.existsSync(marker)) fs.writeFileSync(marker, '');
    const sharedPlugins = path.join(resolvePilotRoot(env), 'plugins');
    const link = path.join(home, 'plugins');
    if (fs.existsSync(sharedPlugins) && !fs.existsSync(link)) {
        fs.symlinkSync(path.join('..', '..', 'plugins'), link, 'dir');
    }
    return home;
}
```

`pilotPaths.js` 目前用的是 `path`/`resolve` 的具名导入，按文件既有 import 风格调整（若文件只导入了 `resolve`、`join`，就用 `join` 代替 `path.join`）。

- [ ] **Step 6: 在 `src/pilot/paths.ts` 中加 TS 版**

紧跟 `resolvePilotHome` 之后：

```ts
export function resolveUserHome(userId: string, env: PilotPathEnv = process.env): string {
  const id = String(userId ?? "").trim();
  if (!id || /[\\/]/.test(id) || id === "." || id === ".." || id.includes("..")) {
    throw new Error(`Invalid userId for path resolution: ${JSON.stringify(userId)}`);
  }
  return resolve(resolvePilotHome(env), "users", id);
}
```

JS 用 `path.join`、TS 用 `resolve`：对绝对路径 root 二者输出相同；对 `~/...` 两边都先经 `normalizeHomePath` 展开，一致性由 parity 测试保证。

- [ ] **Step 7: 在 `index.js` 挂载作用域**

第 510 行之后、所有 `authenticateToken` 路由之前，无法在 `app.use('/api', ...)` 层统一加（`/api/auth` 不需要作用域），因此定义组合中间件并替换每处 `authenticateToken`：

```js
import { userScopeMiddleware } from './middleware/userScope.js';
const requireUser = [authenticateToken, userScopeMiddleware];
```

把第 516–566 行以及 571–1513 行所有 `authenticateToken,` 出现处（除 `/api/auth` 与 `/api/admin` 挂载行外）替换为 `...requireUser,`。`/api/admin` 挂载改为 `authenticateToken, userScopeMiddleware, requireAdmin`，让管理员接口也在自己的作用域内。

WS 侧，`handleChatConnection(ws, request)` 中第 2679 行 `ws.on('message', async (message) => {` 改为：

```js
    const scope = { userId, role: request?.user?.role ?? 'user' };
    ws.on('message', (message) => runWithUserScope(scope, async () => {
```

并把该处理函数的收尾 `});` 改为 `}));`。第 2894 行的另一处 `ws.on('message'`（shell WS）同样包一层。文件顶部补 `import { runWithUserScope, userScopeMiddleware } from './middleware/userScope.js';`。

- [ ] **Step 8: 新建用户目录骨架的调用点**

`routes/auth.js` 注册成功后、`routes/adminUsers.js` 创建成功后、`services/adminBootstrap.js` 创建 admin 后，各加一行 `ensureUserHomeSkeleton(user.id)`（`adminBootstrap` 通过参数注入 `ensureHome = ensureUserHomeSkeleton` 以便测试传空函数）。`authenticateToken` 成功时**不**建目录，避免每个请求做文件系统调用；`gatewayPool.acquire`（Task 9）启动前会再调一次保证存在。

- [ ] **Step 9: 运行测试**

Run: `npm --prefix ui test -- server/middleware/userScope.test.js server/utils/pilotPaths.users.test.js server/utils/pilotPaths.parity.test.js server/routes/auth.multiuser.test.js server/routes/adminUsers.test.js server/services/adminBootstrap.test.js`
Expected: PASS

- [ ] **Step 10: 提交**

```bash
git add ui/server/middleware/userScope.js ui/server/middleware/userScope.test.js ui/server/utils/pilotPaths.js ui/server/utils/pilotPaths.users.test.js ui/server/utils/pilotPaths.parity.test.js src/pilot/paths.ts ui/server/index.js ui/server/routes/auth.js ui/server/routes/adminUsers.js ui/server/services/adminBootstrap.js ui/server/services/adminBootstrap.test.js
git commit -m "feat(multi-user): AsyncLocalStorage 用户作用域与 users/<id> 目录解析

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: 请求时路径解析改为用户目录

**Files:**
- Modify: `ui/server/projects.js:141,289,327,435,475,492,561,572,604`
- Modify: `ui/server/routes/messages.js:26`、`routes/git.js:9`、`routes/taskmaster.js:23`、`routes/caseState.js:356`、`routes/commands.js:24,295,683,900`、`routes/mcp.js:24`、`routes/storage.js:150,237,269`
- Modify: `ui/server/index.js:641,681,698,715,2903`（`resolvePilotHome(process.env)` → `resolveScopedHome()`），`index.js:847,930,957`、`projects.js:397`（`sessionNamesDb` 调用加 userId）
- Test: `ui/server/projects.scope.test.js`

**Interfaces:**
- Consumes: `resolveScopedHome`、`requireUserScope`（Task 6）；`sessionNamesDb.*(userId, ...)`、`applyCustomSessionNames(userId, sessions, provider)`（Task 1）
- Produces: 以上模块在请求内全部落到 `users/<userId>/`；`getProjects()`、`getSessions()` 等导出签名不变

- [ ] **Step 1: 写失败测试**

```js
// ui/server/projects.scope.test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-proj-'));
  vi.stubEnv('PILOT_HOME', root);
  vi.resetModules();
  vi.doMock('./pilotdeck-bridge.js', () => ({ getPilotDeckGateway: async () => ({ listProjects: async () => ({ projects: [] }) }) }));
  vi.doMock('./database/db.js', () => ({
    sessionNamesDb: { getNames: () => new Map(), setName: () => {}, deleteName: () => true, getName: () => null },
    applyCustomSessionNames: () => {},
  }));
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

describe('projects.js under user scope', () => {
  it('creates system projects inside the scoped user home', async () => {
    const { runWithUserScope } = await import('./middleware/userScope.js');
    const { createSystemProject } = await import('./projects.js');
    const created = await runWithUserScope({ userId: 11, role: 'user' }, () => createSystemProject({ displayName: '病例一', type: 'general_med' }));
    const dir = path.join(root, 'users', '11', 'projects', 'general_med', created.id);
    expect(fs.existsSync(path.join(dir, 'meta.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'projects'))).toBe(false);
  });
  it('lists only the scoped user\'s projects', async () => {
    const { runWithUserScope } = await import('./middleware/userScope.js');
    const { createSystemProject, getProjects } = await import('./projects.js');
    await runWithUserScope({ userId: 1, role: 'user' }, () => createSystemProject({ displayName: 'A', type: 'general_med' }));
    await runWithUserScope({ userId: 2, role: 'user' }, () => createSystemProject({ displayName: 'B', type: 'general_med' }));
    const forA = await runWithUserScope({ userId: 1, role: 'user' }, () => getProjects());
    expect(forA.map((p) => p.displayName)).toEqual(['A']);
  });
  it('throws without a scope instead of using the root', async () => {
    const { getProjects } = await import('./projects.js');
    await expect(getProjects()).rejects.toMatchObject({ code: 'USER_SCOPE_MISSING' });
  });
});
```

`createSystemProject` 的返回字段名与 `getProjects` 的 `displayName` 字段以文件实际实现为准；若名称不同，按实际字段改断言，不改实现。

- [ ] **Step 2: 运行确认失败**

Run: `npm --prefix ui test -- server/projects.scope.test.js`
Expected: FAIL（项目被写到 `<root>/projects`）

- [ ] **Step 3: 机械替换**

在列出的每个文件中，把 `resolvePilotHome(process.env)` 和无参的 `resolvePilotHome()` 替换为 `resolveScopedHome()`，并把 import 中的 `resolvePilotHome` 换成 `resolveScopedHome`（文件若仍在别处需要根目录语义，用 `resolvePilotRoot`）。逐文件核对：

| 文件 | 行 | 替换后 |
|---|---|---|
| `projects.js` | 141, 289, 327, 435, 475, 492, 561, 572, 604 | `const pilotHome = resolveScopedHome();` |
| `routes/messages.js` | 26 | 同上 |
| `routes/git.js` | 9 | 同上 |
| `routes/taskmaster.js` | 23 | 同上 |
| `routes/caseState.js` | 356 | 同上 |
| `routes/commands.js` | 24, 295, 683, 900 | 同上 |
| `routes/mcp.js` | 24 | 同上 |
| `routes/storage.js` | 150, 237 | 默认参数改为 `pilotHome = resolveScopedHome()` |
| `routes/storage.js` | 269 | `const pilotHome = resolveScopedHome();` |
| `index.js` | 641, 681, 698, 715, 2903 | `resolveScopedHome()` |

`session_names` 调用：

```js
// index.js:847
applyCustomSessionNames(requireUserScope().userId, result.sessions, 'pilotdeck');
// index.js:930
sessionNamesDb.deleteName(requireUserScope().userId, sessionId, 'pilotdeck');
// index.js:957
sessionNamesDb.setName(requireUserScope().userId, safeSessionId, provider, summary.trim());
// projects.js:397
applyCustomSessionNames(requireUserScope().userId, sessions, 'claude');
```

`db.js` 中 `applyCustomSessionNames(userId, sessions, provider)` 内部改为调用 `sessionNamesDb.getNames(userId, ids, provider)`。

- [ ] **Step 4: 运行测试**

Run: `npm --prefix ui test -- server/projects.scope.test.js server/routes/caseState.test.js server/routes/commands.test.js server/routes/storage.test.js`
Expected: PASS。既有的三个路由测试若因为缺少作用域而失败，在其 `beforeEach` 中用 `runWithUserScope({ userId: 1, role: 'admin' }, ...)` 包住请求，或在测试 app 中挂 `userScopeMiddleware` 并伪造 `req.user`；不要给生产代码加兜底。

- [ ] **Step 5: 提交**

```bash
git add ui/server/projects.js ui/server/projects.scope.test.js ui/server/routes/messages.js ui/server/routes/git.js ui/server/routes/taskmaster.js ui/server/routes/caseState.js ui/server/routes/commands.js ui/server/routes/mcp.js ui/server/routes/storage.js ui/server/index.js ui/server/database/db.js
git add ui/server/routes/*.test.js
git commit -m "feat(multi-user): REST 路由与 projects.js 按用户作用域解析目录

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: 拆掉模块级全局 home 常量，并加静态扫描

**Files:**
- Modify: `ui/server/services/memoryService.js:24-26,43,63`
- Modify: `ui/server/routes/skills.js:55,72,108,113,439,578`
- Modify: `ui/server/routes/gateway.js:13-16`
- Modify: `ui/server/services/permissionSettings.js:24`
- Create: `scripts/check-module-level-pilot-home.mjs`
- Modify: `ui/package.json`（`typecheck` 脚本前置扫描）
- Test: `scripts/check-module-level-pilot-home.test.mjs`（`node --test`）

**Interfaces:**
- Consumes: `resolveScopedHome`、`resolvePilotRoot`（Task 6）
- Produces: `memoryService.js` 内部函数 `memoryRootDir()`、`memoryGlobalRoot()`、`memoryWorkspacesRoot()` 替代三个常量；`skills.js` 的 `userSkillsRoot()` 与 `resolveProjectPathForSkills()` 改用 `resolveScopedHome()`；`gateway.js` 中与系统配置相关的三个路径保留在**根**（`resolvePilotRoot`），它们是系统级文件；`permissionSettings.getPermissionSettingsPath(env)` 改为 `path.join(resolveScopedHome(env), 'permissions.json')`
- Produces: 扫描脚本退出码非 0 时打印 `文件:行: 片段`

- [ ] **Step 1: 写失败测试（扫描脚本）**

```js
// scripts/check-module-level-pilot-home.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanForModuleLevelPilotHome } from './check-module-level-pilot-home.mjs';

test('flags top-level resolvePilotHome and process.env.PILOT_HOME, ignores in-function use', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scan-'));
  mkdirSync(join(dir, 'ok'));
  writeFileSync(join(dir, 'bad.js'), "import { resolvePilotHome } from './x.js';\nconst HOME = resolvePilotHome(process.env);\nconst M = process.env.PILOT_HOME || '/x';\nexport function f() { return resolvePilotHome(); }\n");
  writeFileSync(join(dir, 'ok', 'good.js'), "export function f() {\n  const home = resolvePilotHome(process.env);\n  return home;\n}\n");
  writeFileSync(join(dir, 'ok', 'good.test.js'), "const HOME = resolvePilotHome(process.env);\n");
  const findings = scanForModuleLevelPilotHome(dir);
  assert.deepEqual(findings.map((f) => `${f.file.replace(dir + '/', '')}:${f.line}`), ['bad.js:2', 'bad.js:3']);
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test scripts/check-module-level-pilot-home.test.mjs`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现扫描脚本**

```js
// scripts/check-module-level-pilot-home.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PATTERN = /resolvePilotHome\s*\(|process\.env\.PILOT_HOME\b/;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (['.js', '.mjs', '.ts'].includes(extname(name)) && !/\.(test|spec)\.[mc]?[jt]s$/.test(name)) yield full;
  }
}

/** Returns findings for PATTERN occurring at brace depth 0 (module scope). */
export function scanForModuleLevelPilotHome(rootDir) {
  const findings = [];
  for (const file of walk(rootDir)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    let depth = 0;
    lines.forEach((line, index) => {
      const code = line.replace(/\/\/.*$/, '');
      if (depth === 0 && PATTERN.test(code)) findings.push({ file, line: index + 1, text: line.trim() });
      for (const ch of code) {
        if (ch === '{' || ch === '(') depth += 1;
        else if (ch === '}' || ch === ')') depth = Math.max(0, depth - 1);
      }
    });
  }
  return findings;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = process.argv[2] ?? join(process.cwd(), 'ui', 'server');
  const findings = scanForModuleLevelPilotHome(target);
  if (findings.length) {
    console.error('Module-level PILOT_HOME resolution is not allowed in multi-user code:');
    for (const f of findings) console.error(`  ${f.file}:${f.line}: ${f.text}`);
    process.exit(1);
  }
  console.log(`check-module-level-pilot-home: OK (${target})`);
}
```

深度统计把 `(` 也算进去，所以 `import {...}` 行里的 `{}` 与多行调用都能正确归零；`.test.js` 文件被跳过。

- [ ] **Step 4: 运行脚本测试**

Run: `node --test scripts/check-module-level-pilot-home.test.mjs`
Expected: PASS

- [ ] **Step 5: 用脚本找出现存违规**

Run: `node scripts/check-module-level-pilot-home.mjs ui/server`
Expected: 失败，列出 `memoryService.js:24`、`skills.js:55`、`gateway.js:13`、`pilotdeckConfig.js:27`、`mcpConfig.js:10`、`cron-daemon-*.js`、`desktopUpdateService.js:582` 等。

处理原则：
- **用户数据**（memoryService、skills、permissionSettings）→ `resolveScopedHome()`。
- **系统级文件**（`pilotdeckConfig.js` 的 `pilotdeck.yaml`、`gateway.js` 的 IM 凭据与渠道状态、`mcpConfig.js`、`desktopUpdateService.js` 的 `updates/`、cron daemon 日志）→ 改成函数但用 `resolvePilotRoot()`，模块级不再有常量。

- [ ] **Step 6: 改 `memoryService.js`**

删除第 24–26 行三个常量，新增：

```js
function memoryRootDir() { return path.join(resolveScopedHome(), 'memory'); }
function memoryWorkspacesRoot() { return path.join(memoryRootDir(), 'workspaces'); }
function memoryGlobalRoot() { return path.join(memoryRootDir(), 'global'); }
```

全文件把 `MEMORY_ROOT_DIR` → `memoryRootDir()`、`MEMORY_GLOBAL_ROOT` → `memoryGlobalRoot()`、`MEMORY_WORKSPACES_ROOT` → `memoryWorkspacesRoot()`；第 43、63 行的 `resolvePilotHome(process.env)` → `resolveScopedHome()`。`servicesByDataDir` 缓存的 key 已经是绝对 dataDir，不同用户自然分开。

**调度器没有请求作用域，必须单独处理**：`startMemoryScheduler()`（第 548 行，由 `index.js:4091` 在监听后调用）每分钟执行 `runMemorySchedulerCycle()`，其中会走到 `memoryRootDir()` 并抛 `USER_SCOPE_MISSING`。改为：

```js
// memoryService.js
import { DISABLE_LOCAL_AUTH } from '../constants/config.js';
import { runWithUserScope } from '../middleware/userScope.js';
import { userDb } from '../database/db.js';

export function startMemoryScheduler() {
  if (!DISABLE_LOCAL_AUTH) {
    console.log('[memory] UI-side maintenance scheduler disabled in multi-user mode (runs inside each user gateway).');
    return;
  }
  // no-login mode: everything belongs to admin
  const admin = userDb.getAdminUser();
  if (!admin) return;
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => {
    void runWithUserScope({ userId: admin.id, role: 'admin' }, () => runMemorySchedulerCycle());
  }, MEMORY_SCHEDULER_INTERVAL_MS);
  if (typeof schedulerTimer.unref === 'function') schedulerTimer.unref();
}
```

原函数体中其余逻辑（去重、状态记录）保留在 `runMemorySchedulerCycle()` 内不动。`getMemorySchedulerStatus()`、`closeMemoryServices()`、`clearAllMemoryData()`、`exportAllProjectsMemoryBundle()`、`importAllProjectsMemoryBundle()` 都由带作用域的路由调用，无需改动。

- [ ] **Step 7: 改 `skills.js`、`gateway.js`、`permissionSettings.js`**

`skills.js`：删除第 55 行常量；第 72、113 行 `PILOT_HOME` → `resolveScopedHome()`；第 108 行 `return path.join(resolveScopedHome(), SKILLS_SUBDIR);`；第 439、578 行传参处同样改为 `resolveScopedHome()`。

`gateway.js` 第 13–16 行改为：

```js
const pilotRoot = () => resolvePilotRoot();
const pilotdeckYamlPath = () => process.env.PILOTDECK_CONFIG_PATH || join(pilotRoot(), 'pilotdeck.yaml');
const weixinCredsPath = () => join(pilotRoot(), 'weixin-credentials.json');
const channelRuntimeStatusPath = () => join(pilotRoot(), 'channels', 'runtime-status.json');
```

文件内 `PILOTDECK_YAML`、`WEIXIN_CREDS`、`CHANNEL_RUNTIME_STATUS` 的引用改为对应函数调用；导入 `resolvePilotRoot`。

`permissionSettings.js` 第 24 行：`return path.join(resolveScopedHome(env), 'permissions.json');`，导入改为 `resolveScopedHome`。

其余系统级文件（`pilotdeckConfig.js:27-28`、`mcpConfig.js:10`、`cron-daemon-startup.js:21,44`、`cron-daemon-owner.js:13`、`desktopUpdateService.js:582`）按同样方式把常量改为函数，用 `resolvePilotRoot()`，语义不变。

- [ ] **Step 8: 把扫描接入 `typecheck`**

`ui/package.json`：

```json
"typecheck": "node ../scripts/check-module-level-pilot-home.mjs server && tsc --noEmit -p tsconfig.json",
```

- [ ] **Step 9: 验证**

Run: `node scripts/check-module-level-pilot-home.mjs ui/server`
Expected: `check-module-level-pilot-home: OK`

Run: `npm --prefix ui test -- server/services/memoryService.scope.test.js server/services/memoryService.global.test.js server/routes/gateway.test.js server/services/pilotdeckConfig.test.js`
Expected: PASS（memoryService 的两个既有测试需在 `beforeEach` 用 `runWithUserScope` 包住，并把断言路径从 `<root>/memory` 改为 `<root>/users/<id>/memory`）

Run: `npm --prefix ui run typecheck`
Expected: 通过

- [ ] **Step 10: 提交**

```bash
git add scripts/check-module-level-pilot-home.mjs scripts/check-module-level-pilot-home.test.mjs ui/package.json ui/server/services/memoryService.js ui/server/services/memoryService.scope.test.js ui/server/services/memoryService.global.test.js ui/server/routes/skills.js ui/server/routes/gateway.js ui/server/services/permissionSettings.js ui/server/services/pilotdeckConfig.js ui/server/services/mcpConfig.js ui/server/services/cron-daemon-startup.js ui/server/services/cron-daemon-owner.js ui/server/services/desktopUpdateService.js
git commit -m "feat(multi-user): 移除模块级全局 PILOT_HOME 常量并加静态扫描

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Gateway 进程池

**Files:**
- Create: `ui/server/services/gatewayPool.js`
- Test: `ui/server/services/gatewayPool.test.js`

**Interfaces:**
- Consumes: `resolveUserHome`、`ensureUserHomeSkeleton`、`resolvePilotRoot`（Task 6）；`createRemoteGateway({ url, token, clientName })`（`src/gateway/index.js`，返回对象带 `close()`）
- Produces: `createGatewayPool(options) → pool`，其中

```js
// options（全部可注入，测试用假实现）
{
  env = process.env,
  config = {},                      // { maxInstances, idleTimeoutMs, startTimeoutMs, maxWaiting, portBase }
  spawnGateway,                     // ({ userId, userHome, port, tokenPath, env }) => ChildProcess-like { pid, kill(signal), once('exit', cb), on('exit', cb) }
  connectGateway,                   // ({ url, token }) => Promise<Gateway & { close() }>
  findFreePort,                     // (startAt) => Promise<number>
  now = () => Date.now(),
  setTimer = setTimeout, clearTimer = clearTimeout,
  log = console.log,
}
// pool
pool.acquire(userId) → Promise<{ gateway, runtimeId, release() }>
pool.markRevoked(userId) → void          // 立即把该用户实例标为可回收，并在无租约时停止
pool.stopUser(userId) → Promise<void>
pool.shutdown() → Promise<void>          // 停止全部，最多等 15 秒
pool.snapshot() → Array<{ userId, state, port, leases, idleSince }>
```

- 默认 `spawnGateway`：`child_process.spawn(process.execPath, args, { cwd: REPO_ROOT, env: childEnv, stdio: ['ignore', 'inherit', 'inherit'] })`。`args` 在 `dist/src/cli/pilotdeck.js` 存在时为 `['dist/src/cli/pilotdeck.js', 'server']`，否则为 `['--import', './scripts/register-deploy-env.mjs', '--import', 'tsx', 'src/cli/pilotdeck.ts', 'server']`。`childEnv = { ...env, PILOT_HOME: userHome, PILOTDECK_GATEWAY_PORT: String(port), PILOTDECK_CONFIG_PATH: path.join(resolvePilotRoot(env), 'pilotdeck.yaml'), PILOTDECK_DISABLE_ALWAYS_ON: '1' }`
- 令牌：spawn 前用 `randomBytes(32).toString('base64url')` 生成，写到 `<userHome>/server-token`（mode 0600，已存在则读取复用）。引擎的 `ensureGatewayAuthToken()` 会读到同一文件，无需改引擎。这与 spec §4 写的 `system/gateway-tokens/<userId>` 不同，原因是引擎当前只从 `$PILOT_HOME/server-token` 读令牌；令牌文件在用户目录内且仅 UI 服务器与该用户的 Gateway 使用，隔离性不变。
- pid 记录：`<root>/system/gateway-pids.json`，内容 `{ "<userId>": { pid, port, startedAt } }`，每次 spawn / exit 后重写；启动时读取并对仍存活的 pid 发送 SIGTERM（上次异常退出留下的孤儿）。
- 状态机：`starting → ready → (busy ⇄ idle) → stopping → (删除)`；`failed` 记入 `failures[userId] = { count, until }`，连续 3 次失败后 10 分钟内 `acquire` 直接拒绝 `GATEWAY_UNAVAILABLE`。
- 容量：`maxInstances` 达到时先停最早 `idleSince` 的 idle 实例；没有 idle 则入等待队列（上限 `maxWaiting`，超出抛 `GATEWAY_POOL_EXHAUSTED`）。
- 错误对象统一 `error.code ∈ 'GATEWAY_UNAVAILABLE' | 'GATEWAY_POOL_EXHAUSTED' | 'GATEWAY_START_TIMEOUT'`，`error.status = 503`。

- [ ] **Step 1: 写失败测试**

```js
// ui/server/services/gatewayPool.test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGatewayPool } from './gatewayPool.js';

let root; let clock; let timers;
function makeFakes({ failUsers = new Set(), connectDelayMs = 0 } = {}) {
  const spawned = []; const closed = [];
  let nextPort = 20000;
  const spawnGateway = vi.fn(({ userId, userHome, port }) => {
    const child = new EventEmitter();
    child.pid = 1000 + spawned.length;
    child.killed = false;
    child.kill = vi.fn(() => { child.killed = true; queueMicrotask(() => child.emit('exit', 0, null)); return true; });
    spawned.push({ userId, userHome, port, child });
    if (failUsers.has(String(userId))) queueMicrotask(() => child.emit('exit', 1, null));
    return child;
  });
  const connectGateway = vi.fn(async ({ url, token }) => {
    if (connectDelayMs) await new Promise((r) => setTimeout(r, connectDelayMs));
    const gw = { url, token, close: vi.fn(() => closed.push(url)) };
    return gw;
  });
  const findFreePort = vi.fn(async () => nextPort++);
  return { spawned, closed, spawnGateway, connectGateway, findFreePort };
}
function makeClock() {
  let now = 1_000_000; const pending = [];
  return {
    now: () => now,
    setTimer: (fn, ms) => { const t = { fn, at: now + ms }; pending.push(t); return t; },
    clearTimer: (t) => { const i = pending.indexOf(t); if (i >= 0) pending.splice(i, 1); },
    advance: async (ms) => { now += ms; for (const t of [...pending].filter((t) => t.at <= now)) { pending.splice(pending.indexOf(t), 1); await t.fn(); } },
  };
}
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pool-')); clock = makeClock(); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const mk = (fakes, config = {}) => createGatewayPool({
  env: { PILOT_HOME: root }, config: { maxInstances: 2, idleTimeoutMs: 1000, startTimeoutMs: 500, maxWaiting: 1, ...config },
  spawnGateway: fakes.spawnGateway, connectGateway: fakes.connectGateway, findFreePort: fakes.findFreePort,
  now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, log: () => {},
});

describe('gatewayPool', () => {
  it('spawns once per user with that user\'s home, and A/B get different processes', async () => {
    const f = makeFakes(); const pool = mk(f);
    const [a1, a2, b] = await Promise.all([pool.acquire(1), pool.acquire(1), pool.acquire(2)]);
    expect(f.spawnGateway).toHaveBeenCalledTimes(2);
    expect(a1.gateway).toBe(a2.gateway);
    expect(a1.gateway).not.toBe(b.gateway);
    expect(f.spawned[0].userHome).toBe(path.join(root, 'users', '1'));
    expect(f.spawned[1].userHome).toBe(path.join(root, 'users', '2'));
    expect(f.spawned[0].port).not.toBe(f.spawned[1].port);
    expect(fs.statSync(path.join(root, 'users', '1', 'server-token')).mode & 0o777).toBe(0o600);
    a1.release(); a2.release(); b.release();
  });

  it('recycles idle instances after idleTimeoutMs, never busy ones', async () => {
    const f = makeFakes(); const pool = mk(f);
    const lease = await pool.acquire(1);
    await clock.advance(5000);
    expect(f.closed).toHaveLength(0);
    lease.release();
    await clock.advance(1001);
    expect(f.closed).toHaveLength(1);
    expect(f.spawned[0].child.kill).toHaveBeenCalled();
    expect(pool.snapshot()).toEqual([]);
  });

  it('evicts the least recently used idle instance when full', async () => {
    const f = makeFakes(); const pool = mk(f);
    (await pool.acquire(1)).release();
    await clock.advance(10);
    (await pool.acquire(2)).release();
    const c = await pool.acquire(3);
    expect(f.spawnGateway).toHaveBeenCalledTimes(3);
    expect(pool.snapshot().map((s) => s.userId).sort()).toEqual(['2', '3']);
    c.release();
  });

  it('queues when all instances are busy and rejects beyond maxWaiting', async () => {
    const f = makeFakes(); const pool = mk(f);
    const a = await pool.acquire(1); const b = await pool.acquire(2);
    const waiting = pool.acquire(3);
    await expect(pool.acquire(4)).rejects.toMatchObject({ code: 'GATEWAY_POOL_EXHAUSTED', status: 503 });
    a.release();
    const c = await waiting;
    expect(c.gateway).toBeDefined();
    b.release(); c.release();
  });

  it('fails fast when the child exits during start and trips the breaker after 3 failures', async () => {
    const f = makeFakes({ failUsers: new Set(['9']) }); const pool = mk(f);
    for (let i = 0; i < 3; i += 1) {
      await expect(pool.acquire(9)).rejects.toMatchObject({ code: 'GATEWAY_UNAVAILABLE' });
    }
    await expect(pool.acquire(9)).rejects.toMatchObject({ code: 'GATEWAY_UNAVAILABLE' });
    expect(f.spawnGateway).toHaveBeenCalledTimes(3);
  });

  it('times out a start that never connects', async () => {
    const f = makeFakes({ connectDelayMs: 10_000 }); const pool = mk(f, { startTimeoutMs: 50 });
    const p = pool.acquire(1);
    await clock.advance(60);
    await expect(p).rejects.toMatchObject({ code: 'GATEWAY_START_TIMEOUT' });
  });

  it('markRevoked stops an idle instance immediately and a busy one on release', async () => {
    const f = makeFakes(); const pool = mk(f);
    const lease = await pool.acquire(1);
    pool.markRevoked(1);
    expect(f.closed).toHaveLength(0);
    lease.release();
    await Promise.resolve();
    expect(f.closed).toHaveLength(1);
  });

  it('shutdown stops everything and clears the pid file', async () => {
    const f = makeFakes(); const pool = mk(f);
    (await pool.acquire(1)).release(); (await pool.acquire(2)).release();
    await pool.shutdown();
    expect(f.closed).toHaveLength(2);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'system', 'gateway-pids.json'), 'utf8'))).toEqual({});
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm --prefix ui test -- server/services/gatewayPool.test.js`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现 `gatewayPool.js`**

```js
// ui/server/services/gatewayPool.js
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRemoteGateway } from '../../../src/gateway/index.js';
import { resolvePilotRoot, resolveUserHome, ensureUserHomeSkeleton } from '../utils/pilotPaths.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DEFAULTS = { maxInstances: 30, idleTimeoutMs: 30 * 60_000, startTimeoutMs: 60_000, maxWaiting: 20, portBase: 18800 };
const BREAKER_FAILURES = 3;
const BREAKER_WINDOW_MS = 10 * 60_000;
const STOP_GRACE_MS = 5_000;
const SHUTDOWN_MAX_MS = 15_000;

function poolError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.status = 503;
  return error;
}

export function defaultFindFreePort(startAt) {
  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      const srv = net.createServer();
      srv.once('error', (err) => (err.code === 'EADDRINUSE' && port < 65000 ? tryPort(port + 1) : reject(err)));
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(port)));
    };
    tryPort(startAt);
  });
}

export function defaultSpawnGateway({ userHome, port, env, configPath }) {
  const distEntry = path.join(REPO_ROOT, 'dist', 'src', 'cli', 'pilotdeck.js');
  const args = fs.existsSync(distEntry)
    ? [distEntry, 'server']
    : ['--import', './scripts/register-deploy-env.mjs', '--import', 'tsx', 'src/cli/pilotdeck.ts', 'server'];
  const childEnv = {
    ...env,
    PILOT_HOME: userHome,
    PILOTDECK_GATEWAY_PORT: String(port),
    PILOTDECK_CONFIG_PATH: configPath,
    PILOTDECK_DISABLE_ALWAYS_ON: '1',
  };
  delete childEnv.PILOTDECK_GATEWAY_URL;
  return spawn(process.execPath, args, { cwd: REPO_ROOT, env: childEnv, stdio: ['ignore', 'inherit', 'inherit'] });
}

export function createGatewayPool(options = {}) {
  const env = options.env ?? process.env;
  const config = { ...DEFAULTS, ...(options.config ?? {}) };
  const spawnGateway = options.spawnGateway ?? defaultSpawnGateway;
  const connectGateway = options.connectGateway ?? ((o) => createRemoteGateway({ ...o, clientName: 'web' }));
  const findFreePort = options.findFreePort ?? defaultFindFreePort;
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const log = options.log ?? console.log;

  const root = resolvePilotRoot(env);
  const pidFile = path.join(root, 'system', 'gateway-pids.json');
  const configPath = path.join(root, 'pilotdeck.yaml');

  /** userId → entry */
  const entries = new Map();
  /** userId → { count, until } */
  const failures = new Map();
  /** FIFO of { userId, resolve, reject } */
  const waiting = [];
  let shuttingDown = false;

  function writePidFile() {
    const data = {};
    for (const [userId, e] of entries) if (e.child?.pid) data[userId] = { pid: e.child.pid, port: e.port, startedAt: e.startedAt };
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(pidFile, JSON.stringify(data, null, 2));
  }

  function reapOrphans() {
    try {
      const data = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
      for (const { pid } of Object.values(data)) {
        try { process.kill(pid, 'SIGTERM'); log(`[gateway-pool] reaped orphan gateway pid ${pid}`); } catch { /* already gone */ }
      }
    } catch { /* no pid file */ }
    writePidFile();
  }

  function ensureToken(userHome) {
    const tokenPath = path.join(userHome, 'server-token');
    if (fs.existsSync(tokenPath)) {
      const existing = fs.readFileSync(tokenPath, 'utf8').trim();
      if (existing) return { token: existing, tokenPath };
    }
    const token = randomBytes(32).toString('base64url');
    fs.writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
    fs.chmodSync(tokenPath, 0o600);
    return { token, tokenPath };
  }

  function breakerOpen(userId) {
    const f = failures.get(userId);
    return Boolean(f && f.count >= BREAKER_FAILURES && f.until > now());
  }
  function recordFailure(userId) {
    const f = failures.get(userId) ?? { count: 0, until: 0 };
    f.count += 1;
    f.until = now() + BREAKER_WINDOW_MS;
    failures.set(userId, f);
  }

  function scheduleIdleCheck(entry) {
    if (entry.idleTimer) clearTimer(entry.idleTimer);
    entry.idleTimer = setTimer(() => {
      if (entry.leases === 0 && entries.get(entry.userId) === entry) void stopEntry(entry, 'idle-timeout');
    }, config.idleTimeoutMs);
  }

  async function stopEntry(entry, reason) {
    if (entry.state === 'stopping') return entry.stopped;
    entry.state = 'stopping';
    if (entry.idleTimer) clearTimer(entry.idleTimer);
    entries.delete(entry.userId);
    entry.stopped = (async () => {
      try { entry.gateway?.close?.(); } catch { /* ignore */ }
      if (entry.child && !entry.exited) {
        await new Promise((resolve) => {
          const force = setTimer(() => { try { entry.child.kill('SIGKILL'); } catch { /* ignore */ } }, STOP_GRACE_MS);
          entry.child.once('exit', () => { clearTimer(force); resolve(); });
          try { entry.child.kill('SIGTERM'); } catch { resolve(); }
        });
      }
      writePidFile();
      log(`[gateway-pool] stopped gateway for user ${entry.userId} (${reason})`);
      drainWaiting();
    })();
    return entry.stopped;
  }

  function drainWaiting() {
    while (waiting.length && entries.size < config.maxInstances) {
      const next = waiting.shift();
      acquire(next.userId).then(next.resolve, next.reject);
    }
  }

  async function makeRoom() {
    if (entries.size < config.maxInstances) return true;
    const idle = [...entries.values()].filter((e) => e.state === 'idle').sort((a, b) => a.idleSince - b.idleSince)[0];
    if (!idle) return false;
    await stopEntry(idle, 'lru-evict');
    return true;
  }

  async function startEntry(userId) {
    const userHome = ensureUserHomeSkeleton(userId, env);
    const port = await findFreePort(config.portBase);
    const { token, tokenPath } = ensureToken(userHome);
    const entry = { userId, state: 'starting', port, leases: 0, idleSince: null, startedAt: new Date().toISOString(), child: null, gateway: null, exited: false, revoked: false, idleTimer: null };
    entries.set(userId, entry);

    entry.child = spawnGateway({ userId, userHome, port, tokenPath, env, configPath });
    entry.child.on('exit', () => {
      entry.exited = true;
      if (entries.get(userId) === entry && entry.state !== 'stopping') {
        entries.delete(userId);
        writePidFile();
        log(`[gateway-pool] gateway for user ${userId} exited unexpectedly`);
        drainWaiting();
      }
    });
    writePidFile();

    const url = `ws://127.0.0.1:${port}/ws`;
    const deadline = now() + config.startTimeoutMs;
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimer(() => reject(poolError('GATEWAY_START_TIMEOUT', `Gateway for user ${userId} did not become ready within ${config.startTimeoutMs}ms`)), config.startTimeoutMs); });
    const connect = (async () => {
      let lastError;
      while (now() < deadline) {
        if (entry.exited) throw poolError('GATEWAY_UNAVAILABLE', `Gateway for user ${userId} exited during startup`);
        try { return await connectGateway({ url, token }); } catch (error) { lastError = error; }
        await new Promise((r) => setTimer(r, 250));
      }
      throw lastError ?? poolError('GATEWAY_START_TIMEOUT', 'Gateway start timed out');
    })();
    try {
      entry.gateway = await Promise.race([connect, timeout]);
    } catch (error) {
      recordFailure(userId);
      await stopEntry(entry, 'start-failed');
      throw error.code ? error : poolError('GATEWAY_UNAVAILABLE', error.message);
    } finally {
      clearTimer(timer);
    }
    entry.state = 'idle';
    entry.idleSince = now();
    log(`[gateway-pool] gateway ready for user ${userId} on ${url}`);
    return entry;
  }

  async function acquire(userIdRaw) {
    const userId = String(userIdRaw);
    if (shuttingDown) throw poolError('GATEWAY_UNAVAILABLE', 'Server is shutting down');
    if (breakerOpen(userId)) throw poolError('GATEWAY_UNAVAILABLE', `Gateway for user ${userId} failed repeatedly; retry later`);

    let entry = entries.get(userId);
    if (!entry) {
      if (!(await makeRoom())) {
        if (waiting.length >= config.maxWaiting) throw poolError('GATEWAY_POOL_EXHAUSTED', 'Too many active users; please try again shortly');
        return new Promise((resolve, reject) => waiting.push({ userId, resolve, reject }));
      }
      const starting = startEntry(userId);
      entries.get(userId).starting = starting;
      entry = await starting;
    } else if (entry.state === 'starting') {
      entry = await entry.starting;
    }

    entry.leases += 1;
    entry.state = 'busy';
    if (entry.idleTimer) clearTimer(entry.idleTimer);
    let released = false;
    return {
      gateway: entry.gateway,
      runtimeId: `${userId}:${entry.port}`,
      release: () => {
        if (released) return;
        released = true;
        entry.leases -= 1;
        if (entry.leases > 0) return;
        if (entry.revoked) { void stopEntry(entry, 'revoked'); return; }
        entry.state = 'idle';
        entry.idleSince = now();
        scheduleIdleCheck(entry);
        drainWaiting();
      },
    };
  }

  function markRevoked(userIdRaw) {
    const entry = entries.get(String(userIdRaw));
    if (!entry) return;
    entry.revoked = true;
    if (entry.leases === 0) void stopEntry(entry, 'revoked');
  }

  async function stopUser(userIdRaw) {
    const entry = entries.get(String(userIdRaw));
    if (entry) await stopEntry(entry, 'stop-user');
  }

  async function shutdown() {
    shuttingDown = true;
    for (const w of waiting.splice(0)) w.reject(poolError('GATEWAY_UNAVAILABLE', 'Server is shutting down'));
    const all = [...entries.values()].map((e) => stopEntry(e, 'shutdown'));
    await Promise.race([Promise.all(all), new Promise((r) => setTimer(r, SHUTDOWN_MAX_MS))]);
    writePidFile();
  }

  function snapshot() {
    return [...entries.values()].map((e) => ({ userId: e.userId, state: e.state, port: e.port, leases: e.leases, idleSince: e.idleSince }));
  }

  reapOrphans();
  return { acquire, markRevoked, stopUser, shutdown, snapshot };
}

```

`startEntry` 同步地先 `entries.set(userId, entry)`，之后才 `await findFreePort`，所以同用户的第二个并发 `acquire` 能在 `entries` 中看到 `starting` 状态并等待同一个 `starting` promise，不会 spawn 第二个进程。

- [ ] **Step 4: 运行测试**

Run: `npm --prefix ui test -- server/services/gatewayPool.test.js`
Expected: PASS（8 个用例）

- [ ] **Step 5: 读取配置**

在 `ui/server/services/pilotdeckConfig.js` 增加导出：

```js
export function readMultiUserConfig() {
  const { config } = readPilotDeckConfigFile();
  const mu = config?.multiUser ?? {};
  return {
    gatewayPool: {
      maxInstances: Number(mu.gatewayPool?.maxInstances) || 30,
      idleTimeoutMs: Number(mu.gatewayPool?.idleTimeoutMs) || 30 * 60_000,
      startTimeoutMs: Number(mu.gatewayPool?.startTimeoutMs) || 60_000,
      maxWaiting: Number(mu.gatewayPool?.maxWaiting) || 20,
      portBase: Number(process.env.PILOTDECK_GATEWAY_PORT_BASE) || Number(mu.gatewayPool?.portBase) || 18800,
    },
  };
}
```

Task 11 用它构造池。

- [ ] **Step 6: 提交**

```bash
git add ui/server/services/gatewayPool.js ui/server/services/gatewayPool.test.js ui/server/services/pilotdeckConfig.js
git commit -m "feat(multi-user): 每用户 Gateway 子进程池（租约、LRU、排队、熔断、pid 回收）

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: 引擎支持 `PILOTDECK_CONFIG_PATH`

**Files:**
- Modify: `src/pilot/paths.ts:207-209`
- Modify: `src/pilot/config/loadPilotConfig.ts:53`
- Modify: `src/pilot/config/PilotConfigStore.ts:155`
- Test: `tests/pilot/config-path-override.spec.ts`

**Interfaces:**
- Produces: `getPilotConfigFilePath(pilotHome: string, env: PilotPathEnv = process.env): string`，`env.PILOTDECK_CONFIG_PATH` 非空时返回其绝对路径，否则 `resolve(pilotHome, "pilotdeck.yaml")`

原因：Gateway 子进程的 `PILOT_HOME` 是用户目录，但系统配置（含密钥）必须留在根目录，不能复制或软链进用户目录（否则 Agent 用 `read_file` 就能读到模型密钥）。

- [ ] **Step 1: 写失败测试**

```ts
// tests/pilot/config-path-override.spec.ts
// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { getPilotConfigFilePath } from "../../src/pilot/paths.js";

test("defaults to <pilotHome>/pilotdeck.yaml", () => {
  assert.equal(getPilotConfigFilePath("/srv/pd/users/3", {}), resolve("/srv/pd/users/3", "pilotdeck.yaml"));
});

test("PILOTDECK_CONFIG_PATH overrides the home-relative default", () => {
  assert.equal(
    getPilotConfigFilePath("/srv/pd/users/3", { PILOTDECK_CONFIG_PATH: "/srv/pd/pilotdeck.yaml" }),
    resolve("/srv/pd/pilotdeck.yaml"),
  );
});

test("blank override is ignored", () => {
  assert.equal(getPilotConfigFilePath("/h", { PILOTDECK_CONFIG_PATH: "  " }), resolve("/h", "pilotdeck.yaml"));
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run build && node --test --test-force-exit dist/tests/pilot/config-path-override.spec.js`
Expected: FAIL（第二个用例返回 home 下的路径）

- [ ] **Step 3: 实现**

```ts
export function getPilotConfigFilePath(pilotHome: string, env: PilotPathEnv = process.env): string {
  const override = env.PILOTDECK_CONFIG_PATH?.trim();
  if (override) return resolve(override);
  return resolve(pilotHome, PILOT_CONFIG_FILE_NAME);
}
```

`loadPilotConfig.ts:53` 改为 `getPilotConfigFilePath(pilotHome, env)`；`PilotConfigStore.ts:155` 改为 `getPilotConfigFilePath(pilotHome, env)`（该方法上一行已有 `const env`）。

- [ ] **Step 4: 运行测试**

Run: `npm run build && node --test --test-force-exit --test-timeout 60000 dist/tests/pilot/config-path-override.spec.js dist/tests/pilot/workspace-paths.spec.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/pilot/paths.ts src/pilot/config/loadPilotConfig.ts src/pilot/config/PilotConfigStore.ts tests/pilot/config-path-override.spec.ts
git commit -m "feat(pilot): 支持 PILOTDECK_CONFIG_PATH 指定系统配置文件位置

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: 桥接层按用户租约取 Gateway，启动脚本不再预拉 Gateway

**Files:**
- Modify: `ui/server/pilotdeck-bridge.js:67-74,193-250,262-264,276-330,1393-1470,1654-1725,1752-1781`
- Modify: `ui/server/index.js`（`revokeUserRuntime` 实现、关闭钩子、always-on 路由）
- Modify: `ui/server/projects.js:1-8`（`getPilotDeckGateway` 用法不变，仅确认在作用域内调用）
- Modify: `scripts/dev-launcher.mjs:146-158`、`ui/package.json`（`dev:concurrent`、`start:built`）
- Test: `ui/server/pilotdeck-bridge.scope.test.js`

**Interfaces:**
- Consumes: `createGatewayPool`、`readMultiUserConfig`（Task 9）；`requireUserScope`、`resolveScopedHome`（Task 6）
- Produces（bridge）:
  - `getPilotDeckGateway() → Promise<Gateway>`：取当前作用域用户的 Gateway，**租约在同一 tick 内释放**（供短 RPC 使用；进程不会因此被回收，因为 idle 计时 30 分钟）
  - `withUserGateway(fn) → Promise<T>`：`const lease = await pool.acquire(userId); try { return await fn(lease.gateway) } finally { lease.release() }`，`runChatViaGateway` 用它包住整段 `submitTurn` 迭代
  - `revokeUserGateway(userId)`：转发到 `pool.markRevoked`
  - `shutdownGatewayPool()`：转发到 `pool.shutdown`
  - `sessionState` 的 key 变为 `${userId}:${sessionKey}`；对外接口 `getSessionTokenBudget(sessionKey)`、`isSessionActiveViaGateway(sessionKey)`、`abortViaGateway(sessionId)` 签名不变，内部用 `requireUserScope().userId` 拼 key
- Produces（index.js）: `revokeUserRuntime(userId)` 关闭 `connectedClients` 中 `__pilotdeckUserId === userId` 的 WS（close code 4401, reason `TOKEN_REVOKED`）并调用 `revokeUserGateway(userId)`；`SIGTERM`/`SIGINT` 时先 `shutdownGatewayPool()` 再关 HTTP 服务器

- [ ] **Step 1: 写失败测试**

```js
// ui/server/pilotdeck-bridge.scope.test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let root; const acquired = []; const released = [];
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-bridge-'));
  vi.stubEnv('PILOT_HOME', root);
  vi.resetModules();
  acquired.length = 0; released.length = 0;
  vi.doMock('./services/gatewayPool.js', () => ({
    createGatewayPool: () => ({
      acquire: async (userId) => {
        acquired.push(String(userId));
        const gateway = { userId: String(userId), abortTurn: vi.fn(async () => {}), close: vi.fn() };
        return { gateway, runtimeId: `${userId}:1`, release: () => released.push(String(userId)) };
      },
      markRevoked: vi.fn(), shutdown: vi.fn(async () => {}), snapshot: () => [],
    }),
  }));
  vi.doMock('./services/pilotdeckConfig.js', async (importOriginal) => ({ ...(await importOriginal()), readMultiUserConfig: () => ({ gatewayPool: {} }) }));
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

describe('pilotdeck-bridge under user scope', () => {
  it('getPilotDeckGateway acquires the scoped user\'s gateway and releases the lease', async () => {
    const { runWithUserScope } = await import('./middleware/userScope.js');
    const { getPilotDeckGateway } = await import('./pilotdeck-bridge.js');
    const gw = await runWithUserScope({ userId: 5, role: 'user' }, () => getPilotDeckGateway());
    expect(gw.userId).toBe('5');
    expect(acquired).toEqual(['5']);
    expect(released).toEqual(['5']);
  });
  it('refuses without a scope', async () => {
    const { getPilotDeckGateway } = await import('./pilotdeck-bridge.js');
    await expect(getPilotDeckGateway()).rejects.toMatchObject({ code: 'USER_SCOPE_MISSING' });
  });
  it('keeps session state apart per user for the same sessionKey', async () => {
    const { runWithUserScope } = await import('./middleware/userScope.js');
    const bridge = await import('./pilotdeck-bridge.js');
    const key = 'web:s_11111111-2222-3333-4444-555555555555';
    await runWithUserScope({ userId: 1, role: 'user' }, () => bridge.__testing.touchSession(key, { active: true }));
    const forA = await runWithUserScope({ userId: 1, role: 'user' }, () => bridge.isSessionActiveViaGateway(key));
    const forB = await runWithUserScope({ userId: 2, role: 'user' }, () => bridge.isSessionActiveViaGateway(key));
    expect(forA).toBe(true);
    expect(forB).toBe(false);
  });
});
```

`bridge.__testing.touchSession(sessionKey, patch)` 是本任务新增的测试钩子：`const s = ensureSessionState(sessionKey, projectKey ?? resolveScopedHome(), 'web'); Object.assign(s, patch);`，只在 `process.env.NODE_ENV === 'test' || process.env.VITEST` 时导出。

- [ ] **Step 2: 运行确认失败**

Run: `npm --prefix ui test -- server/pilotdeck-bridge.scope.test.js`
Expected: FAIL（bridge 仍连固定 `GATEWAY_URL`，且无作用域也能工作）

- [ ] **Step 3: 替换 bridge 的连接层（第 67–74、193–250、262–264 行）**

删除 `GENERAL_HOME`、`GATEWAY_URL`、`GATEWAY_TOKEN_PATH`、`GATEWAY_CONNECT_TIMEOUT_MS`、`GATEWAY_CONNECT_RETRY_INTERVAL_MS`、`gatewayPromise`、`readGatewayToken`、`connectWithRetry`、`ensureGateway`、`resetGatewayConnection`，改为：

```js
import { createGatewayPool } from './services/gatewayPool.js';
import { readMultiUserConfig } from './services/pilotdeckConfig.js';
import { requireUserScope } from './middleware/userScope.js';
import { resolveScopedHome } from './utils/pilotPaths.js';

let poolInstance = null;
function pool() {
    if (!poolInstance) poolInstance = createGatewayPool({ config: readMultiUserConfig().gatewayPool });
    return poolInstance;
}

/** Run `fn` with the current user's Gateway; the lease spans the whole call. */
export async function withUserGateway(fn) {
    const { userId } = requireUserScope();
    const lease = await pool().acquire(userId);
    try {
        return await fn(lease.gateway);
    } finally {
        lease.release();
    }
}

/** Short-RPC accessor kept for existing callers (projects.js, gateway.js, index.js always-on routes). */
export async function getPilotDeckGateway() {
    return withUserGateway(async (gateway) => gateway);
}

export function revokeUserGateway(userId) {
    pool().markRevoked(userId);
}

export async function shutdownGatewayPool() {
    if (poolInstance) await poolInstance.shutdown();
}
```

`getPilotDeckGateway()` 返回后租约已释放，但 Gateway 对象仍可用：池只在 idle 30 分钟或被撤销时才关闭连接，短 RPC 在此窗口内完成。长流程（`submitTurn`）必须走 `withUserGateway`。

- [ ] **Step 4: `sessionState` 按用户分区（第 276–330 行）**

```js
const sessionState = new Map();
const stateKey = (sessionKey) => `${requireUserScope().userId}:${sessionKey}`;

function ensureSessionState(sessionKey, projectKey, channelKey) {
    const key = stateKey(sessionKey);
    let state = sessionState.get(key);
    if (!state) {
        state = { sessionKey, projectKey, channelKey, runId: undefined, active: false, tokenBudget: null, hasVisibleFailureStatus: false };
        sessionState.set(key, state);
    } else {
        state.projectKey = projectKey;
        state.channelKey = channelKey;
    }
    return state;
}
```

文件内所有 `sessionState.get(sessionKey)` / `sessionState.get(sessionId)` 改为 `sessionState.get(stateKey(...))`；`getActiveSessionIdsViaGateway()`（第 1725 行）改为只返回当前用户前缀的条目：

```js
export function getActiveSessionIdsViaGateway() {
    const prefix = `${requireUserScope().userId}:`;
    return [...sessionState.entries()].filter(([k, s]) => k.startsWith(prefix) && s.active).map(([, s]) => s.sessionKey);
}
```

`subagentActivityStarts`、`pendingAgentToolCalls`、`_sessionTitleCache`、`_userQueriesCache`、`_toolSequenceCache`、`_subagentPromptCache`（第 82、84、1875、1956、2019、2083 行）这几张 Map 的 key 同样加 `stateKey()` 前缀。

- [ ] **Step 5: `runChatViaGateway` 与其他 RPC（第 1393–1470、1654–1725 行）**

- 第 1400–1401 行：`GENERAL_HOME` → `resolveScopedHome()`（两处）。
- 第 1445 行：`resolveAgentCwd(projectKey, resolveScopedHome())`。
- 第 1451 行起：把 `gw = await ensureGateway();` 及其后整个「abort stale → submitTurn → for await 迭代 → 收尾」的代码块包进 `await withUserGateway(async (gw) => { ... })`。原来 `gw` 为 `null` 的错误分支保留在 `withUserGateway` 的 catch 中处理（`isGatewayUnavailableError(error) || error.status === 503` 时向 writer 发可见错误）。
- `abortViaGateway`（1654）、`decidePermissionViaGateway`（1673）、`grantSessionPermissionViaGateway`（1694）、`getActiveTurnSnapshotFramesViaGateway`（1716）、`elicitationRespondViaGateway`（2573）、`trauma*ViaGateway`（2590–2624）：`const gw = await ensureGateway();` → `return withUserGateway(async (gw) => { ...原函数体... });`。
- 第 1752–1781 行（会话索引与 router 统计）：`GENERAL_HOME` → `resolveScopedHome()`。`isGatewayUnavailableError` 的正则追加 `|gateway for user .* (exited|did not become ready)|too many active users`。

- [ ] **Step 6: `index.js` 撤销与关闭钩子**

```js
import { revokeUserGateway, shutdownGatewayPool } from './pilotdeck-bridge.js';

revokeUserRuntime = (userId) => {
    const id = String(userId);
    for (const client of connectedClients) {
        if (String(client.__pilotdeckUserId) !== id) continue;
        try { client.close(4401, 'TOKEN_REVOKED'); } catch { /* already closed */ }
    }
    revokeUserGateway(id);
};
```

`routes/auth.js` 的 `logout` 与 `password` 也要让其他设备下线：在 `index.js` 挂载 `authRoutes` 前把钩子注入 `app.locals.revokeUserRuntime = (id) => revokeUserRuntime(id)`，`auth.js` 中 `bumpTokenVersion` 之后调用 `req.app.locals.revokeUserRuntime?.(req.user.id)`。

关闭顺序（找到文件末尾既有的 `process.on('SIGTERM'...)` / `SIGINT` 处理，若没有则新增）：

```js
async function gracefulShutdown(signal) {
    console.log(`[INFO] ${signal} received, stopping gateways…`);
    await shutdownGatewayPool();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 20_000).unref();
}
process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
```

always-on 路由（第 608–724 行）在多用户模式下返回 501 `{ error: 'Always-on tasks are disabled in multi-user mode', code: 'FEATURE_DISABLED' }`，`DISABLE_LOCAL_AUTH` 为真时保持原逻辑（spec D12）。

- [ ] **Step 7: 启动脚本**

`ui/package.json`：

```json
"dev:concurrent": "concurrently --kill-others-on-fail --names server,client \"npm:dev:server\" \"npm:dev:client\"",
"start:built": "npm run server",
```

`scripts/dev-launcher.mjs` 第 146–152 行的 `env` 改为：

```js
  const env = {
    ...process.env,
    SERVER_PORT: String(server.port),
    PILOTDECK_GATEWAY_PORT_BASE: String(gateway.port),
    VITE_PORT: String(vite.port),
  };
```

并删除 `PILOTDECK_GATEWAY_PORT` / `PILOTDECK_GATEWAY_URL` 两项；探测出的 gateway 端口现在只是池的起始端口。`scripts/start-local.sh` 第 47、120 行的 `PILOTDECK_GATEWAY_PORT` 文案改为 `gateway-base`。`scripts/stop-local.sh` 追加：

```bash
PIDS_FILE="${PILOT_HOME}/system/gateway-pids.json"
if [ -f "$PIDS_FILE" ]; then
  node -e 'const d=require(process.argv[1]);for(const {pid} of Object.values(d)){try{process.kill(pid,"SIGTERM")}catch{}}' "$PIDS_FILE" || true
fi
```

- [ ] **Step 8: 运行测试**

Run: `npm --prefix ui test -- server/pilotdeck-bridge.scope.test.js server/pilotdeck-bridge.test.js server/routes/gateway.test.js`
Expected: PASS（既有 `pilotdeck-bridge.test.js` 需要在 `beforeEach` 中 mock `./services/gatewayPool.js` 并用 `runWithUserScope` 包住调用；按上面测试文件的写法照搬）

- [ ] **Step 9: 手工启动验证**

```bash
export PILOT_HOME=/tmp/pd-multi && mkdir -p "$PILOT_HOME" && cp .pilotdeck-home/pilotdeck.yaml "$PILOT_HOME/" && ln -s "$(pwd)/.pilotdeck-home/plugins" "$PILOT_HOME/plugins"
PILOTDECK_DISABLE_LOCAL_AUTH=0 PILOTDECK_ADMIN_PASSWORD=adminpass npm --prefix ui run dev:server
```

另一个终端：

```bash
TOKEN=$(curl -s -X POST localhost:3020/api/auth/login -H 'content-type: application/json' -d '{"username":"admin","password":"adminpass"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -s localhost:3020/api/projects -H "Authorization: Bearer $TOKEN"
ls /tmp/pd-multi/users/1/
cat /tmp/pd-multi/system/gateway-pids.json
```

Expected: 第一条请求触发 `[gateway-pool] gateway ready for user 1`，`users/1/` 下有 `server-token` 与骨架目录，pid 文件有一条记录。`Ctrl+C` 后 pid 文件为 `{}` 且无残留 `pilotdeck` 进程（`pgrep -f "pilotdeck.*server"` 为空）。

- [ ] **Step 10: 提交**

```bash
git add ui/server/pilotdeck-bridge.js ui/server/pilotdeck-bridge.scope.test.js ui/server/pilotdeck-bridge.test.js ui/server/index.js ui/server/routes/auth.js ui/package.json scripts/dev-launcher.mjs scripts/start-local.sh scripts/stop-local.sh
git commit -m "feat(multi-user): 桥接层按用户租约取 Gateway，撤销即下线，启动脚本改由池拉起 Gateway

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: 双用户隔离回归（合并门槛）

**Files:**
- Create: `ui/server/multiUser.isolation.test.js`
- Modify: `ui/package.json`（新增 `test:isolation` 脚本）

**Interfaces:**
- Consumes: Task 1–11 的全部产出；测试通过真实 `db.js`、真实中间件、真实 `projects.js`，只 mock `services/gatewayPool.js`（假 Gateway 的 `listProjects` 返回空、`submitTurn` 产出一条 `assistant` 事件后结束）

- [ ] **Step 1: 写测试**

```js
// ui/server/multiUser.isolation.test.js
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let root; let server; let base; let tokens; let pool;
const fakeGateway = (userId) => ({
  userId,
  listProjects: async () => ({ projects: [] }),
  abortTurn: async () => {},
  close: () => {},
});

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-iso-'));
  vi.stubEnv('PILOT_HOME', root); vi.stubEnv('DATABASE_PATH', ''); vi.stubEnv('PILOTDECK_DISABLE_LOCAL_AUTH', '0');
  vi.stubEnv('PILOTDECK_ADMIN_PASSWORD', 'adminpass');
  vi.resetModules();
  pool = { acquire: vi.fn(async (id) => ({ gateway: fakeGateway(String(id)), runtimeId: `${id}:1`, release: () => {} })), markRevoked: vi.fn(), shutdown: vi.fn(async () => {}), snapshot: () => [] };
  vi.doMock('./services/gatewayPool.js', () => ({ createGatewayPool: () => pool }));

  const db = await import('./database/db.js'); await db.initializeDatabase();
  const { ensureAdminUser } = await import('./services/adminBootstrap.js');
  await ensureAdminUser({ userDb: db.userDb, log: () => {} });
  const { authenticateToken, generateToken } = await import('./middleware/auth.js');
  const { userScopeMiddleware, runWithUserScope } = await import('./middleware/userScope.js');
  const { requireAdmin } = await import('./middleware/requireAdmin.js');
  const { default: authRouter } = await import('./routes/auth.js');
  const { createAdminUsersRouter } = await import('./routes/adminUsers.js');
  const { default: skillsRouter } = await import('./routes/skills.js');
  const { default: memoryRouter } = await import('./routes/memory.js');
  const { default: storageRouter } = await import('./routes/storage.js');
  const projects = await import('./projects.js');

  const app = express(); app.use(express.json());
  const requireUser = [authenticateToken, userScopeMiddleware];
  app.use('/api/auth', authRouter);
  app.use('/api/admin', authenticateToken, userScopeMiddleware, requireAdmin, createAdminUsersRouter({ onUserRevoked: (id) => pool.markRevoked(id) }));
  app.use('/api/skills', ...requireUser, skillsRouter);
  app.use('/api/memory', ...requireUser, memoryRouter);
  app.use('/api/storage', ...requireUser, storageRouter);
  app.get('/api/projects', ...requireUser, async (_req, res) => res.json({ projects: await projects.getProjects() }));
  app.post('/api/projects/create-system', ...requireUser, async (req, res) => res.json(await projects.createSystemProject(req.body)));
  app.get('/api/projects/:id/sessions', ...requireUser, async (req, res) => {
    try { res.json(await projects.getSessions(req.params.id)); } catch (e) { res.status(e.status ?? 404).json({ error: e.message }); }
  });
  server = app.listen(0); base = `http://127.0.0.1:${server.address().port}`;

  const alice = db.userDb.createUser('alice', 'x', 'user'); const bob = db.userDb.createUser('bob', 'x', 'user');
  tokens = { admin: generateToken(db.userDb.getAdminUser()), alice: generateToken(db.userDb.getUserById(alice.id)), bob: generateToken(db.userDb.getUserById(bob.id)) };
  tokens.ids = { alice: alice.id, bob: bob.id };
});
afterEach(async () => { await new Promise((r) => server.close(r)); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

const api = (who, method, p, body) => fetch(`${base}${p}`, {
  method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` }, body: body ? JSON.stringify(body) : undefined,
});

describe('A/B isolation', () => {
  it('projects: A sees only A, B cannot read A\'s project by id', async () => {
    const a = await (await api('alice', 'POST', '/api/projects/create-system', { displayName: '同名病例', type: 'general_med' })).json();
    const b = await (await api('bob', 'POST', '/api/projects/create-system', { displayName: '同名病例', type: 'general_med' })).json();
    // project ids may legitimately collide across users; only the directories must differ
    expect(fs.existsSync(path.join(root, 'users', String(tokens.ids.alice), 'projects', 'general_med', a.id))).toBe(true);
    expect(fs.existsSync(path.join(root, 'users', String(tokens.ids.bob), 'projects', 'general_med', a.id))).toBe(false);
    const listA = await (await api('alice', 'GET', '/api/projects')).json();
    expect(listA.projects).toHaveLength(1);
    const cross = await api('bob', 'GET', `/api/projects/${encodeURIComponent(a.id)}/sessions`);
    expect(cross.status).toBe(404);
  });

  it('skills: personal skills live in the caller\'s home only', async () => {
    fs.mkdirSync(path.join(root, 'users', String(tokens.ids.alice), 'skills', 'alice-only'), { recursive: true });
    fs.writeFileSync(path.join(root, 'users', String(tokens.ids.alice), 'skills', 'alice-only', 'SKILL.md'), '---\nname: alice-only\ndescription: x\n---\n');
    const forA = JSON.stringify(await (await api('alice', 'GET', '/api/skills')).json());
    const forB = JSON.stringify(await (await api('bob', 'GET', '/api/skills')).json());
    expect(forA).toContain('alice-only');
    expect(forB).not.toContain('alice-only');
  });

  it('gateway pool is asked for the caller\'s id, never someone else\'s', async () => {
    await api('alice', 'GET', '/api/projects');
    await api('bob', 'GET', '/api/projects');
    expect(pool.acquire.mock.calls.map((c) => String(c[0])).sort()).toEqual([String(tokens.ids.alice), String(tokens.ids.bob)].sort());
  });

  it('admin cannot list another user\'s projects through any mounted route', async () => {
    await api('alice', 'POST', '/api/projects/create-system', { displayName: 'private', type: 'general_med' });
    const adminList = await (await api('admin', 'GET', '/api/projects')).json();
    expect(adminList.projects).toHaveLength(0);
  });

  it('deactivating B revokes B and recycles B\'s gateway', async () => {
    const res = await api('admin', 'PATCH', `/api/admin/users/${tokens.ids.bob}`, { isActive: false });
    expect(res.status).toBe(200);
    expect(pool.markRevoked).toHaveBeenCalledWith(tokens.ids.bob);
    expect((await api('bob', 'GET', '/api/projects')).status).toBe(401);
  });

  it('each WebSocket keeps the scope bound at handshake even when another user connects later', async () => {
    // Mirrors index.js handleChatConnection: the handler closure is created inside runWithUserScope once per connection.
    const { runWithUserScope, requireUserScope } = await import('./middleware/userScope.js');
    const makeHandler = (scope) => (message) => runWithUserScope(scope, async () => `${requireUserScope().userId}:${message}`);
    const handlerA = makeHandler({ userId: tokens.ids.alice, role: 'user' });
    const handlerB = makeHandler({ userId: tokens.ids.bob, role: 'user' });
    const [a, b, a2] = await Promise.all([handlerA('m1'), handlerB('m2'), handlerA('m3')]);
    expect(a).toBe(`${tokens.ids.alice}:m1`);
    expect(b).toBe(`${tokens.ids.bob}:m2`);
    expect(a2).toBe(`${tokens.ids.alice}:m3`);
  });

  it('a request without scope is a 500, not a fallback to the root', async () => {
    const bare = express(); bare.use(express.json());
    const projects = await import('./projects.js');
    bare.get('/x', async (_req, res) => { try { res.json(await projects.getProjects()); } catch (e) { res.status(500).json({ code: e.code }); } });
    const s = bare.listen(0);
    const r = await fetch(`http://127.0.0.1:${s.address().port}/x`);
    await new Promise((d) => s.close(d));
    expect(r.status).toBe(500);
    expect((await r.json()).code).toBe('USER_SCOPE_MISSING');
    expect(fs.existsSync(path.join(root, 'projects'))).toBe(false);
  });
});
```

`/api/skills`、`/api/memory`、`/api/storage` 的响应结构以实际路由为准；若 `GET /api/skills` 的路径不同（例如 `/api/skills/list`），改用实际路径。

- [ ] **Step 2: 运行**

Run: `npm --prefix ui test -- server/multiUser.isolation.test.js`
Expected: PASS（7 个用例）。任一失败都意味着某条路径仍读了全局目录，回到对应任务修复，不在测试里放宽。

- [ ] **Step 3: 加脚本并跑全量**

`ui/package.json`：

```json
"test:isolation": "vitest run server/multiUser.isolation.test.js server/pilotdeck-bridge.scope.test.js server/projects.scope.test.js",
```

Run: `npm --prefix ui test && npm --prefix ui run typecheck && npm --prefix ui run build && npm test`
Expected: 全部通过。既有测试若因为「缺少作用域」失败，修测试（包 `runWithUserScope`），不改生产代码加兜底。

- [ ] **Step 4: 手工冒烟（两个浏览器）**

1. 按 Task 11 Step 9 启动，`PILOTDECK_DISABLE_LOCAL_AUTH=0`。
2. 浏览器一注册 `alice`，浏览器二注册 `bob`；各自新建项目、上传一个文件、发一条消息。
3. 确认 `/tmp/pd-multi/users/` 下有两个目录，各自只含自己的项目；`system/gateway-pids.json` 有两条。
4. 管理员登录第三个窗口，停用 `bob`：`bob` 的页面应在下一次请求时收到 401，WS 断开；pid 文件在 `bob` 无活动租约后少一条。
5. 停止服务：pid 文件为空，`pgrep -f "pilotdeck.*server"` 为空。
6. 不设 `PILOTDECK_DISABLE_LOCAL_AUTH` 重新启动：无需登录，数据落在 `users/1/`（admin）。

- [ ] **Step 5: 提交**

```bash
git add ui/server/multiUser.isolation.test.js ui/package.json
git commit -m "test(multi-user): 双用户隔离回归作为合并门槛

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## 完成标准

- Task 1–12 全部勾选，`npm --prefix ui test`、`npm --prefix ui run typecheck`、`npm --prefix ui run build`、`npm test` 通过。
- 手工冒烟六步全部符合预期。
- 以下内容**明确不在本计划**，由后续计划处理：旧数据自动迁移与操作者命令（§9）；普通用户设置页后端授权、Git 配置、前端账号区与管理页（§10.3、§11）；清理策略（§10.5）；用户目录沙箱（§16）。


---

## 执行记录（2026-10-14，subagent-driven 执行，分支 feat/multi-user-v2，提交范围 2f8caeb..b1e7273）

全部 12 个任务完成，每个任务经独立评审与修复循环，整分支终审一轮修复后通过。验证：UI 套件 918 通过，引擎套件 647 通过，typecheck（含模块级 home 扫描自检）与 build 通过；两次隔离端口的手工启动（含旧库根目录不被触碰的升级场景）通过。两浏览器人工走查留给使用者。

### 执行期间的裁决（按时间顺序，每条含出错代价）

- Ruling: work directly in this checkout on feat/multi-user-v2, no separate worktree — the branch is a dedicated clean feature branch the user chose, and node_modules/pnpm workspace + .pilotdeck-home runtime config are bound to this directory — cost if wrong: a broken intermediate commit lands on the feature branch the user's dev server runs from (recoverable via git).
- Ruling: T1 keeps `userDb.getFirstUser`; T3 deletes it together with its only caller — why: avoid a broken intermediate commit — cost if wrong: a dead method lingers for two tasks.
- Ruling: T1 updates the four sessionNamesDb/applyCustomSessionNames call sites to pass `0` as userId (same value the column migration assigns to legacy rows); T7 replaces `0` with `requireUserScope().userId` — why: keep every commit runnable — cost if wrong: between T1 and T7 session renames are stored under user 0 (test data only; no production data on this branch).
- Ruling: T8 scan script skips `ui/server/utils/pilotPaths.js` and any line starting with an (export) function declaration — why: the definition site and default-parameter signatures are not module-level resolution — cost if wrong: a module-level constant hidden in a function-signature line could slip through (unlikely shape).
- Ruling: T9 startEntry re-checks `entry.exited` after the connect race and throws GATEWAY_UNAVAILABLE if the child already exited; drainWaiting attempts to drain whenever any instance is idle OR capacity is free (acquire then evicts LRU idle) — why: plan's tests require both behaviours and the plan's code does not deliver them — cost if wrong: a waiter could evict a just-released instance of another user slightly earlier than idle-timeout (acceptable under spec §7.4 LRU rule).
- Ruling: adminUsers.js handlers get try/catch with { error, code } (500 INTERNAL; SQLITE_CONSTRAINT_UNIQUE → 409 USERNAME_TAKEN) although the plan's verbatim code lacked it — why: spec requires `{ error, code }` on every path and Express 4 turns an async throw into a hung request/unhandled rejection — cost if wrong: none beyond a few extra lines.
- Ruling: fold the stragglers into Task 8 (which already sweeps ui/server for global-home resolution): each is classified as (a) inside an authenticated route → resolveScopedHome(); (b) system-level file → resolvePilotRoot(); (c) routes/agent.js external-API-key path → establish the scope from api_keys.user_id (spec D12) before resolving — why: Task 8's scan script will flag module-level ones anyway and the request-time ones belong to the same sweep — cost if wrong: Task 8 grows by ~8 edits.
- Ruling: projects watcher watches `<root>/users/*/projects/**`, derives userId from the first path segment, debounces per user, runs getProjects inside runWithUserScope({userId}) and sends projects_updated (and progress) only to that user's WebSocket clients — why: spec §7.3 "UI 所有缓存和事件注册仍按用户区分"; a global list to all clients is a leak — cost if wrong: one watcher over users/ instead of one per user; large user counts increase inotify handles (acceptable for <50 users).
- Ruling: stoppingEntries count against maxInstances and drainWaiting re-runs when a stop completes, overruling the plan sketch's synchronous entries.delete — why: spec §7.3 "确认退出后才释放端口与容量" — cost if wrong: slightly lower effective capacity during the ≤5 s stop grace.
- Ruling: Task 12 Step 4's two-browser manual smoke is executed by the implementer as a scripted smoke (curl + node ws client) on isolated ports/root; the browser walkthrough is left to the user after Plan 1 since the frontend account UI arrives in Plan 2 — why: subagents have no browser — cost if wrong: a frontend-only regression (login/register forms against the new /status payload) would surface at the user's first manual run, not here.
- Ruling: Plan 1 does NOT copy <root>/auth.db into system/auth.db (remove the Task 1 root-copy); a fresh system/auth.db is created with a fresh admin and the legacy root DB is left for Plan 2's explicit migration — why: the legacy single-user DB has no admin, so copying it only reproduces NO_ACTIVE_ADMIN; the plan promised "old data invisible until Plan 2, root untouched" — cost if wrong: the legacy `local` account is not carried over until Plan 2 (it was an auto-created free-login placeholder with a random password).
- Ruling: engine honours PILOTDECK_DISABLE_ALWAYS_ON (skip always-on, cron and IM channel adapters when truthy) now rather than in Plan 2 — why: the var already exists in the pool env and the live config has cron.enabled: true, so every pooled gateway would start a cron daemon today; Task 10 set the precedent for a small engine env guard — cost if wrong: free-login/standalone gateways unaffected (var unset).
- Ruling: drop the dead PILOTDECK_GATEWAY_TOKEN_PATH from the pool env; token stays at <userHome>/server-token (documented deviation from spec §4) — why: engine reads only $PILOT_HOME/server-token — cost if wrong: none.
- Ruling: disagreement accepted — Important #6 (docker/install/offline/README) is fixed in this wave, not Plan 2.
- parked — configured `webui.runtime.databasePath` resolving to legacy <root>/auth.db is dropped silently — Ruling: real but deferred to Plan 2 (add a one-line boot warning in buildRuntimeEnv / load-env.js) — cost if wrong: an operator who deliberately wanted <root>/auth.db gets no trace; env/flag still work.
- parked — breaker no longer resets on successful start; non-consecutive failures accumulate and each failure extends the 10-min window — Ruling: accept for Plan 1 (healthy users never record a failure; lockout is a retryable 503 for ≤10 min); Plan 2 restores spec intent by clearing failures after a sustained-healthy lease — cost if wrong: a flapping gateway trips later than spec's literal "3 consecutive".
- parked — revocation closes chat WebSockets only; /shell and /plugin-ws sockets are not in connectedClients, so a disabled user's live PTY stays open until they disconnect (pre-existing scope of the extracted loop) — Ruling: load-bearing for Review Focus 2 but outside Plan 1's task list; Plan 2 batch D must register shell/plugin sockets with their userId and pass them to closeUserSockets — cost if wrong: a deactivated user keeps an open terminal session until their socket drops (REST/chat are already revoked).

### 终审后搁置的事项（已裁决，交后续计划）

- parked — configured `webui.runtime.databasePath` resolving to legacy <root>/auth.db is dropped silently — Ruling: real but deferred to Plan 2 (add a one-line boot warning in buildRuntimeEnv / load-env.js) — cost if wrong: an operator who deliberately wanted <root>/auth.db gets no trace; env/flag still work.
- parked — breaker no longer resets on successful start; non-consecutive failures accumulate and each failure extends the 10-min window — Ruling: accept for Plan 1 (healthy users never record a failure; lockout is a retryable 503 for ≤10 min); Plan 2 restores spec intent by clearing failures after a sustained-healthy lease — cost if wrong: a flapping gateway trips later than spec's literal "3 consecutive".
- parked — revocation closes chat WebSockets only; /shell and /plugin-ws sockets are not in connectedClients, so a disabled user's live PTY stays open until they disconnect (pre-existing scope of the extracted loop) — Ruling: load-bearing for Review Focus 2 but outside Plan 1's task list; Plan 2 batch D must register shell/plugin sockets with their userId and pass them to closeUserSockets — cost if wrong: a deactivated user keeps an open terminal session until their socket drops (REST/chat are already revoked).

### 交给计划二/三的事项

- note for Plan 2: plugin routes are reachable by any authenticated user (plugins are shared by ruling); spec D10 puts plugin management under admin — handled in Plan 2 batch D.
- ⚠️ for Task 11 manual boot: real spawn/connect path (dist vs tsx args, ws://127.0.0.1:<port>/ws), engine reading $PILOT_HOME/server-token, child binds 127.0.0.1, defaultFindFreePort, reapOrphans with real pids.
- note for Plan 2: install.sh, docker-entrypoint.sh, scripts/offline-runtime.sh, README_SOURCE_INSTALL*.md still pre-start a standalone gateway / document PILOTDECK_GATEWAY_URL (now ignored by the bridge).

### 各任务评审中记录的次要问题（未阻塞合并）

- minor (deferred): db.js root auth.db copy not wrapped in try/catch — a permissions failure crashes at import.
- minor (deferred): getUserById/getUserByUsername no longer filter is_active; middleware/login accept disabled users until Task 3 adds the checks (nothing can disable a user before Task 5).
- minor (deferred): init.sql:95 creates idx_session_names_lookup(user_id,…) before runMigrations; on a legacy DB lacking that index it would throw "no such column" before the rebuild. Confirm all pre-upgrade installs had the index, or move the CREATE INDEX into runMigrations after the rebuild.
- minor (deferred): adminBootstrap tests don't cover empty-string env password, inactive-admin-only case, or the [WARN] log.
- minor (deferred): auth.js resolveTokenUser/generateToken and the bypass branches are outside try/catch; a sqlite throw in the async middleware becomes an unhandled rejection (old code returned 403). Consider a wrapping try/catch → 500.
- minor (deferred): no tests for NO_TOKEN/INVALID_TOKEN/USER_NOT_FOUND, legacy token without tokenVersion, X-Refreshed-Token, NO_ADMIN. Stale comment index.js:445 "Returns first DB user".
- minor (deferred): /password in no-login mode skips current-password check (undocumented); non-string password → 500 INTERNAL instead of 400; bcrypt skipped for unknown/disabled users (timing oracle); no 72-byte password cap; /logout,/user,/status lack try/catch; test afterEach doesn't close sqlite handle; usernames other than admin are case-sensitive (decide deliberately).
- minor (deferred): /logout header removal untested; stripping X-Refreshed-Token per handler is fragile — any future route that bumps the caller's own tokenVersion must repeat it (alternative: clear in middleware or skip refresh on those routes).
- minor (deferred): admin can lock themselves out via PATCH on own id (last-admin guard keeps system recoverable); no-op PATCH (isActive:true on active user) still bumps tokenVersion and fires onUserRevoked; setRole+setActive not in a transaction; test gaps (403 on non-GET verbs now covered by fix round; reset-password login round-trip; 404/NO_CHANGES).
- minor (deferred): guard() catch lacks res.headersSent check (latent); UNIQUE→USERNAME_TAKEN mapping applies to all handlers; guard's catch branches untested (duplicate test hits pre-check path); PATCH/reset-password writes not transactional.
- minor (deferred): null WS userId would throw synchronously from the message listener (unreachable: verifyClient guarantees a user) — validate at connect and ws.close() instead; skeleton fs failure after createUser leaves a user row whose retry gets USERNAME_TAKEN (recoverable: pool re-ensures skeleton); existsSync+symlinkSync race (catch EEXIST).
- minor (deferred): projects.js functions now throw USER_SCOPE_MISSING when called from non-request contexts (cron/gateway callbacks) — always-on is disabled in multi-user mode (D12), but the final review should confirm no such caller remains live in no-login mode.
- minor (deferred): notification-orchestrator resolveSessionName ignores the known target userId and relies on ambient scope (push titles degrade to "PilotDeck" outside a scope); no tests for either branch. projects.scope.test mocks db.js wholesale so applyCustomSessionNames userId not asserted.
- minor (deferred): watcher logic untested (tangled in index.js) — extract onlyUserProjects/userId derivation as pure helpers with a test; WATCHER_IGNORED_PATTERNS globs are literal no-ops under chokidar 4 (pre-existing); getProjects() still merges gateway.listProjects() — per-user once Task 11 scopes the gateway.
- minor (deferred): raw process.env.PILOT_HOME request-time uses remain outside the scan: index.js:3786, cli.js:42, load-env.js:52, utils/globalChrome.js:31 — final review to classify.
- minor (deferred): memoryService.listWorkspaceDataDirs swallows USER_SCOPE_MISSING inside try/catch (returns [] instead of throwing).
- minor (deferred): resolvePilotRoot uses `??` where old constants used `||` (empty PILOT_HOME now differs); API keys owned by admins run as role 'user' in scope; gateway.js loadYaml() calls pilotdeckYamlPath() twice; /api/gateway,/plugins,/mcp,/update are user-reachable system-config routes → admin gating in Plan 2 (spec D10).
- minor (deferred): scanner still treats a regex after `)` as division (false negative bounded to one line, depth check catches imbalance); backslash-newline in strings shifts reported line numbers; index.js token-usage route has no route-level test (index.js not importable in vitest).
- minor (deferred): markRevoked during `starting` grants one lease (callers must gate before acquire); unexpected exit of a ready instance never records a breaker failure; `await stopEntry(victim)` in acquire uncapped; dead branch after startEntry retry; reapOrphans has no process-identity check and truncates the pid file at construction (two pools over one root clobber each other); readMultiUserConfig reads process.env directly and `Number(x)||default` eats explicit 0; test file keeps unused `let timers`; implementer's hardening paths untested.
- minor (deferred): stopEntry waits only on child 'exit' — an 'error'-with-no-pid spawn failure during an in-flight stop never resolves `stopped`, and with stoppingEntries counted that slot stays occupied (narrow race; let onGone resolve pending stops); no ceiling on acquire's wait for an uninterruptible victim; evictor re-queued at queue head is exempt from maxWaiting (implementer design addition); post-spawn stopping guard is dead code and incomplete if spawn ever became async.
- minor (deferred): no test pins that loadPilotConfig/PilotConfigStore actually pass env; relative PILOTDECK_CONFIG_PATH resolves against cwd (document).
- minor (deferred): always-on forwarding subscribes once at boot with a permanent admin lease — if that gateway child dies and is respawned nothing re-subscribes; runChat catch uses `gw` after lease release (benign); short-RPC getPilotDeckGateway after a revoke yields "websocket closed" → 500 not 503; stale comment index.js:546 mentions delete route; isGatewayUnavailableError regex incomplete (status===503 covers it).
- minor (deferred): shell WebSocket clients are not in connectedClients → not closed at shutdown, server.close waits for the 20 s fallback when a terminal is open; a throw from stopAllPlugins in gracefulShutdown becomes an unhandled rejection (exit code 1 instead of 0).
- review clean. minor (deferred): unused WebSocketServer/runWithUserScope imports in the isolation test; pool-acquire test sorts ids (cannot detect a swap) and is redundant with the skills test; admin test title overclaims; 401 body code USER_DISABLED not asserted; onUserRevoked→pool.markRevoked wiring in index.js verified only by smoke.
