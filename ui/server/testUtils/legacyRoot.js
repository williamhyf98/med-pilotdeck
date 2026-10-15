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
    INSERT INTO users (username, password_hash) VALUES ('local', 'h');
    INSERT INTO session_names (session_id, provider, custom_name) VALUES ('web:s_1', 'pilotdeck', '旧名字');`);
  legacy.close();
}
