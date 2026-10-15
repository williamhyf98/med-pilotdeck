// ui/server/testUtils/legacyRoot.js
// Shared fixture: builds a single-user (pre multi-user) PILOT_HOME layout at `root`.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createProjectId } from '../utils/pilotPaths.js';

export function seedLegacyRoot(root) {
  const w = (p, c = 'x') => {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), c);
  };
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
    CREATE TABLE api_keys (id INTEGER PRIMARY KEY, user_id INTEGER, key_name TEXT, api_key TEXT UNIQUE, created_at DATETIME, last_used DATETIME, is_active BOOLEAN DEFAULT 1);
    CREATE TABLE user_credentials (id INTEGER PRIMARY KEY, user_id INTEGER, credential_name TEXT, credential_type TEXT, credential_value TEXT, description TEXT, created_at DATETIME, is_active BOOLEAN DEFAULT 1);
    INSERT INTO users (username, password_hash) VALUES ('local', 'h');
    INSERT INTO session_names (session_id, provider, custom_name) VALUES ('web:s_1', 'pilotdeck', '旧名字');
    INSERT INTO api_keys (user_id, key_name, api_key, created_at, is_active) VALUES (1, 'cli', 'ck_legacykey', '2026-01-01 00:00:00', 1);
    INSERT INTO user_credentials (user_id, credential_name, credential_type, credential_value, description, created_at, is_active)
      VALUES (1, 'github', 'github_token', 'ghp_legacy', 'old token', '2026-01-01 00:00:00', 1);`);
  legacy.close();
}
