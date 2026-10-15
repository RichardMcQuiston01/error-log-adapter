import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ErrorLogEntry } from '../types.js';
import {
  FirestoreErrorAdapter,
  RealtimeDatabaseErrorAdapter,
} from './firebase-error-adapter.js';
import { IndexedDbErrorAdapter } from './indexeddb-error-adapter.js';
import { JsonFileErrorAdapter } from './json-file-error-adapter.js';
import { MongoDbErrorAdapter } from './mongodb-error-adapter.js';
import { RedisErrorAdapter } from './redis-error-adapter.js';
import { S3ErrorAdapter } from './s3-error-adapter.js';
import {
  MySqlErrorAdapter,
  PostgresErrorAdapter,
} from './sql-error-adapter.js';
import type { SqlClientLike } from './sql-error-adapter.js';
import { SqliteErrorAdapter } from './sqlite-error-adapter.js';
import { SupabaseErrorAdapter } from './supabase-error-adapter.js';
import { WebStorageErrorAdapter } from './web-storage-error-adapter.js';
import { WebhookErrorAdapter } from './webhook-error-adapter.js';

const ID = '3f2b8c1e-5d4a-4e7b-9a10-2c6d8e0f1a2b';
const ENTRY: ErrorLogEntry = {
  code: 'E',
  message: 'm',
  timestamp: '2026-01-02T03:04:05.678Z',
  id: ID,
};
const BAD: ErrorLogEntry = { ...ENTRY, id: 'not-a-uuid' };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function quiet() {
  return vi.spyOn(console, 'error').mockImplementation(() => {});
}

