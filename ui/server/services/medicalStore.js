import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { resolvePilotHome } from '../utils/pilotPaths.js';

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MIN_TTL_MS = 60 * 1_000;
const DEFAULT_AUDIT_TTL_MS = 90 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_RECORDS_PER_OWNER = 1_000;
const DEFAULT_MAX_RECORD_BYTES = 24 * 1024 * 1024;
const MAX_AUDIT_METADATA_BYTES = 4 * 1024;
const KIND_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{7,127}$/;

export class MedicalStoreError extends Error {
  constructor(code, status = 500) {
    super('The medical data store operation failed.');
    this.name = 'MedicalStoreError';
    this.code = code;
    this.status = status;
  }
}

export class MedicalStore {
  constructor(options = {}) {
    this.now = options.now || Date.now;
    this.defaultTtlMs = boundedInteger(
      options.defaultTtlMs ?? process.env.PILOTDECK_MEDICAL_DATA_TTL_MS,
      DEFAULT_TTL_MS,
      MIN_TTL_MS,
      MAX_TTL_MS,
    );
    this.maxTtlMs = boundedInteger(
      options.maxTtlMs,
      MAX_TTL_MS,
      this.defaultTtlMs,
      MAX_TTL_MS,
    );
    this.auditTtlMs = boundedInteger(
      options.auditTtlMs ?? process.env.PILOTDECK_MEDICAL_AUDIT_TTL_MS,
      DEFAULT_AUDIT_TTL_MS,
      24 * 60 * 60 * 1_000,
      365 * 24 * 60 * 60 * 1_000,
    );
    this.maxRecordsPerOwner = boundedInteger(
      options.maxRecordsPerOwner,
      DEFAULT_MAX_RECORDS_PER_OWNER,
      10,
      10_000,
    );
    this.maxRecordBytes = boundedInteger(
      options.maxRecordBytes,
      DEFAULT_MAX_RECORD_BYTES,
      64 * 1024,
      64 * 1024 * 1024,
    );

    const filename = options.filename
      ?? process.env.PILOTDECK_MEDICAL_STORE_PATH
      ?? path.join(resolvePilotHome(), 'medical', 'medical.sqlite3');
    this.filename = filename;
    this.ownsDatabase = !options.db;

    if (!options.db && filename !== ':memory:') {
      const directory = path.dirname(path.resolve(filename));
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      securePermissions(directory, 0o700);
    }

    this.db = options.db || new Database(filename);
    this.configureDatabase();
    this.initializeSchema();

    if (!options.db && filename !== ':memory:') {
      const resolvedFilename = path.resolve(filename);
      securePermissions(resolvedFilename, 0o600);
      securePermissions(`${resolvedFilename}-wal`, 0o600);
      securePermissions(`${resolvedFilename}-shm`, 0o600);
    }
  }

  configureDatabase() {
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('secure_delete = ON');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('journal_size_limit = 0');
    this.db.pragma('wal_autocheckpoint = 100');
  }

  initializeSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS medical_records (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        data_json TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_medical_records_owner_kind_updated
        ON medical_records(owner_id, kind, updated_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_medical_records_expiry
        ON medical_records(expires_at_ms);

      CREATE TABLE IF NOT EXISTS medical_settings (
        owner_id TEXT PRIMARY KEY,
        data_json TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS medical_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_hash TEXT NOT NULL,
        request_id TEXT,
        action TEXT NOT NULL,
        resource_kind TEXT,
        resource_id TEXT,
        outcome TEXT NOT NULL,
        status INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        rag_corpus_id TEXT,
        rag_corpus_version TEXT,
        attachment_sha256 TEXT,
        prompt_version TEXT,
        profile_id TEXT,
        model_id TEXT,
        source_ids_json TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_medical_audit_owner_created
        ON medical_audit(owner_hash, created_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_medical_audit_expiry
        ON medical_audit(created_at_ms);
    `);

    // Schema migration: add structured audit columns if missing on existing databases
    this._migrateAuditSchema();
  }

  _migrateAuditSchema() {
    try {
      const cols = this.db.prepare("PRAGMA table_info(medical_audit)").all();
      const existing = new Set(cols.map((c) => c.name));
      const migrations = [
        ['rag_corpus_id', 'TEXT'],
        ['rag_corpus_version', 'TEXT'],
        ['attachment_sha256', 'TEXT'],
        ['prompt_version', 'TEXT'],
        ['profile_id', 'TEXT'],
        ['model_id', 'TEXT'],
        ['source_ids_json', 'TEXT'],
        ['retry_count', 'INTEGER NOT NULL DEFAULT 0'],
      ];
      for (const [col, colType] of migrations) {
        if (!existing.has(col)) {
          this.db.exec(`ALTER TABLE medical_audit ADD COLUMN ${col} ${colType}`);
        }
      }
    } catch {
      // Non-fatal: audit still works with metadata_json fallback.
    }
  }

  status() {
    return {
      available: true,
      persistent: this.filename !== ':memory:',
      defaultTtlSeconds: Math.floor(this.defaultTtlMs / 1_000),
      maxTtlSeconds: Math.floor(this.maxTtlMs / 1_000),
    };
  }

  createRecord({ owner, kind, data, id = undefined, ttlMs = undefined }) {
    const ownerId = normalizeOwner(owner);
    const normalizedKind = normalizeKind(kind);
    const recordId = id === undefined ? createRecordId(normalizedKind) : normalizeId(id);
    const serialized = serializeData(data, this.maxRecordBytes);
    const now = this.now();
    const expiresAt = now + normalizeTtl(ttlMs, this.defaultTtlMs, this.maxTtlMs);

    const create = this.db.transaction(() => {
      this.cleanupExpired(now);
      const count = this.db.prepare(
        'SELECT COUNT(*) AS count FROM medical_records WHERE owner_id = ?',
      ).get(ownerId)?.count ?? 0;
      if (count >= this.maxRecordsPerOwner) {
        throw new MedicalStoreError('MEDICAL_STORE_CAPACITY_EXCEEDED', 429);
      }
      try {
        this.db.prepare(`
          INSERT INTO medical_records (
            id, owner_id, kind, data_json, version,
            created_at_ms, updated_at_ms, expires_at_ms
          ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
        `).run(recordId, ownerId, normalizedKind, serialized, now, now, expiresAt);
      } catch (error) {
        if (String(error?.code || '').includes('SQLITE_CONSTRAINT')) {
          throw new MedicalStoreError('MEDICAL_RECORD_CONFLICT', 409);
        }
        throw error;
      }
    });
    create();
    return this.getRecord(ownerId, normalizedKind, recordId);
  }

  getRecord(owner, kind, id) {
    const ownerId = normalizeOwner(owner);
    const normalizedKind = normalizeKind(kind);
    const recordId = normalizeId(id);
    const now = this.now();
    const row = this.db.prepare(`
      SELECT id, kind, data_json, version, created_at_ms, updated_at_ms, expires_at_ms
      FROM medical_records
      WHERE id = ? AND owner_id = ? AND kind = ? AND expires_at_ms > ?
    `).get(recordId, ownerId, normalizedKind, now);
    if (!row) {
      this.db.prepare(
        'DELETE FROM medical_records WHERE id = ? AND expires_at_ms <= ?',
      ).run(recordId, now);
      return null;
    }
    return publicRecord(row);
  }

  listRecords(owner, kind, options = {}) {
    const ownerId = normalizeOwner(owner);
    const normalizedKind = normalizeKind(kind);
    const now = this.now();
    const limit = boundedInteger(options.limit, 50, 1, 100);
    const before = Number.isSafeInteger(options.before) && options.before > 0
      ? options.before
      : Number.MAX_SAFE_INTEGER;
    this.cleanupExpired(now);
    return this.db.prepare(`
      SELECT id, kind, data_json, version, created_at_ms, updated_at_ms, expires_at_ms
      FROM medical_records
      WHERE owner_id = ? AND kind = ? AND updated_at_ms < ? AND expires_at_ms > ?
      ORDER BY updated_at_ms DESC, id DESC
      LIMIT ?
    `).all(ownerId, normalizedKind, before, now, limit).map(publicRecord);
  }

  updateRecord({
    owner,
    kind,
    id,
    data,
    expectedVersion,
    ttlMs = undefined,
  }) {
    const ownerId = normalizeOwner(owner);
    const normalizedKind = normalizeKind(kind);
    const recordId = normalizeId(id);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new MedicalStoreError('MEDICAL_VERSION_REQUIRED', 400);
    }
    const serialized = serializeData(data, this.maxRecordBytes);
    const now = this.now();
    const expiresAt = now + normalizeTtl(ttlMs, this.defaultTtlMs, this.maxTtlMs);
    const result = this.db.prepare(`
      UPDATE medical_records
      SET data_json = ?, version = version + 1, updated_at_ms = ?, expires_at_ms = ?
      WHERE id = ? AND owner_id = ? AND kind = ? AND version = ? AND expires_at_ms > ?
    `).run(
      serialized,
      now,
      expiresAt,
      recordId,
      ownerId,
      normalizedKind,
      expectedVersion,
      now,
    );
    if (result.changes === 0) {
      const existing = this.getRecord(ownerId, normalizedKind, recordId);
      if (!existing) return null;
      throw new MedicalStoreError('MEDICAL_VERSION_CONFLICT', 409);
    }
    return this.getRecord(ownerId, normalizedKind, recordId);
  }

  deleteRecord(owner, kind, id) {
    const result = this.db.prepare(`
      DELETE FROM medical_records WHERE id = ? AND owner_id = ? AND kind = ?
    `).run(normalizeId(id), normalizeOwner(owner), normalizeKind(kind));
    return result.changes > 0;
  }

  getSettings(owner) {
    const row = this.db.prepare(`
      SELECT data_json, version, updated_at_ms
      FROM medical_settings WHERE owner_id = ?
    `).get(normalizeOwner(owner));
    if (!row) return null;
    return {
      data: parseStoredJson(row.data_json),
      version: row.version,
      updatedAt: toIso(row.updated_at_ms),
    };
  }

  updateSettings(owner, data, expectedVersion = undefined) {
    const ownerId = normalizeOwner(owner);
    const serialized = serializeData(data, 64 * 1024);
    const now = this.now();
    const current = this.db.prepare(
      'SELECT version FROM medical_settings WHERE owner_id = ?',
    ).get(ownerId);
    if (
      expectedVersion !== undefined
      && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0)
    ) {
      throw new MedicalStoreError('MEDICAL_VERSION_REQUIRED', 400);
    }
    if (current && expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new MedicalStoreError('MEDICAL_VERSION_CONFLICT', 409);
    }
    if (!current && expectedVersion !== undefined && expectedVersion !== 0) {
      throw new MedicalStoreError('MEDICAL_VERSION_CONFLICT', 409);
    }

    this.db.prepare(`
      INSERT INTO medical_settings(owner_id, data_json, version, updated_at_ms)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(owner_id) DO UPDATE SET
        data_json = excluded.data_json,
        version = medical_settings.version + 1,
        updated_at_ms = excluded.updated_at_ms
    `).run(ownerId, serialized, now);
    return this.getSettings(ownerId);
  }

  appendAudit(entry) {
    const createdAt = this.now();
    const metadata = sanitizeAuditMetadata(entry.metadata);
    const serialized = JSON.stringify(metadata);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_AUDIT_METADATA_BYTES) {
      throw new MedicalStoreError('MEDICAL_AUDIT_METADATA_TOO_LARGE', 400);
    }
    // Extract structured audit fields from metadata (PHI-safe: only IDs/hashes/versions)
    const ragInfo = extractRagAuditInfo(metadata);
    const attachmentHash = safeAttachmentHash(metadata);
    const promptVer = safeAuditText(metadata?.promptVersion, 64);
    const profileId = safeAuditText(metadata?.profileId || metadata?.profile, 128);
    const modelId = safeAuditText(metadata?.modelId || metadata?.model, 200);
    const sourceIds = safeSourceIdsJson(metadata?.sourceIds || metadata?.source_ids);
    const retryCount = Number.isSafeInteger(metadata?.retryCount) && metadata.retryCount >= 0
      ? metadata.retryCount : 0;

    this.db.prepare(`
      INSERT INTO medical_audit (
        owner_hash, request_id, action, resource_kind, resource_id,
        outcome, status, duration_ms, metadata_json, created_at_ms,
        rag_corpus_id, rag_corpus_version, attachment_sha256, prompt_version,
        profile_id, model_id, source_ids_json, retry_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ownerHash(entry.owner),
      shortAuditText(entry.requestId, 128),
      shortAuditText(entry.action, 160) || 'medical.request',
      shortAuditText(entry.resourceKind, 64),
      safeAuditIdentifier(entry.resourceId),
      normalizeAuditOutcome(entry.outcome),
      boundedInteger(entry.status, 500, 100, 599),
      boundedInteger(entry.durationMs, 0, 0, 24 * 60 * 60 * 1_000),
      serialized,
      createdAt,
      ragInfo.corpusId,
      ragInfo.corpusVersion,
      attachmentHash,
      promptVer,
      profileId,
      modelId,
      sourceIds,
      retryCount,
    );
    this.cleanupExpired(createdAt);
    this.cleanupAudit(createdAt);
  }

  listAudit(owner, options = {}) {
    const limit = boundedInteger(options.limit, 50, 1, 200);
    const rows = this.db.prepare(`
      SELECT request_id, action, resource_kind, resource_id, outcome,
             status, duration_ms, metadata_json, created_at_ms,
             rag_corpus_id, rag_corpus_version, attachment_sha256,
             prompt_version, profile_id, model_id, source_ids_json, retry_count
      FROM medical_audit
      WHERE owner_hash = ? AND created_at_ms >= ?
      ORDER BY created_at_ms DESC, id DESC
      LIMIT ?
    `).all(ownerHash(owner), this.now() - this.auditTtlMs, limit);
    return rows.map((row) => ({
      requestId: row.request_id || null,
      action: row.action,
      resourceKind: row.resource_kind || null,
      resourceId: row.resource_id || null,
      outcome: row.outcome,
      status: row.status,
      durationMs: row.duration_ms,
      metadata: parseStoredJson(row.metadata_json),
      ragCorpusId: row.rag_corpus_id || null,
      ragCorpusVersion: row.rag_corpus_version || null,
      attachmentSha256: row.attachment_sha256 || null,
      promptVersion: row.prompt_version || null,
      profileId: row.profile_id || null,
      modelId: row.model_id || null,
      sourceIds: parseStoredJson(row.source_ids_json) || null,
      retryCount: row.retry_count || 0,
      createdAt: toIso(row.created_at_ms),
    }));
  }

  cleanupExpired(now = this.now()) {
    return this.db.prepare(
      'DELETE FROM medical_records WHERE expires_at_ms <= ?',
    ).run(now).changes;
  }

  cleanupAudit(now = this.now()) {
    return this.db.prepare(
      'DELETE FROM medical_audit WHERE created_at_ms < ?',
    ).run(now - this.auditTtlMs).changes;
  }

  close() {
    if (this.ownsDatabase && this.db?.open) this.db.close();
  }
}

export function createRecordId(kind) {
  const prefix = String(kind || 'record').replace(/[^a-z0-9]/g, '').slice(0, 12) || 'record';
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

function publicRecord(row) {
  return {
    id: row.id,
    kind: row.kind,
    data: parseStoredJson(row.data_json),
    version: row.version,
    createdAt: toIso(row.created_at_ms),
    updatedAt: toIso(row.updated_at_ms),
    expiresAt: toIso(row.expires_at_ms),
  };
}

function serializeData(value, maxBytes) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new MedicalStoreError('MEDICAL_RECORD_INVALID', 400);
  }
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw new MedicalStoreError('MEDICAL_RECORD_TOO_LARGE', 413);
  }
  return serialized;
}

function parseStoredJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    throw new MedicalStoreError('MEDICAL_STORE_CORRUPT', 500);
  }
}

