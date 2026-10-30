import jwt from 'jsonwebtoken';
import { userDb, appConfigDb } from '../database/db.js';
import { IS_PLATFORM, DISABLE_LOCAL_AUTH } from '../constants/config.js';

// Use env var if set, otherwise auto-generate a unique secret per installation
const JWT_SECRET = process.env.JWT_SECRET || appConfigDb.getOrCreateJwtSecret();

// Optional API key middleware
const validateApiKey = (req, res, next) => {
  // Skip API key validation if not configured
  if (!process.env.API_KEY) {
    return next();
  }
  
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
};

function denied(res, status, code, error) {
  return res.status(status).json({ error, code });
}

// No-login (bypass) mode acts as the administrator account.
function resolveBypassUser() {
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

// JWT authentication middleware
const authenticateToken = async (req, res, next) => {
  // Platform / no-login mode: act as the admin user
  if (IS_PLATFORM || DISABLE_LOCAL_AUTH) {
    const user = resolveBypassUser();
    if (!user) return denied(res, 500, 'NO_ADMIN', 'No administrator account exists (restart server after DB init)');
    req.user = user;
    return next();
  }

  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN
  // Also check query param for SSE endpoints (EventSource can't set headers)
  if (!token && req.query.token) token = req.query.token;
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

  // Auto-refresh: if token is past halfway through its lifetime, issue a new one
  if (decoded.exp && decoded.iat) {
    const now = Math.floor(Date.now() / 1000);
    const halfLife = (decoded.exp - decoded.iat) / 2;
    if (now > decoded.iat + halfLife) res.setHeader('X-Refreshed-Token', generateToken(resolved.user));
  }

  req.user = resolved.user;
  next();
};

// Generate JWT token
const generateToken = (user) =>
  jwt.sign(
    { userId: user.id, username: user.username, role: user.role ?? 'user', tokenVersion: Number(user.token_version ?? 0) },
    JWT_SECRET,
    { expiresIn: '7d' },
  );

// WebSocket authentication function
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

export {
  validateApiKey,
  authenticateToken,
  generateToken,
  authenticateWebSocket,
  resolveBypassUser,
  JWT_SECRET
};
