import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { resolvePilotRoot } from '../utils/pilotPaths.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ANSI color codes for terminal output
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    cyan: '\x1b[36m',
    dim: '\x1b[2m',
};

const c = {
    info: (text) => `${colors.cyan}${text}${colors.reset}`,
    bright: (text) => `${colors.bright}${text}${colors.reset}`,
    dim: (text) => `${colors.dim}${text}${colors.reset}`,
};

// auth.db is the one shared system database: it is opened once at import time
// from the system root (never a per-user home).
const PILOT_ROOT = resolvePilotRoot(process.env);
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

// Create database connection
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

// app_config must exist before any other module imports (auth.js reads the JWT secret at load time).
// runMigrations() also creates this table, but it runs too late for existing installations
// where auth.js is imported before initializeDatabase() is called.
db.exec(`CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Show app installation path prominently
const appInstallPath = path.join(__dirname, '../..');
console.log('');
console.log(c.dim('═'.repeat(60)));
console.log(`${c.info('[INFO]')} App Installation: ${c.bright(appInstallPath)}`);
console.log(`${c.info('[INFO]')} Database: ${c.dim(path.relative(appInstallPath, DB_PATH))}`);
if (process.env.DATABASE_PATH) {
  console.log(`       ${c.dim('(Using custom DATABASE_PATH from environment)')}`);
}
console.log(c.dim('═'.repeat(60)));
console.log('');

const runMigrations = () => {
  try {
    const tableInfo = db.prepare("PRAGMA table_info(users)").all();
    const columnNames = tableInfo.map(col => col.name);

    if (!columnNames.includes('git_name')) {
      console.log('Running migration: Adding git_name column');
      db.exec('ALTER TABLE users ADD COLUMN git_name TEXT');
    }

    if (!columnNames.includes('git_email')) {
      console.log('Running migration: Adding git_email column');
      db.exec('ALTER TABLE users ADD COLUMN git_email TEXT');
    }

    if (!columnNames.includes('has_completed_onboarding')) {
      console.log('Running migration: Adding has_completed_onboarding column');
      db.exec('ALTER TABLE users ADD COLUMN has_completed_onboarding BOOLEAN DEFAULT 0');
    }

    if (!columnNames.includes('role')) {
      console.log('Running migration: Adding role column');
      db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_users_role ON users(role)');
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

    db.exec(`
      CREATE TABLE IF NOT EXISTS user_notification_preferences (
        user_id INTEGER PRIMARY KEY,
        preferences_json TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS vapid_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_key TEXT NOT NULL,
        private_key TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        endpoint TEXT NOT NULL UNIQUE,
        keys_p256dh TEXT NOT NULL,
        keys_auth TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    // Create app_config table if it doesn't exist (for existing installations)
    db.exec(`CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Create session_names table if it doesn't exist (for existing installations)
    db.exec(`CREATE TABLE IF NOT EXISTS session_names (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL DEFAULT 0,
      session_id TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'claude',
      custom_name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, session_id, provider)
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_session_names_lookup ON session_names(user_id, session_id, provider)');

    console.log('Database migrations completed successfully');
  } catch (error) {
    console.error('Error running migrations:', error.message);
    throw error;
  }
};

// Initialize database with schema
const initializeDatabase = async () => {
  try {
    const initSQL = fs.readFileSync(INIT_SQL_PATH, 'utf8');
    db.exec(initSQL);
    console.log('Database initialized successfully');
    runMigrations();
  } catch (error) {
    console.error('Error initializing database:', error.message);
    throw error;
  }
};

// User database operations
const userDb = {
  // Check if any users exist
  hasUsers: () => {
    try {
      const row = db.prepare('SELECT COUNT(*) as count FROM users').get();
      return row.count > 0;
    } catch (err) {
      throw err;
    }
  },

  // Create a new user
  createUser: (username, passwordHash, role = 'user') => {
    const stmt = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)');
    const result = stmt.run(username, passwordHash, role);
    return { id: result.lastInsertRowid, username, role };
  },

  // Get user by username (does not filter is_active; callers decide)
  getUserByUsername: (username) => {
    return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  },

  // Update last login time (non-fatal — logged but not thrown)
  updateLastLogin: (userId) => {
    try {
      db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(userId);
    } catch (err) {
      console.warn('Failed to update last login:', err.message);
    }
  },

  // Get user by ID (does not filter is_active; callers decide)
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

  updateGitConfig: (userId, gitName, gitEmail) => {
    try {
      const stmt = db.prepare('UPDATE users SET git_name = ?, git_email = ? WHERE id = ?');
      stmt.run(gitName, gitEmail, userId);
    } catch (err) {
      throw err;
    }
  },

  getGitConfig: (userId) => {
    try {
      const row = db.prepare('SELECT git_name, git_email FROM users WHERE id = ?').get(userId);
      return row;
    } catch (err) {
      throw err;
    }
  },

  completeOnboarding: (userId) => {
    try {
      const stmt = db.prepare('UPDATE users SET has_completed_onboarding = 1 WHERE id = ?');
      stmt.run(userId);
    } catch (err) {
      throw err;
    }
  },

  hasCompletedOnboarding: (userId) => {
    try {
      const row = db.prepare('SELECT has_completed_onboarding FROM users WHERE id = ?').get(userId);
      return row?.has_completed_onboarding === 1;
    } catch (err) {
      throw err;
    }
  }
};

