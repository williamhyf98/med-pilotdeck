import express from 'express';
import bcrypt from 'bcrypt';
import { timingSafeEqual } from 'node:crypto';
import { userDb, db } from '../database/db.js';
import { generateToken, authenticateToken } from '../middleware/auth.js';
import { DISABLE_LOCAL_AUTH } from '../constants/config.js';
import { getUserStorageStatus } from '../services/userHomes.js';

const router = express.Router();

// Check auth status and setup requirements
router.get('/status', async (req, res) => {
  try {
    if (DISABLE_LOCAL_AUTH) {
      return res.json({
        needsSetup: false,
        isAuthenticated: true,
        authDisabled: true,
      });
    }
    const hasRealUsers = userDb.hasRealUsers();
    res.json({
      // System accounts (auto-provisioned in bypass mode with a random
      // password) must not block first-time setup after auth is enabled.
      needsSetup: !hasRealUsers,
      setupTokenRequired: !hasRealUsers,
      storage: await getUserStorageStatus(),
      isAuthenticated: false // Will be overridden by frontend if token exists
    });
  } catch (error) {
    console.error('Auth status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// User registration (setup) - only allowed if no users exist
router.post('/register', async (req, res) => {
  try {
    if (DISABLE_LOCAL_AUTH) {
      return res.status(403).json({ error: 'Registration is disabled (PILOTDECK_DISABLE_LOCAL_AUTH)' });
    }
    if (userDb.hasRealUsers()) {
      return res.status(403).json({ error: 'Registration is closed. Ask an administrator to create your account.' });
    }
    const expectedToken = process.env.PILOTDECK_SETUP_TOKEN;
    if (!expectedToken) {
      return res.status(503).json({ error: '请由部署管理员配置初始化令牌后再创建账号。', code: 'SETUP_NOT_CONFIGURED' });
    }
    const suppliedToken = req.get('X-PilotDeck-Setup-Token') || '';
    const expectedBytes = Buffer.from(expectedToken);
    const suppliedBytes = Buffer.from(suppliedToken);
    if (expectedBytes.length !== suppliedBytes.length || !timingSafeEqual(expectedBytes, suppliedBytes)) {
      return res.status(403).json({ error: '初始化令牌无效。', code: 'SETUP_TOKEN_REQUIRED' });
    }
    const { username, password } = req.body;
    
    // Validate input
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    
    if (username.length < 3 || password.length < 6) {
      return res.status(400).json({ error: 'Username must be at least 3 characters, password at least 6 characters' });
    }
    
    // Hash outside the transaction; recheck setup inside the synchronous
    // transaction so simultaneous setup requests cannot create two admins.
    const passwordHash = await bcrypt.hash(password, 12);
    db.prepare('BEGIN').run();
    try {
      // Open registration only bootstraps the very first real account, which
      // becomes the administrator. Everyone else is created by an admin via
      // /api/admin/users.
      const hasRealUsers = userDb.hasRealUsers();
      if (hasRealUsers) {
        db.prepare('ROLLBACK').run();
        return res.status(403).json({ error: 'Registration is closed. Ask an administrator to create your account.' });
      }

      // Create user (first real user = admin)
      const user = userDb.createUser(username, passwordHash, 'admin');

      // Generate token
      const token = generateToken(user);

      db.prepare('COMMIT').run();

      // Update last login (non-fatal, outside transaction)
      userDb.updateLastLogin(user.id);

      res.json({
        success: true,
        user: { id: user.id, username: user.username, role: user.role },
        token
      });
    } catch (error) {
      if (db.inTransaction) db.prepare('ROLLBACK').run();
      throw error;
    }
    
  } catch (error) {
    console.error('Registration error:', error);
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      res.status(409).json({ error: 'Username already exists' });
    } else {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// User login
router.post('/login', async (req, res) => {
  try {
    if (DISABLE_LOCAL_AUTH) {
      return res.status(403).json({ error: 'Login is disabled (PILOTDECK_DISABLE_LOCAL_AUTH)' });
    }
    const { username, password } = req.body;
    
    // Validate input
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    
    // Get user from database (system accounts have random passwords and are
    // not meant for interactive login)
    const user = userDb.getUserByUsername(username);
    if (!user || user.is_system) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Generate token
    const token = generateToken(user);

    // Update last login
    userDb.updateLastLogin(user.id);

    res.json({
      success: true,
      user: { id: user.id, username: user.username, role: user.role },
      token
    });
    
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get current user (protected route)
router.get('/user', authenticateToken, (req, res) => {
  res.json({
    user: req.user
  });
});

// Logout (client-side token removal, but this endpoint can be used for logging)
router.post('/logout', authenticateToken, (req, res) => {
  // In a simple JWT system, logout is mainly client-side
  // This endpoint exists for consistency and potential future logging
  res.json({ success: true, message: 'Logged out successfully' });
});

export default router;
