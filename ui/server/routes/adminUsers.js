import express from 'express';
import bcrypt from 'bcrypt';
import { userDb } from '../database/db.js';

// Admin-only user management. Mounted behind authenticateToken + requireAdmin
// in index.js, so every handler here can assume req.user is an admin.
// System accounts (is_system = 1) are invisible to this API by design —
// userDb's managed-user helpers all filter on is_system = 0.

const router = express.Router();

const VALID_ROLES = new Set(['admin', 'user']);
const SALT_ROUNDS = 12;

function toClientUser(row) {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    lastLogin: row.last_login,
  };
}

// List all real users
router.get('/', (req, res) => {
  try {
    res.json({ users: userDb.listUsers().map(toClientUser) });
  } catch (error) {
    console.error('List users error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create a user (admin replaces open registration)
router.post('/', async (req, res) => {
  try {
    const { username, password, role = 'user' } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    if (username.length < 3 || password.length < 6) {
      return res.status(400).json({ error: 'Username must be at least 3 characters, password at least 6 characters' });
    }
    if (!VALID_ROLES.has(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const created = userDb.createUser(username, passwordHash, role);
    const user = userDb.getManagedUser(created.id);
    res.json({ success: true, user: toClientUser(user) });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'Username already exists' });
    }
    console.error('Create user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update a user: role, active flag, and/or password reset
router.patch('/:id', async (req, res) => {
  try {
    const userId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(userId)) {
      return res.status(400).json({ error: 'Invalid user id' });
    }

    const target = userDb.getManagedUser(userId);
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }

    const { role, isActive, password } = req.body || {};
    if (role === undefined && isActive === undefined && password === undefined) {
      return res.status(400).json({ error: 'Nothing to update' });
    }
    if (role !== undefined && !VALID_ROLES.has(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    if (isActive !== undefined && typeof isActive !== 'boolean') {
      return res.status(400).json({ error: 'isActive must be a boolean' });
    }
    if (password !== undefined && (typeof password !== 'string' || password.length < 6)) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const demotes = role === 'user' && target.role === 'admin';
    const deactivates = isActive === false && target.is_active === 1;

    // An admin cannot lock themselves out mid-session…
    if (userId === req.user.id && (demotes || deactivates)) {
      return res.status(400).json({ error: 'You cannot demote or deactivate your own account', code: 'SELF_LOCKOUT' });
    }
    // …and the system must always keep at least one active real admin,
    // otherwise enabling login later has no one who can manage users.
    if ((demotes || deactivates) && target.role === 'admin' && target.is_active === 1
        && userDb.countActiveAdmins() <= 1) {
      return res.status(400).json({ error: 'At least one active administrator is required', code: 'LAST_ADMIN' });
    }

    if (role !== undefined) userDb.setUserRole(userId, role);
    if (isActive !== undefined) userDb.setUserActive(userId, isActive);
    if (password !== undefined) {
      const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
      userDb.updatePassword(userId, passwordHash);
    }

    res.json({ success: true, user: toClientUser(userDb.getManagedUser(userId)) });
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