// API Keys database operations
const apiKeysDb = {
  // Generate a new API key
  generateApiKey: () => {
    return 'ck_' + crypto.randomBytes(32).toString('hex');
  },

  // Create a new API key
  createApiKey: (userId, keyName) => {
    try {
      const apiKey = apiKeysDb.generateApiKey();
      const stmt = db.prepare('INSERT INTO api_keys (user_id, key_name, api_key) VALUES (?, ?, ?)');
      const result = stmt.run(userId, keyName, apiKey);
      return { id: result.lastInsertRowid, keyName, apiKey };
    } catch (err) {
      throw err;
    }
  },

  // Get all API keys for a user
  getApiKeys: (userId) => {
    try {
      const rows = db.prepare('SELECT id, key_name, api_key, created_at, last_used, is_active FROM api_keys WHERE user_id = ? ORDER BY created_at DESC').all(userId);
      return rows;
    } catch (err) {
      throw err;
    }
  },

  // Validate API key and get user
  validateApiKey: (apiKey) => {
    try {
      const row = db.prepare(`
        SELECT u.id, u.username, ak.id as api_key_id
        FROM api_keys ak
        JOIN users u ON ak.user_id = u.id
        WHERE ak.api_key = ? AND ak.is_active = 1 AND u.is_active = 1
      `).get(apiKey);

      if (row) {
        // Update last_used timestamp
        db.prepare('UPDATE api_keys SET last_used = CURRENT_TIMESTAMP WHERE id = ?').run(row.api_key_id);
      }

      return row;
    } catch (err) {
      throw err;
    }
  },

  // Delete an API key
  deleteApiKey: (userId, apiKeyId) => {
    try {
      const stmt = db.prepare('DELETE FROM api_keys WHERE id = ? AND user_id = ?');
      const result = stmt.run(apiKeyId, userId);
      return result.changes > 0;
    } catch (err) {
      throw err;
    }
  },

  // Toggle API key active status
  toggleApiKey: (userId, apiKeyId, isActive) => {
    try {
      const stmt = db.prepare('UPDATE api_keys SET is_active = ? WHERE id = ? AND user_id = ?');
      const result = stmt.run(isActive ? 1 : 0, apiKeyId, userId);
      return result.changes > 0;
    } catch (err) {
      throw err;
    }
  }
};