describe('ErrorLogEntry.id with each adapter', () => {
  it('SQL: Postgres and MySQL store the id and tolerate a repeat', async () => {
    for (const make of [
      (c: SqlClientLike) => new PostgresErrorAdapter(c),
      (c: SqlClientLike) => new MySqlErrorAdapter(c),
    ]) {
      const query = vi.fn().mockResolvedValue({});
      await make({ query }).log(ENTRY);
      const insert = query.mock.calls.find(([sql]) =>
        String(sql).startsWith('INSERT')
      );
      expect(insert?.[1][0]).toBe(ID);
      expect(String(insert?.[0])).toMatch(
        /ON CONFLICT \(id\) DO NOTHING|ON DUPLICATE KEY UPDATE id = id/
      );
    }
  });

  it('SQLite stores the id and ignores a repeat', async () => {
    const run = vi.fn().mockReturnValue({});
    await new SqliteErrorAdapter({ run }).log(ENTRY);
    const insert = run.mock.calls.find(([sql]) =>
      String(sql).startsWith('INSERT')
    );
    expect(insert?.[1][0]).toBe(ID);
    expect(String(insert?.[0])).toContain('ON CONFLICT (id) DO NOTHING');
  });

  it('MongoDB uses the id as _id and treats a duplicate key as already stored', async () => {
    const insertOne = vi.fn().mockResolvedValue({});
    await new MongoDbErrorAdapter({ insertOne }).log(ENTRY);
    expect(insertOne.mock.calls[0][0]).toMatchObject({ _id: ID, code: 'E' });

    insertOne.mockRejectedValue(
      Object.assign(new Error('E11000 duplicate key'), { code: 11000 })
    );
    expect(await new MongoDbErrorAdapter({ insertOne }).log(ENTRY)).toEqual({
      ok: true,
    });
  });

  it('MongoDB leaves _id to the driver when there is no id, and still fails on a duplicate', async () => {
    const insertOne = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));
    quiet();
    const { id: _omit, ...noId } = ENTRY;
    const result = await new MongoDbErrorAdapter({ insertOne }).log(noId);
    expect(insertOne.mock.calls[0][0]).not.toHaveProperty('_id');
    expect(result.ok).toBe(false);
  });

  it('Supabase stores the id and treats a unique violation as already stored', async () => {
    const insert = vi
      .fn()
      .mockResolvedValue({ error: { message: 'duplicate', code: '23505' } });
    const adapter = new SupabaseErrorAdapter({ from: () => ({ insert }) });
    expect(await adapter.log(ENTRY)).toEqual({ ok: true });
    expect(insert.mock.calls[0][0].id).toBe(ID);

    quiet();
    const { id: _omit, ...noId } = ENTRY;
    expect((await adapter.log(noId)).ok).toBe(false);
  });

  it('Firestore uses the id as the document id', async () => {
    const set = vi.fn().mockResolvedValue({});
    const doc = vi.fn().mockReturnValue({ set });
    await new FirestoreErrorAdapter({ doc }).log(ENTRY);
    expect(doc).toHaveBeenCalledWith(ID);
    expect(set.mock.calls[0][0].id).toBe(ID);
  });

  it('Realtime Database writes an entry with an id under that key, and pushes otherwise', async () => {
    const childSet = vi.fn().mockResolvedValue({});
    const child = vi.fn().mockReturnValue({ set: childSet });
    const push = vi.fn().mockResolvedValue({});
    const adapter = new RealtimeDatabaseErrorAdapter({ push, child });

    await adapter.log(ENTRY);
    expect(child).toHaveBeenCalledWith(ID);
    expect(push).not.toHaveBeenCalled();

    const { id: _omit, ...noId } = ENTRY;
    await adapter.log(noId);
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('Realtime Database explains what is missing when the reference has no child', async () => {
    quiet();
    const push = vi.fn().mockResolvedValue({});
    const result = await new RealtimeDatabaseErrorAdapter({ push }).log(ENTRY);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('child(key).set(value)');
    expect(push).not.toHaveBeenCalled();
  });

  it('IndexedDB replaces the record for an entry with an id, and adds otherwise', async () => {
    const calls: string[] = [];
    const database = {
      transaction: () => {
        const tx = {
          oncomplete: null as ((e: never) => unknown) | null,
          onerror: null,
          onabort: null,
          objectStore: () => ({
            add: (v: unknown) => (calls.push('add'), v),
            put: (v: unknown) => (calls.push('put'), v),
          }),
        };
        queueMicrotask(() => tx.oncomplete?.(undefined as never));
        return tx;
      },
    };
    const adapter = new IndexedDbErrorAdapter(database);
    await adapter.log(ENTRY);
    const { id: _omit, ...noId } = ENTRY;
    await adapter.log(noId);
    expect(calls).toEqual(['put', 'add']);
  });

  it('Web Storage replaces the earlier record with the same id', async () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    };
    const adapter = new WebStorageErrorAdapter(storage);
    await adapter.log({ ...ENTRY, message: 'first' });
    await adapter.log({ ...ENTRY, message: 'second' });
    await adapter.log({ code: 'E', message: 'other' });
    const stored = JSON.parse(data.get('error_log') ?? '[]');
    expect(stored.map((r: { message: string }) => r.message)).toEqual([
      'second',
      'other',
    ]);
    expect(stored[0].id).toBe(ID);
  });

  it('S3 names the object after the id and timestamp, so a repeat overwrites it', async () => {
    const putObject = vi.fn().mockResolvedValue({});
    const adapter = new S3ErrorAdapter({ putObject }, 'b');
    await adapter.log(ENTRY);
    await adapter.log(ENTRY);
    expect(putObject.mock.calls[0][0].Key).toBe(putObject.mock.calls[1][0].Key);
    expect(putObject.mock.calls[0][0].Key).toContain(ID);
  });

  it('Redis and the NDJSON file adapter store the id (they cannot drop a repeat)', async () => {
    const sendCommand = vi.fn().mockResolvedValue(1);
    await new RedisErrorAdapter({ sendCommand }).log(ENTRY);
    expect(JSON.parse(sendCommand.mock.calls[0][0][2]).id).toBe(ID);

    const files = new Map<string, string>();
    const fs = {
      appendFile: async (p: string, d: string) =>
        void files.set(p, (files.get(p) ?? '') + d),
      mkdir: async () => undefined,
      stat: async () => ({ size: 0 }),
      rename: async () => undefined,
      rm: async () => undefined,
      readFile: async (p: string) => files.get(p) ?? '',
      writeFile: async (p: string, d: string) => void files.set(p, d),
    };
    await new JsonFileErrorAdapter('/l/e.ndjson', { fs }).log(ENTRY);
    expect(JSON.parse([...files.values()][0].trim()).id).toBe(ID);
  });

  it('the JSON array file replaces the record with the same id', async () => {
    const files = new Map<string, string>();
    const fs = {
      appendFile: async () => undefined,
      mkdir: async () => undefined,
      stat: async () => ({ size: 0 }),
      rename: async (from: string, to: string) => {
        files.set(to, files.get(from) ?? '');
        files.delete(from);
      },
      rm: async () => undefined,
      readFile: async (p: string) => {
        const content = files.get(p);
        if (content === undefined)
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return content;
      },
      writeFile: async (p: string, d: string) => void files.set(p, d),
    };
    const adapter = new JsonFileErrorAdapter('/l/e.json', {
      fs,
      mode: 'array',
    });
    await adapter.log({ ...ENTRY, message: 'first' });
    await adapter.log({ ...ENTRY, message: 'second' });
    const stored = JSON.parse(files.get('/l/e.json') ?? '[]');
    expect(stored).toHaveLength(1);
    expect(stored[0].message).toBe('second');
  });

  it('the webhook sends the id so the receiver can drop a repeat', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    await new WebhookErrorAdapter('https://example.com/e').log(ENTRY);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).id).toBe(ID);
    const { id: _omit, ...noId } = ENTRY;
    await new WebhookErrorAdapter('https://example.com/e').log(noId);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).not.toHaveProperty(
      'id'
    );
  });

  it('an id that is not a UUID makes log return ok: false with a clear message', async () => {
    quiet();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200 })
    );
    const sinks = [
      new MongoDbErrorAdapter({ insertOne: async () => ({}) }),
      new PostgresErrorAdapter({ query: async () => ({}) }),
      new SqliteErrorAdapter({ run: () => ({}) }),
      new SupabaseErrorAdapter({
        from: () => ({ insert: async () => ({ error: null }) }),
      }),
      new FirestoreErrorAdapter({ doc: () => ({ set: async () => ({}) }) }),
      new S3ErrorAdapter({ putObject: async () => ({}) }, 'b'),
      new RedisErrorAdapter({ sendCommand: async () => 1 }),
      new WebhookErrorAdapter('https://example.com/e'),
    ];
    for (const sink of sinks) {
      const result = await sink.log(BAD);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('entry.id must be a UUID');
    }
  });
});
