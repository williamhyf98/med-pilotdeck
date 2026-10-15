// ui/server/routes/adminUsers.js
import express from 'express';
import bcrypt from 'bcrypt';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { userDb, systemSettingsDb } from '../database/db.js';
import { isReservedUsername } from '../services/adminBootstrap.js';
import { getUserStorageBytes, invalidateStorageCache } from '../services/storageUsage.js';
import { ensureUserHomeSkeleton, resolvePilotRoot, resolveUserHome } from '../utils/pilotPaths.js';

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

  router.get('/users', guard(async (_req, res) => {
    const rows = userDb.listUsers().map(toPublic);
    const sizes = await Promise.all(rows.map((u) => getUserStorageBytes(u.id)));
    res.json({ users: rows.map((u, i) => ({ ...u, storageBytes: sizes[i] })) });
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
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const dest = path.join(resolvePilotRoot(), 'archives', 'users', `${target.id}-${stamp}`);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.rename(home, dest);
      archived = true;
    }
    invalidateStorageCache(target.id);
    res.json({ user: toPublic(userDb.getUserById(target.id)), archived });
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