// User credentials database operations (for GitHub tokens, GitLab tokens, etc.)
const credentialsDb = {
  // Create a new credential
  createCredential: (userId, credentialName, credentialType, credentialValue, description = null) => {
    try {
      const stmt = db.prepare('INSERT INTO user_credentials (user_id, credential_name, credential_type, credential_value, description) VALUES (?, ?, ?, ?, ?)');
      const result = stmt.run(userId, credentialName, credentialType, credentialValue, description);
      return { id: result.lastInsertRowid, credentialName, credentialType };
    } catch (err) {
      throw err;
    }
  },

  // Get all credentials for a user, optionally filtered by type
  getCredentials: (userId, credentialType = null) => {
    try {
      let query = 'SELECT id, credential_name, credential_type, description, created_at, is_active FROM user_credentials WHERE user_id = ?';
      const params = [userId];

      if (credentialType) {
        query += ' AND credential_type = ?';
        params.push(credentialType);
      }

      query += ' ORDER BY created_at DESC';

      const rows = db.prepare(query).all(...params);
      return rows;
    } catch (err) {
      throw err;
    }
  },

  // Get active credential value for a user by type (returns most recent active)
  getActiveCredential: (userId, credentialType) => {
    try {
      const row = db.prepare('SELECT credential_value FROM user_credentials WHERE user_id = ? AND credential_type = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1').get(userId, credentialType);
      return row?.credential_value || null;
    } catch (err) {
      throw err;
    }
  },

  // Delete a credential
  deleteCredential: (userId, credentialId) => {
    try {
      const stmt = db.prepare('DELETE FROM user_credentials WHERE id = ? AND user_id = ?');
      const result = stmt.run(credentialId, userId);
      return result.changes > 0;
    } catch (err) {
      throw err;
    }
  },

  // Toggle credential active status
  toggleCredential: (userId, credentialId, isActive) => {
    try {
      const stmt = db.prepare('UPDATE user_credentials SET is_active = ? WHERE id = ? AND user_id = ?');
      const result = stmt.run(isActive ? 1 : 0, credentialId, userId);
      return result.changes > 0;
    } catch (err) {
      throw err;
    }
  }
};

const DEFAULT_NOTIFICATION_PREFERENCES = {
  channels: {
    inApp: false,
    webPush: false
  },
  events: {
    actionRequired: true,
    stop: true,
    error: true
  }
};

const normalizeNotificationPreferences = (value) => {
  const source = value && typeof value === 'object' ? value : {};

  return {
    channels: {
      inApp: source.channels?.inApp === true,
      webPush: source.channels?.webPush === true
    },
    events: {
      actionRequired: source.events?.actionRequired !== false,
      stop: source.events?.stop !== false,
      error: source.events?.error !== false
    }
  };
};

const notificationPreferencesDb = {
  getPreferences: (userId) => {
    try {
      const row = db.prepare('SELECT preferences_json FROM user_notification_preferences WHERE user_id = ?').get(userId);
      if (!row) {
        const defaults = normalizeNotificationPreferences(DEFAULT_NOTIFICATION_PREFERENCES);
        db.prepare(
          'INSERT INTO user_notification_preferences (user_id, preferences_json, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)'
        ).run(userId, JSON.stringify(defaults));
        return defaults;
      }

      let parsed;
      try {
        parsed = JSON.parse(row.preferences_json);
      } catch {
        parsed = DEFAULT_NOTIFICATION_PREFERENCES;
      }
      return normalizeNotificationPreferences(parsed);
    } catch (err) {
      throw err;
    }
  },

  updatePreferences: (userId, preferences) => {
    try {
      const normalized = normalizeNotificationPreferences(preferences);
      db.prepare(
        `INSERT INTO user_notification_preferences (user_id, preferences_json, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id) DO UPDATE SET
           preferences_json = excluded.preferences_json,
           updated_at = CURRENT_TIMESTAMP`
      ).run(userId, JSON.stringify(normalized));
      return normalized;
    } catch (err) {
      throw err;
    }
  }
};

const pushSubscriptionsDb = {
  saveSubscription: (userId, endpoint, keysP256dh, keysAuth) => {
    try {
      db.prepare(
        `INSERT INTO push_subscriptions (user_id, endpoint, keys_p256dh, keys_auth)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET
           user_id = excluded.user_id,
           keys_p256dh = excluded.keys_p256dh,
           keys_auth = excluded.keys_auth`
      ).run(userId, endpoint, keysP256dh, keysAuth);
    } catch (err) {
      throw err;
    }
  },

  getSubscriptions: (userId) => {
    try {
      return db.prepare('SELECT endpoint, keys_p256dh, keys_auth FROM push_subscriptions WHERE user_id = ?').all(userId);
    } catch (err) {
      throw err;
    }
  },

  removeSubscription: (endpoint) => {
    try {
      db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
    } catch (err) {
      throw err;
    }
  },

  removeAllForUser: (userId) => {
    try {
      db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(userId);
    } catch (err) {
      throw err;
    }
  }
};

