import express from 'express';
import bcrypt from 'bcrypt';
import { userDb, systemSettingsDb } from '../database/db.js';
import { generateToken, authenticateToken } from '../middleware/auth.js';
import { DISABLE_LOCAL_AUTH } from '../constants/config.js';
import { isReservedUsername } from '../services/adminBootstrap.js';
import { ensureUserHomeSkeleton } from '../utils/pilotPaths.js';

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
    ensureUserHomeSkeleton(user.id);
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
  // authenticateToken may have set X-Refreshed-Token for the pre-bump version; it is now revoked.
  res.removeHeader('X-Refreshed-Token');
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
    // Drop the stale auto-refreshed token (old tokenVersion); the body carries the valid one.
    res.removeHeader('X-Refreshed-Token');
    res.json({ success: true, token: generateToken(fresh) });
  } catch (error) {
    console.error('Password change error:', error);
    fail(res, 500, 'INTERNAL', 'Internal server error');
  }
});

export default router;
