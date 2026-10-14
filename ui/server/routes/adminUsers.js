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
