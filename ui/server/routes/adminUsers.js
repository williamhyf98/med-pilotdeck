// ui/server/routes/adminUsers.js
import express from 'express';
import bcrypt from 'bcrypt';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { userDb, systemSettingsDb } from '../database/db.js';
import { isReservedUsername } from '../services/adminBootstrap.js';
import {
  getUserStorageBreakdown,
  getUserTotalWarningBytes,
  invalidateStorageCache,
  listArchivedUserBytes,
} from '../services/storageUsage.js';
import { ensureUserHomeSkeleton, resolvePilotRoot, resolveUserHome } from '../utils/pilotPaths.js';
import { archivedStamp, findArchivedHome, getArchivedUserMaxAgeDays, listArchivedHomes } from '../services/archivedUsers.js';
import { appendAudit } from '../../../src/security/audit/auditLog.js';

const fail = (res, status, code, error) => res.status(status).json({ error, code });
const toPublic = (u) => ({ id: u.id, username: u.username, role: u.role, isActive: Number(u.is_active) === 1, createdAt: u.created_at, lastLogin: u.last_login });
const randomPassword = () => randomBytes(9).toString('base64url').slice(0, 12);

// Express 4 does not catch rejected promises from async handlers; map every throw to {error, code}.
const guard = (handler) => async (req, res) => {
  try {
    await handler(req, res);
  } catch (error) {
    if (error?.code === 'SQLITE_CONSTRAINT_UNIQUE') return fail(res, 409, 'USERNAME_TAKEN', 'Username already exists');
    console.error('[admin-users] request failed:', error);
    return fail(res, 500, 'INTERNAL', 'Internal server error');
  }
};

function wouldRemoveLastAdmin(target, patch) {
  if (target.role !== 'admin' || Number(target.is_active) !== 1) return false;
  const losesAdmin = (patch.role !== undefined && patch.role !== 'admin') || patch.isActive === false;
  return losesAdmin && userDb.countActiveAdmins() <= 1;
}