function normalizeOwner(value) {
  const owner = String(value ?? '').trim();
  if (!owner || owner.length > 256 || /[\u0000-\u001f\u007f]/.test(owner)) {
    throw new MedicalStoreError('MEDICAL_OWNER_INVALID', 400);
  }
  return owner;
}

function normalizeKind(value) {
  const kind = String(value ?? '').trim();
  if (!KIND_PATTERN.test(kind)) {
    throw new MedicalStoreError('MEDICAL_RECORD_KIND_INVALID', 400);
  }
  return kind;
}

function normalizeId(value) {
  const id = String(value ?? '').trim();
  if (!ID_PATTERN.test(id)) {
    throw new MedicalStoreError('MEDICAL_RECORD_ID_INVALID', 400);
  }
  return id;
}

function normalizeTtl(value, defaultValue, maxValue) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < MIN_TTL_MS || parsed > maxValue) {
    throw new MedicalStoreError('MEDICAL_TTL_INVALID', 400);
  }
  return parsed;
}

function ownerHash(owner) {
  return createHash('sha256').update(normalizeOwner(owner)).digest('hex').slice(0, 24);
}

function sanitizeAuditMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = shortAuditText(rawKey, 64);
    if (!key || isSensitiveAuditKey(key)) continue;
    if (typeof rawValue === 'boolean' || rawValue === null) {
      result[key] = rawValue;
    } else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
      result[key] = rawValue;
    } else if (typeof rawValue === 'string') {
      const text = shortAuditText(rawValue, 160);
      if (text && !looksLikePathOrSecret(text)) result[key] = text;
    }
  }
  return result;
}

