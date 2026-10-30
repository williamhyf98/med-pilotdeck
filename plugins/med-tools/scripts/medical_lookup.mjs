// 医疗语料库查询脚本：medical_lookup.mjs [query 关键词...]
// 用法: node medical_lookup.mjs schema          -- 打印表结构
//       node medical_lookup.mjs "关键词" [n]     -- 全文/模糊检索，默认返回前 n 条（默认3）
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const DB = path.join(process.env.USERPROFILE, '.pilotdeck', 'medical', 'medical.sqlite3');
const db = new DatabaseSync(DB);

const cmd = process.argv[2];
if (!cmd) {
  console.log('用法: node medical_lookup.mjs schema | "关键词" [top_n]');
  process.exit(0);
}

if (cmd === 'schema') {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name").all();
  console.log('TABLES:', tables.map(t => t.name).join(', '));
  for (const t of tables) {
    if (t.name.startsWith('sqlite_')) continue;
    try {
      const cols = db.prepare(`PRAGMA table_info(${t.name})`).all();
      console.log(`\n[${t.name}]`);
      for (const c of cols) console.log(`  ${c.cid} ${c.name} ${c.type}`);
    } catch (e) { console.log(`  (无法读取: ${e.message})`); }
  }
  process.exit(0);
}

const topN = parseInt(process.argv[3] || '3', 10);
const q = cmd;

// 尝试全文搜索，失败则用 LIKE 模糊检索
let rows = [];
try {
  rows = db.prepare(`SELECT * FROM chunks WHERE chunks MATCH ? LIMIT ?`).all(q, topN);
} catch (e) {
  try {
    rows = db.prepare(`SELECT * FROM chunks WHERE text LIKE ? OR content LIKE ? LIMIT ?`)
      .all(`%${q}%`, `%${q}%`, topN);
  } catch (e2) {
    // 表名未知时，列出所有含 text/content 字段的表逐一尝试
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    for (const t of tables) {
      const cols = db.prepare(`PRAGMA table_info(${t.name})`).all();
      const textCol = cols.find(c => /text|content|body|chunk/i.test(c.name));
      if (!textCol) continue;
      try {
        const hit = db.prepare(`SELECT * FROM ${t.name} WHERE ${textCol.name} LIKE ? LIMIT ?`).all(`%${q}%`, topN);
        if (hit.length) { rows.push(...hit.map(h => ({ table: t.name, ...h }))); }
      } catch (e3) {}
    }
    if (!rows.length) { console.log('NO_MATCH'); process.exit(0); }
  }
}

for (const r of rows) {
  console.log('====');
  for (const [k, v] of Object.entries(r)) {
    const s = String(v ?? '');
    console.log(`${k}: ${s.length > 600 ? s.slice(0, 600) + '…' : s}`);
  }
}