export function createAdminUsersRouter({ onUserRevoked = () => {}, stopUserRuntime = async () => {} } = {}) {
  const router = express.Router();

  router.get('/users', guard(async (req, res) => {
    // `?refresh=1` drops the 60 s cache so the admin's manual refresh really
    // re-walks the homes (design §9.2.1).
    if (req.query?.refresh === '1') invalidateStorageCache();
    const rows = userDb.listUsers().map(toPublic);
    const [breakdowns, archived, userTotalWarningBytes, archivedHomes, maxAgeDays] = await Promise.all([
      Promise.all(rows.map((u) => getUserStorageBreakdown(u.id))),
      listArchivedUserBytes(),
      getUserTotalWarningBytes(),
      listArchivedHomes(),
      getArchivedUserMaxAgeDays(),
    ]);
    // 每个用户最近一次归档（一个账号可能删过多次，只有最新那份还能恢复）。
    const archivedByUser = new Map();
    for (const home of archivedHomes) {
      if (!archivedByUser.has(home.userId)) archivedByUser.set(home.userId, home);
    }
    const expiresAtOf = (home) => new Date(home.archivedAt.getTime() + maxAgeDays * 86_400_000).toISOString();
    const users = rows.map((u, i) => {
      const home = archivedByUser.get(u.id);
      return {
        ...u,
        storageBytes: breakdowns[i].bytes,
        inboxBytes: breakdowns[i].inboxBytes,
        // A deleted account keeps its row (deactivated) but its home moved to
        // archives/users/. Report those bytes on the row so totals still add up.
        archivedBytes: archived.get(String(u.id)) ?? 0,
        // 归档账号在用户管理页单独一块显示，不和在用账号混在一起。
        archived: Boolean(home),
        archivedAt: home ? home.archivedAt.toISOString() : null,
        expiresAt: home ? expiresAtOf(home) : null,
      };
    });
    const totalBytes = users.reduce((sum, u) => sum + u.storageBytes + u.archivedBytes, 0);
    const totalInboxBytes = users.reduce((sum, u) => sum + u.inboxBytes, 0);
    res.json({
      users,
      // 与 `users` 有重叠（同一行的两种视图），但顺序按归档时间从新到旧，
      // 页面直接渲染这一份即可，不用再自己筛一遍。
      archivedUsers: users
        .filter((u) => u.archived)
        .sort((a, b) => String(b.archivedAt).localeCompare(String(a.archivedAt))),
      storage: {
        totalBytes,
        totalInboxBytes,
        archivedBytes: users.reduce((sum, u) => sum + u.archivedBytes, 0),
        userTotalWarningBytes,
      },
    });
  }));

  router.post('/users', guard(async (req, res) => {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const role = req.body?.role === 'admin' ? 'admin' : 'user';
    if (username.length < 3 || password.length < 6) return fail(res, 400, 'WEAK_CREDENTIALS', 'Username ≥3 chars, password ≥6 chars');
    if (isReservedUsername(username)) return fail(res, 403, 'RESERVED_USERNAME', 'This username is reserved');
    if (userDb.getUserByUsername(username)) return fail(res, 409, 'USERNAME_TAKEN', 'Username already exists');
    const created = userDb.createUser(username, await bcrypt.hash(password, 12), role);
    ensureUserHomeSkeleton(created.id);
    res.status(201).json({ user: toPublic(userDb.getUserById(created.id)) });
  }));

  router.patch('/users/:id', guard((req, res) => {
    const target = userDb.getUserById(Number(req.params.id));
    if (!target) return fail(res, 404, 'USER_NOT_FOUND', 'User not found');
    const patch = {};
    if (req.body?.role === 'admin' || req.body?.role === 'user') patch.role = req.body.role;
    if (typeof req.body?.isActive === 'boolean') patch.isActive = req.body.isActive;
    if (Object.keys(patch).length === 0) return fail(res, 400, 'NO_CHANGES', 'Nothing to update');
    // Only the *effective* change counts: re-sending the current role/state must
    // not log the user out of every device they have open.
    if (patch.role === target.role) delete patch.role;
    if (patch.isActive === (Number(target.is_active) === 1)) delete patch.isActive;
    if (Object.keys(patch).length === 0) return res.json({ user: toPublic(target) });
    if (wouldRemoveLastAdmin(target, patch)) return fail(res, 409, 'LAST_ADMIN', 'Cannot remove the last administrator');
    if (patch.role !== undefined) userDb.setRole(target.id, patch.role);
    if (patch.isActive !== undefined) userDb.setActive(target.id, patch.isActive);
    userDb.bumpTokenVersion(target.id);
    onUserRevoked(target.id);
    res.json({ user: toPublic(userDb.getUserById(target.id)) });
  }));

  // Deleting a user is a soft delete: the account is deactivated and its
  // sessions revoked immediately, but the home directory is *moved* to
  // `<root>/archives/users/<id>-<timestamp>/` rather than erased, so an
  // accidental click does not destroy a researcher's data.
  router.delete('/users/:id', guard(async (req, res) => {
    const target = userDb.getUserById(Number(req.params.id));
    if (!target) return fail(res, 404, 'USER_NOT_FOUND', 'User not found');
    if (wouldRemoveLastAdmin(target, { isActive: false })) {
      return fail(res, 409, 'LAST_ADMIN', 'Cannot remove the last administrator');
    }
    userDb.setActive(target.id, false);
    userDb.bumpTokenVersion(target.id);
    onUserRevoked(target.id);
    // The Gateway child holds open file handles under the home: wait for it to
    // exit before renaming, or it keeps writing into the archived directory.
    await stopUserRuntime(target.id);

    let archived = false;
    const home = resolveUserHome(target.id);
    if (fs.existsSync(home)) {
      const dest = path.join(resolvePilotRoot(), 'archives', 'users', `${target.id}-${archivedStamp()}`);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.rename(home, dest);
      archived = true;
    }
    invalidateStorageCache(target.id);
    res.json({ user: toPublic(userDb.getUserById(target.id)), archived });
  }));

  /**
   * 恢复一个已归档账号：把 home 从 `archives/users/<id>-<stamp>` 搬回
   * `users/<id>`，重新激活，并踢掉旧登录态（`token_version + 1`）。
   *
   * 冲突一律拒绝而不是覆盖：
   * - 活跃 home 已经存在 → 409 `HOME_EXISTS`（可能是并发恢复，或管理员手工建过目录）；
   * - 找不到归档 → 404 `NOT_ARCHIVED`（已过期清理，或账户从没被删过）。
   */
  router.post('/users/:id/restore', guard(async (req, res) => {
    const id = Number(req.params.id);
    const target = userDb.getUserById(id);
    if (!target) return fail(res, 404, 'USER_NOT_FOUND', 'User not found');
    const home = resolveUserHome(id);
    if (fs.existsSync(home)) return fail(res, 409, 'HOME_EXISTS', 'This account already has a live home directory');
    const archivedHome = await findArchivedHome(id);
    if (!archivedHome) return fail(res, 404, 'NOT_ARCHIVED', 'No archived home found for this account');

    await fsp.mkdir(path.dirname(home), { recursive: true });
    try {
      await fsp.rename(archivedHome.dir, home);
    } catch (error) {
      // 跨设备时 rename 会失败：复制过去再删，避免把归档留在原地又报了成功。
      if (error?.code !== 'EXDEV') throw error;
      await fsp.cp(archivedHome.dir, home, { recursive: true, errorOnExist: true, force: false });
      await fsp.rm(archivedHome.dir, { recursive: true, force: true });
    }

    userDb.setActive(id, true);
    userDb.bumpTokenVersion(id);
    invalidateStorageCache(id);
    appendAudit({
      action: 'user.restore',
      decision: 'allow',
      tool: 'admin.users',
      target: `users/${id}`,
      reason: 'admin_restore',
      meta: { archive: archivedHome.name },
    });
    res.json({ user: toPublic(userDb.getUserById(id)), restored: true });
  }));

  router.post('/users/:id/reset-password', guard(async (req, res) => {
    const target = userDb.getUserById(Number(req.params.id));
    if (!target) return fail(res, 404, 'USER_NOT_FOUND', 'User not found');
    const password = randomPassword();
    userDb.updatePasswordHash(target.id, await bcrypt.hash(password, 12));
    userDb.bumpTokenVersion(target.id);
    onUserRevoked(target.id);
    res.json({ password });
  }));

  router.get('/settings/registration', guard((_req, res) => {
    res.json({ allowPublicRegistration: systemSettingsDb.isPublicRegistrationAllowed() });
  }));

  router.put('/settings/registration', guard((req, res) => {
    if (typeof req.body?.allowPublicRegistration !== 'boolean') return fail(res, 400, 'INVALID_VALUE', 'allowPublicRegistration must be boolean');
    systemSettingsDb.set('allow_public_registration', req.body.allowPublicRegistration ? 'true' : 'false');
    res.json({ allowPublicRegistration: systemSettingsDb.isPublicRegistrationAllowed() });
  }));

  return router;
}