function isSensitiveAuditKey(key) {
  return /(?:body|content|description|message|prompt|response|text|secret|token|key|path|file)/i.test(key);
}

function safeAuditIdentifier(value) {
  const text = shortAuditText(value, 128);
  return text && ID_PATTERN.test(text) ? text : null;
}

function shortAuditText(value, maxLength) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/[\u0000-\u001f\u007f]/g, ' ');
  return normalized ? normalized.slice(0, maxLength) : null;
}

function looksLikePathOrSecret(value) {
  return (
    /(?:^|[\\/])(?:users?|home|tmp|var|etc|private|local_data)(?:[\\/]|$)/i.test(value)
    || /^[A-Za-z]:[\\/]/.test(value)
    || /^\/(?:[^/]+\/){1,}/.test(value)
    || /bearer\s+[A-Za-z0-9._-]{8,}/i.test(value)
    || /(?:api[_-]?key|password|secret)\s*[:=]/i.test(value)
  );
}

function normalizeAuditOutcome(value) {
  return value === 'success' ? 'success' : value === 'rejected' ? 'rejected' : 'error';
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function toIso(value) {
  return new Date(value).toISOString();
}

function securePermissions(target, mode) {
  try {
    chmodSync(target, mode);
  } catch {
    // Windows and some managed filesystems do not expose POSIX mode bits.
    // SQLite ownership and the enclosing PilotDeck home remain authoritative.
  }
}

// ---- Structured audit field extractors (PHI-safe) ----

/**
 * Extract RAG corpus id and version from audit metadata.
 * Only stores opaque identifiers — never chunk text or query content.
 */
function extractRagAuditInfo(metadata) {
  if (!metadata || typeof metadata !== 'object') return { corpusId: null, corpusVersion: null };
  return {
    corpusId: safeAuditText(metadata.ragCorpusId || metadata.corpusId || metadata.corpus_id, 200),
    corpusVersion: safeAuditText(metadata.ragCorpusVersion || metadata.corpusVersion || metadata.corpus_version, 64),
  };
}

/**
 * Extract attachment SHA-256 from metadata if present.
 * Rejects values that look like paths, secrets, or non-hex strings.
 */
function safeAttachmentHash(metadata) {
  if (!metadata || typeof metadata !== 'object') return null;
  const raw = metadata.attachmentSha256 || metadata.attachment_sha256 || metadata.fileHash || metadata.file_hash;
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().toLowerCase();
  // Must be a 64-char hex string
  if (/^[0-9a-f]{64}$/.test(cleaned)) return cleaned;
  return null;
}

/**
 * Serialize source IDs as a JSON array, filtering out anything that
 * could contain PHI (paths, full text, identifiers exceeding budget).
 */
function safeSourceIdsJson(value) {
  if (!Array.isArray(value)) return null;
  const cleaned = value
    .map((item) => (typeof item === 'string' ? item.slice(0, 200) : null))
    .filter(Boolean)
    .slice(0, 50);
  if (cleaned.length === 0) return null;
  return JSON.stringify(cleaned);
}

/**
 * Safe audit text: no control chars, no path-like tokens, length-bounded.
 */
function safeAuditText(value, maxLength) {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().replace(/[ -]/g, '');
  if (!cleaned || cleaned.length > maxLength * 2) return null;
  // Reject paths and secrets
  if (/^(?:[A-Za-z]:[\\/]|\/[^/]|\.\.[\\/])/.test(cleaned)) return null;
  if (/api[_-]?key|password|secret|token/i.test(cleaned)) return null;
  return cleaned.slice(0, maxLength) || null;
}