// Session custom names database operations (scoped per user)
const sessionNamesDb = {
  // Set (insert or update) a custom session name
  setName: (userId, sessionId, provider, customName) => {
    db.prepare(`
      INSERT INTO session_names (user_id, session_id, provider, custom_name)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, session_id, provider)
      DO UPDATE SET custom_name = excluded.custom_name, updated_at = CURRENT_TIMESTAMP
    `).run(userId, sessionId, provider, customName);
  },

  // Get a single custom session name
  getName: (userId, sessionId, provider) => {
    const row = db.prepare(
      'SELECT custom_name FROM session_names WHERE user_id = ? AND session_id = ? AND provider = ?'
    ).get(userId, sessionId, provider);
    return row?.custom_name || null;
  },

  // Batch lookup — returns Map<sessionId, customName>
  getNames: (userId, sessionIds, provider) => {
    if (!sessionIds.length) return new Map();
    const placeholders = sessionIds.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT session_id, custom_name FROM session_names
       WHERE user_id = ? AND session_id IN (${placeholders}) AND provider = ?`
    ).all(userId, ...sessionIds, provider);
    return new Map(rows.map(r => [r.session_id, r.custom_name]));
  },

  // Delete a custom session name
  deleteName: (userId, sessionId, provider) => {
    return db.prepare(
      'DELETE FROM session_names WHERE user_id = ? AND session_id = ? AND provider = ?'
    ).run(userId, sessionId, provider).changes > 0;
  },
};

// Apply custom session names from the database (overrides CLI-generated summaries)
function applyCustomSessionNames(userId, sessions, provider) {
  if (!sessions?.length) return;
  try {
    const ids = sessions.map(s => s.id);
    const customNames = sessionNamesDb.getNames(userId, ids, provider);
    for (const session of sessions) {
      const custom = customNames.get(session.id);
      if (custom) session.summary = custom;
    }
  } catch (error) {
    console.warn(`[DB] Failed to apply custom session names for ${provider}:`, error.message);
  }
}

// App config database operations
const appConfigDb = {
  get: (key) => {
    try {
      const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(key);
      return row?.value || null;
    } catch (err) {
      return null;
    }
  },

  set: (key, value) => {
    db.prepare(
      'INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(key, value);
  },

  getOrCreateJwtSecret: () => {
    let secret = appConfigDb.get('jwt_secret');
    if (!secret) {
      secret = crypto.randomBytes(64).toString('hex');
      appConfigDb.set('jwt_secret', secret);
    }
    return secret;
  }
};

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

// Backward compatibility - keep old names pointing to new system
const githubTokensDb = {
  createGithubToken: (userId, tokenName, githubToken, description = null) => {
    return credentialsDb.createCredential(userId, tokenName, 'github_token', githubToken, description);
  },
  getGithubTokens: (userId) => {
    return credentialsDb.getCredentials(userId, 'github_token');
  },
  getActiveGithubToken: (userId) => {
    return credentialsDb.getActiveCredential(userId, 'github_token');
  },
  deleteGithubToken: (userId, tokenId) => {
    return credentialsDb.deleteCredential(userId, tokenId);
  },
  toggleGithubToken: (userId, tokenId, isActive) => {
    return credentialsDb.toggleCredential(userId, tokenId, isActive);
  }
};

export {
  db,
  initializeDatabase,
  userDb,
  apiKeysDb,
  credentialsDb,
  notificationPreferencesDb,
  pushSubscriptionsDb,
  sessionNamesDb,
  applyCustomSessionNames,
  appConfigDb,
  systemSettingsDb,
  githubTokensDb // Backward compatibility
};
