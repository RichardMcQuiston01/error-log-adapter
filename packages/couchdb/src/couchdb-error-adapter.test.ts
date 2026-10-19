import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BatchingErrorAdapter } from '@richardmcquiston01/error-log-adapter';
import type { ErrorLogEntry } from '@richardmcquiston01/error-log-adapter';
import {
  CouchDbErrorAdapter,
  buildErrorLogIndex,
} from './couchdb-error-adapter.js';
import type {
  CouchDbBulkResult,
  CouchDbDatabaseLike,
  CouchDbDocument,
} from './couchdb-error-adapter.js';

const entry: ErrorLogEntry = {
  code: 'DB_DOWN',
  message: 'cannot reach the database',
  source: 'checkout',
  cause: new Error('ECONNREFUSED'),
  timestamp: '2026-10-19T05:00:00.123Z',
  id: '3f2b8c1e-5a7d-4e21-9c0a-1b2c3d4e5f60',
};

function conflictError(): Error {
  return Object.assign(new Error('Document update conflict.'), {
    statusCode: 409,
    error: 'conflict',
  });
}

interface Fake {
  database: CouchDbDatabaseLike;
  inserted: CouchDbDocument[];
  bulked: CouchDbDocument[][];
}

function fakeDatabase(overrides: Partial<CouchDbDatabaseLike> = {}): Fake {
  const inserted: CouchDbDocument[] = [];
  const bulked: CouchDbDocument[][] = [];
  const database: CouchDbDatabaseLike = {
    async insert(document): Promise<unknown> {
      inserted.push(document);
      return { ok: true };
    },
    async bulk(request): Promise<CouchDbBulkResult[]> {
      bulked.push(request.docs);
      return request.docs.map((doc) => ({ ok: true, id: doc._id }));
    },
    ...overrides,
  };
  return { database, inserted, bulked };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('CouchDbErrorAdapter', () => {
  it('stores a document whose _id is the entry id', async () => {
    const { database, inserted } = fakeDatabase();
    const result = await new CouchDbErrorAdapter(database).log(entry);
    expect(result).toEqual({ ok: true });
    expect(inserted).toHaveLength(1);
    const [doc] = inserted as [CouchDbDocument];
    expect(doc).toMatchObject({
      _id: entry.id,
      type: 'error_log',
      code: 'DB_DOWN',
      message: 'cannot reach the database',
      source: 'checkout',
      occurred_at: '2026-10-19T05:00:00.123Z',
    });
    expect(doc.created_at).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
  });

  it('stores the cause as JSON, not a string', async () => {
    const { database, inserted } = fakeDatabase();
    await new CouchDbErrorAdapter(database).log(entry);
    const cause = inserted[0]?.cause as { message: string };
    expect(typeof cause).toBe('object');
    expect(cause.message).toBe('ECONNREFUSED');
  });

  it('leaves out a missing cause and source and generates an id', async () => {
    const { database, inserted } = fakeDatabase();
    await new CouchDbErrorAdapter(database).log({ code: 'X', message: 'y' });
    const doc = inserted[0] as CouchDbDocument;
    expect('cause' in doc).toBe(false);
    expect('source' in doc).toBe(false);
    expect(doc._id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('honors docType, including leaving the field out', async () => {
    const custom = fakeDatabase();
    await new CouchDbErrorAdapter(custom.database, {
      docType: 'app_error',
    }).log(entry);
    expect(custom.inserted[0]?.type).toBe('app_error');
    const none = fakeDatabase();
    await new CouchDbErrorAdapter(none.database, { docType: '' }).log(entry);
    expect('type' in (none.inserted[0] as CouchDbDocument)).toBe(false);
  });

  it('treats a conflict as success: the entry is already stored', async () => {
    const { database } = fakeDatabase({
      insert: () => Promise.reject(conflictError()),
    });
    expect(await new CouchDbErrorAdapter(database).log(entry)).toEqual({
      ok: true,
    });
  });

  it('reports any other failure, with CouchDB reason', async () => {
    const missing = Object.assign(new Error('Database does not exist.'), {
      statusCode: 404,
      error: 'not_found',
    });
    const { database } = fakeDatabase({
      insert: () => Promise.reject(missing),
    });
    expect(await new CouchDbErrorAdapter(database).log(entry)).toEqual({
      ok: false,
      error:
        'CouchDbErrorAdapter failed to write a document: CouchDB answered HTTP 404 (not_found): Database does not exist.',
    });
  });

  it('times out a request that never completes', async () => {
    const { database } = fakeDatabase({
      insert: () => new Promise<unknown>(() => undefined),
    });
    const result = await new CouchDbErrorAdapter(database, {
      timeoutMs: 20,
    }).log(entry);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('CouchDB did not respond within 20 ms');
  });

  it('rejects an invalid id or timestamp without any request', async () => {
    const { database, inserted } = fakeDatabase();
    const adapter = new CouchDbErrorAdapter(database);
    expect((await adapter.log({ ...entry, id: 'nope' })).error).toContain(
      'entry.id must be a UUID'
    );
    expect(
      (await adapter.log({ ...entry, timestamp: 'yesterday' })).error
    ).toContain('is not a valid ISO 8601 date');
    expect(inserted).toHaveLength(0);
  });

  it('rejects a bad timeout', () => {
    const { database } = fakeDatabase();
    expect(() => new CouchDbErrorAdapter(database, { timeoutMs: 0 })).toThrow(
      RangeError
    );
  });

  describe('logBatch', () => {
    it('writes every entry with one _bulk_docs request', async () => {
      const { database, bulked } = fakeDatabase();
      const result = await new CouchDbErrorAdapter(database).logBatch([
        { code: 'A', message: '1' },
        { code: 'B', message: '2' },
      ]);
      expect(result).toEqual({ ok: true });
      expect(bulked).toHaveLength(1);
      expect(bulked[0]?.map((doc) => doc.code)).toEqual(['A', 'B']);
    });

    it('does nothing for an empty batch', async () => {
      const { database, bulked } = fakeDatabase();
      expect(await new CouchDbErrorAdapter(database).logBatch([])).toEqual({
        ok: true,
      });
      expect(bulked).toHaveLength(0);
    });

    it('writes nothing when one entry is invalid', async () => {
      const { database, bulked } = fakeDatabase();
      const result = await new CouchDbErrorAdapter(database).logBatch([
        { code: 'A', message: '1' },
        { code: 'B', message: '2', id: 'nope' },
      ]);
      expect(result.ok).toBe(false);
      expect(result.error).toContain(
        'entry 1 could not be prepared, so nothing was written'
      );
      expect(bulked).toHaveLength(0);
    });

    it('counts per-document conflicts as stored', async () => {
      const { database } = fakeDatabase({
        bulk: async (request) =>
          request.docs.map((doc) => ({
            id: doc._id,
            error: 'conflict',
            reason: 'Document update conflict.',
          })),
      });
      expect(
        await new CouchDbErrorAdapter(database).logBatch([
          { code: 'A', message: '1' },
        ])
      ).toEqual({ ok: true });
    });

    it('reports documents CouchDB refused for another reason', async () => {
      const { database } = fakeDatabase({
        bulk: async (request) => [
          { ok: true, id: request.docs[0]?._id },
          {
            id: request.docs[1]?._id,
            error: 'forbidden',
            reason: 'validate_doc_update rejected it',
          },
        ],
      });
      const result = await new CouchDbErrorAdapter(database).logBatch([
        { code: 'A', message: '1' },
        { code: 'B', message: '2' },
      ]);
      expect(result.ok).toBe(false);
      expect(result.error).toContain(
        'CouchDB refused 1 of 2 documents, so 1 were stored'
      );
      expect(result.error).toContain(
        'forbidden (validate_doc_update rejected it)'
      );
    });

    it('reports a failed request for the whole batch', async () => {
      const { database } = fakeDatabase({
        bulk: () => Promise.reject(new Error('Name or password is incorrect.')),
      });
      const result = await new CouchDbErrorAdapter(database).logBatch([
        { code: 'A', message: '1' },
      ]);
      expect(result).toEqual({
        ok: false,
        error:
          'CouchDbErrorAdapter failed to write 1 document: Name or password is incorrect.',
      });
    });

    it('is used by BatchingErrorAdapter', async () => {
      const { database, bulked } = fakeDatabase();
      const batching = new BatchingErrorAdapter(
        new CouchDbErrorAdapter(database),
        { batchSize: 2, maxWaitMs: Infinity }
      );
      await batching.log({ code: 'A', message: '1' });
      await batching.log({ code: 'B', message: '2' });
      await batching.flush();
      expect(bulked).toHaveLength(1);
      expect(bulked[0]).toHaveLength(2);
    });
  });
});

describe('buildErrorLogIndex', () => {
  it('indexes type and occurred_at, or only occurred_at without a type', () => {
    expect(buildErrorLogIndex()).toEqual({
      index: { fields: ['type', 'occurred_at'] },
      name: 'error_log_occurred_at',
      type: 'json',
    });
    expect(buildErrorLogIndex('').index.fields).toEqual(['occurred_at']);
  });
});
