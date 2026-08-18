import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { MedicalStore, MedicalStoreError } from './medicalStore.js';

const cleanups = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

describe('MedicalStore ownership, TTL, and optimistic locking', () => {
  it('persists records atomically and never returns another owner record', () => {
    const { store, filename } = createStore();
    const created = store.createRecord({
      owner: 'owner-one',
      kind: 'case',
      data: { title: 'Synthetic case' },
    });

    expect(created).toMatchObject({
      kind: 'case',
      data: { title: 'Synthetic case' },
      version: 1,
    });
    expect(store.getRecord('owner-two', 'case', created.id)).toBeNull();

    store.close();
    const reopened = new MedicalStore({ filename });
    cleanups.push(() => reopened.close());
    expect(reopened.getRecord('owner-one', 'case', created.id)?.data).toEqual({
      title: 'Synthetic case',
    });
  });

  it('expires records and enforces optimistic versions', () => {
    let now = 1_000_000;
    const store = new MedicalStore({
      filename: ':memory:',
      now: () => now,
      defaultTtlMs: 60_000,
    });
    cleanups.push(() => store.close());
    const created = store.createRecord({
      owner: 'owner-one',
      kind: 'table-doc',
      data: { rows: [] },
      ttlMs: 60_000,
    });
    const updated = store.updateRecord({
      owner: 'owner-one',
      kind: 'table-doc',
      id: created.id,
      data: { rows: [['ok']] },
      expectedVersion: 1,
      ttlMs: 60_000,
    });
    expect(updated.version).toBe(2);
    expect(() => store.updateRecord({
      owner: 'owner-one',
      kind: 'table-doc',
      id: created.id,
      data: { rows: [['stale']] },
      expectedVersion: 1,
    })).toThrowError(expect.objectContaining({
      code: 'MEDICAL_VERSION_CONFLICT',
      status: 409,
    }));

    now += 60_001;
    expect(store.getRecord('owner-one', 'table-doc', created.id)).toBeNull();
    expect(store.listRecords('owner-one', 'table-doc')).toEqual([]);
  });

  it('bounds owner capacity and serialized record size', () => {
    const store = new MedicalStore({
      filename: ':memory:',
      maxRecordsPerOwner: 10,
      maxRecordBytes: 64 * 1024,
    });
    cleanups.push(() => store.close());
    for (let index = 0; index < 10; index += 1) {
      store.createRecord({
        owner: 'owner-one',
        kind: 'artifact',
        data: { index },
      });
    }
    expect(() => store.createRecord({
      owner: 'owner-one',
      kind: 'artifact',
      data: { overflow: true },
    })).toThrowError(expect.objectContaining({
      code: 'MEDICAL_STORE_CAPACITY_EXCEEDED',
      status: 429,
    }));
    expect(() => store.createRecord({
      owner: 'owner-two',
      kind: 'artifact',
      data: { text: 'x'.repeat(70 * 1024) },
    })).toThrowError(expect.objectContaining({
      code: 'MEDICAL_RECORD_TOO_LARGE',
      status: 413,
    }));
  });
});

describe('MedicalStore settings and audit safety', () => {
  it('versions managed settings and rejects stale updates', () => {
    const { store } = createStore();
    const first = store.updateSettings('owner-one', { profileId: 'general-clinical' }, 0);
    expect(first.version).toBe(1);
    const second = store.updateSettings(
      'owner-one',
      { profileId: 'emergency-medicine' },
      first.version,
    );
    expect(second.version).toBe(2);
    expect(() => store.updateSettings(
      'owner-one',
      { profileId: 'trauma-team' },
      first.version,
    )).toThrow(MedicalStoreError);
  });

  it('records only bounded non-sensitive audit metadata for the same owner', () => {
    const { store } = createStore();
    store.appendAudit({
      owner: 'owner-one',
      requestId: 'request-safe',
      action: 'POST /api/medical/cases',
      outcome: 'success',
      status: 201,
      durationMs: 8,
      metadata: {
        capability: 'cases',
        count: 1,
        prompt: 'must not be retained',
        localPath: String.raw`C:\private\patient.txt`,
        note: 'Bearer should-not-survive',
      },
    });

    const events = store.listAudit('owner-one');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      requestId: 'request-safe',
      outcome: 'success',
      status: 201,
      metadata: { capability: 'cases', count: 1 },
    });
    expect(JSON.stringify(events)).not.toContain('patient');
    expect(JSON.stringify(events)).not.toContain('should-not-survive');
    expect(store.listAudit('owner-two')).toEqual([]);
  });
});

function createStore() {
  const directory = mkdtempSync(path.join(tmpdir(), 'pilotdeck-medical-store-'));
  const filename = path.join(directory, 'medical.sqlite3');
  const store = new MedicalStore({ filename });
  cleanups.push(() => {
    if (store.db?.open) store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, filename };
}
