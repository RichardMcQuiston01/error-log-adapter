import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BatchingErrorAdapter } from '@richardmcquiston01/error-log-adapter';
import type { ErrorLogEntry } from '@richardmcquiston01/error-log-adapter';
import {
  ArangoDbErrorAdapter,
  buildErrorLogIndex,
} from './arangodb-error-adapter.js';
import type {
  ArangoCollectionLike,
  ArangoDocument,
  ArangoInsertOptionsLike,
} from './arangodb-error-adapter.js';

const entry: ErrorLogEntry = {
  code: 'DB_DOWN',
  message: 'cannot reach the database',
  source: 'checkout',
  cause: new Error('ECONNREFUSED'),
  timestamp: '2026-10-19T05:00:00.123Z',
  id: '3f2b8c1e-5a7d-4e21-9c0a-1b2c3d4e5f60',
};

function arangoError(
  errorNum: number,
  errorMessage: string,
  code: number
): Error {
  return Object.assign(new Error(errorMessage), { errorNum, code });
}

interface Fake {
  collection: ArangoCollectionLike;
  saved: { document: ArangoDocument; options?: ArangoInsertOptionsLike }[];
  savedAll: {
    documents: ArangoDocument[];
    options?: ArangoInsertOptionsLike;
  }[];
}

function fakeCollection(overrides: Partial<ArangoCollectionLike> = {}): Fake {
  const saved: Fake['saved'] = [];
  const savedAll: Fake['savedAll'] = [];
  const collection: ArangoCollectionLike = {
    async save(document, options): Promise<unknown> {
      saved.push({ document, ...(options && { options }) });
      return { _key: document._key };
    },
    async saveAll(documents, options): Promise<unknown[]> {
      savedAll.push({ documents, ...(options && { options }) });
      return documents.map((doc) => ({ _key: doc._key }));
    },
    ...overrides,
  };
  return { collection, saved, savedAll };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('ArangoDbErrorAdapter', () => {
  it('stores a document whose _key is the entry id, ignoring repeats', async () => {
    const { collection, saved } = fakeCollection();
    const result = await new ArangoDbErrorAdapter(collection).log(entry);
    expect(result).toEqual({ ok: true });
    expect(saved).toHaveLength(1);
    expect(saved[0]?.options).toEqual({ overwriteMode: 'ignore' });
    expect(saved[0]?.document).toMatchObject({
      _key: entry.id,
      code: 'DB_DOWN',
      message: 'cannot reach the database',
      source: 'checkout',
      occurred_at: '2026-10-19T05:00:00.123Z',
    });
    expect(saved[0]?.document.created_at).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
  });

  it('stores the cause as JSON, not a string', async () => {
    const { collection, saved } = fakeCollection();
    await new ArangoDbErrorAdapter(collection).log(entry);
    const cause = saved[0]?.document.cause as { message: string };
    expect(typeof cause).toBe('object');
    expect(cause.message).toBe('ECONNREFUSED');
  });

  it('leaves out a missing cause and source and generates a key', async () => {
    const { collection, saved } = fakeCollection();
    await new ArangoDbErrorAdapter(collection).log({ code: 'X', message: 'y' });
    const doc = saved[0]?.document as ArangoDocument;
    expect('cause' in doc).toBe(false);
    expect('source' in doc).toBe(false);
    expect(doc._key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('treats "key already exists" from an older server as success', async () => {
    const { collection } = fakeCollection({
      save: () =>
        Promise.reject(arangoError(1210, 'unique constraint violated', 409)),
    });
    expect(await new ArangoDbErrorAdapter(collection).log(entry)).toEqual({
      ok: true,
    });
  });

  it('reports any other failure with the ArangoDB error number and status', async () => {
    const { collection } = fakeCollection({
      save: () =>
        Promise.reject(
          arangoError(1203, 'collection or view not found: error_log', 404)
        ),
    });
    expect(await new ArangoDbErrorAdapter(collection).log(entry)).toEqual({
      ok: false,
      error:
        'ArangoDbErrorAdapter failed to write a document: ArangoDB error 1203 (HTTP 404): collection or view not found: error_log',
    });
  });

  it('reports an error that has no ArangoDB error number as plain text', async () => {
    const { collection } = fakeCollection({
      save: () => Promise.reject(new Error('fetch failed')),
    });
    const result = await new ArangoDbErrorAdapter(collection).log(entry);
    expect(result.error).toBe(
      'ArangoDbErrorAdapter failed to write a document: fetch failed'
    );
  });

  it('times out a request that never completes', async () => {
    const { collection } = fakeCollection({
      save: () => new Promise<unknown>(() => undefined),
    });
    const result = await new ArangoDbErrorAdapter(collection, {
      timeoutMs: 20,
    }).log(entry);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ArangoDB did not respond within 20 ms');
  });

  it('rejects an invalid id or timestamp without any request', async () => {
    const { collection, saved } = fakeCollection();
    const adapter = new ArangoDbErrorAdapter(collection);
    expect((await adapter.log({ ...entry, id: 'nope' })).error).toContain(
      'entry.id must be a UUID'
    );
    expect(
      (await adapter.log({ ...entry, timestamp: 'yesterday' })).error
    ).toContain('is not a valid ISO 8601 date');
    expect(saved).toHaveLength(0);
  });

  it('rejects a bad timeout', () => {
    const { collection } = fakeCollection();
    expect(
      () => new ArangoDbErrorAdapter(collection, { timeoutMs: 0 })
    ).toThrow(RangeError);
  });

  describe('logBatch', () => {
    it('writes every entry with one saveAll request', async () => {
      const { collection, savedAll } = fakeCollection();
      const result = await new ArangoDbErrorAdapter(collection).logBatch([
        { code: 'A', message: '1' },
        { code: 'B', message: '2' },
      ]);
      expect(result).toEqual({ ok: true });
      expect(savedAll).toHaveLength(1);
      expect(savedAll[0]?.options).toEqual({ overwriteMode: 'ignore' });
      expect(savedAll[0]?.documents.map((doc) => doc.code)).toEqual(['A', 'B']);
    });

    it('does nothing for an empty batch', async () => {
      const { collection, savedAll } = fakeCollection();
      expect(await new ArangoDbErrorAdapter(collection).logBatch([])).toEqual({
        ok: true,
      });
      expect(savedAll).toHaveLength(0);
    });

    it('writes nothing when one entry is invalid', async () => {
      const { collection, savedAll } = fakeCollection();
      const result = await new ArangoDbErrorAdapter(collection).logBatch([
        { code: 'A', message: '1' },
        { code: 'B', message: '2', id: 'nope' },
      ]);
      expect(result.ok).toBe(false);
      expect(result.error).toContain(
        'entry 1 could not be prepared, so nothing was written'
      );
      expect(savedAll).toHaveLength(0);
    });

    it('counts per-document key conflicts as stored', async () => {
      const { collection } = fakeCollection({
        saveAll: async (documents) =>
          documents.map(() => ({
            error: true,
            errorNum: 1210,
            errorMessage: 'unique constraint violated',
            code: 409,
          })),
      });
      expect(
        await new ArangoDbErrorAdapter(collection).logBatch([
          { code: 'A', message: '1' },
        ])
      ).toEqual({ ok: true });
    });

    it('reports documents ArangoDB refused for another reason', async () => {
      const { collection } = fakeCollection({
        saveAll: async (documents) => [
          { _key: documents[0]?._key },
          {
            error: true,
            errorNum: 1504,
            errorMessage: 'document does not match schema',
            code: 400,
          },
        ],
      });
      const result = await new ArangoDbErrorAdapter(collection).logBatch([
        { code: 'A', message: '1' },
        { code: 'B', message: '2' },
      ]);
      expect(result.ok).toBe(false);
      expect(result.error).toContain(
        'ArangoDB refused 1 of 2 documents, so 1 were stored'
      );
      expect(result.error).toContain(
        'error 1504 (document does not match schema)'
      );
    });

    it('reports a failed request for the whole batch', async () => {
      const { collection } = fakeCollection({
        saveAll: () =>
          Promise.reject(
            arangoError(401, 'not authorized to execute this request', 401)
          ),
      });
      const result = await new ArangoDbErrorAdapter(collection).logBatch([
        { code: 'A', message: '1' },
      ]);
      expect(result).toEqual({
        ok: false,
        error:
          'ArangoDbErrorAdapter failed to write 1 document: ArangoDB error 401 (HTTP 401): not authorized to execute this request',
      });
    });

    it('is used by BatchingErrorAdapter', async () => {
      const { collection, savedAll } = fakeCollection();
      const batching = new BatchingErrorAdapter(
        new ArangoDbErrorAdapter(collection),
        { batchSize: 2, maxWaitMs: Infinity }
      );
      await batching.log({ code: 'A', message: '1' });
      await batching.log({ code: 'B', message: '2' });
      await batching.flush();
      expect(savedAll).toHaveLength(1);
      expect(savedAll[0]?.documents).toHaveLength(2);
    });
  });
});

describe('buildErrorLogIndex', () => {
  it('describes a persistent index on occurred_at', () => {
    expect(buildErrorLogIndex()).toEqual({
      type: 'persistent',
      fields: ['occurred_at'],
      name: 'error_log_occurred_at',
    });
  });
});
