import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BatchingErrorAdapter } from '@richardmcquiston01/error-log-adapter';
import type { ErrorLogEntry } from '@richardmcquiston01/error-log-adapter';
import {
  CassandraErrorAdapter,
  bucketFor,
  buildCassandraTableDdl,
} from './cassandra-error-adapter.js';
import type {
  CassandraClientLike,
  CassandraQueryOptionsLike,
  CassandraStatementLike,
} from './cassandra-error-adapter.js';

interface Executed {
  query: string;
  params: unknown[] | undefined;
  options: CassandraQueryOptionsLike | undefined;
}

interface Batched {
  statements: CassandraStatementLike[];
  options: CassandraQueryOptionsLike | undefined;
}

interface Fake {
  client: CassandraClientLike;
  executed: Executed[];
  batched: Batched[];
}

function fakeClient(overrides: Partial<CassandraClientLike> = {}): Fake {
  const executed: Executed[] = [];
  const batched: Batched[] = [];
  const client: CassandraClientLike = {
    async execute(query, params, options): Promise<unknown> {
      executed.push({ query, params, options });
      return {};
    },
    async batch(statements, options): Promise<unknown> {
      batched.push({ statements, options });
      return {};
    },
    ...overrides,
  };
  return { client, executed, batched };
}

const entry: ErrorLogEntry = {
  code: 'DB_DOWN',
  message: 'cannot reach the database',
  source: 'checkout',
  cause: new Error('ECONNREFUSED'),
  timestamp: '2026-10-19T05:30:00.123Z',
  id: '3f2b8c1e-5a7d-4e21-9c0a-1b2c3d4e5f60',
};

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('bucketFor', () => {
  it('formats the partition key in UTC for each size', () => {
    const date = new Date('2026-10-19T05:30:00.123Z');
    expect(bucketFor(date, 'hour')).toBe('2026-10-19T05');
    expect(bucketFor(date, 'day')).toBe('2026-10-19');
    expect(bucketFor(date, 'month')).toBe('2026-10');
  });
});

describe('buildCassandraTableDdl', () => {
  it('builds the default table', () => {
    expect(buildCassandraTableDdl()).toBe(
      'CREATE TABLE IF NOT EXISTS error_log (bucket text, occurred_at timestamp, id uuid, code text, message text, cause text, source text, created_at timestamp, PRIMARY KEY ((bucket), occurred_at, id)) WITH CLUSTERING ORDER BY (occurred_at DESC, id ASC)'
    );
  });

  it('qualifies the table with a keyspace', () => {
    expect(buildCassandraTableDdl('app_error', { keyspace: 'logs' })).toContain(
      'CREATE TABLE IF NOT EXISTS logs.app_error ('
    );
  });

  it('rejects names that could alter the statement', () => {
    expect(() => buildCassandraTableDdl('a; DROP TABLE x')).toThrow(RangeError);
    expect(() => buildCassandraTableDdl('1table')).toThrow(RangeError);
    expect(() => buildCassandraTableDdl('_t')).toThrow(
      'must start with a letter'
    );
    expect(() => buildCassandraTableDdl('ok', { keyspace: 'a.b' })).toThrow(
      RangeError
    );
  });
});

describe('CassandraErrorAdapter', () => {
  it('creates the table once, then inserts with a prepared statement', async () => {
    const { client, executed } = fakeClient();
    const adapter = new CassandraErrorAdapter(client);
    expect(await adapter.log(entry)).toEqual({ ok: true });
    expect(await adapter.log(entry)).toEqual({ ok: true });
    const creates = executed.filter((e) => e.query.startsWith('CREATE TABLE'));
    expect(creates).toHaveLength(1);
    const inserts = executed.filter((e) => e.query.startsWith('INSERT'));
    expect(inserts).toHaveLength(2);
    expect(inserts[0]?.query).toBe(
      'INSERT INTO error_log (bucket, occurred_at, id, code, message, cause, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    expect(inserts[0]?.options).toEqual({ prepare: true });
  });

  it('binds the values the table expects', async () => {
    const { client, executed } = fakeClient();
    await new CassandraErrorAdapter(client, { createTable: false }).log(entry);
    const params = executed[0]?.params as unknown[];
    expect(params[0]).toBe('2026-10-19');
    expect(params[1]).toEqual(new Date('2026-10-19T05:30:00.123Z'));
    expect(params[2]).toBe(entry.id);
    expect(params[3]).toBe('DB_DOWN');
    expect(params[4]).toBe('cannot reach the database');
    expect(JSON.parse(params[5] as string)).toMatchObject({
      message: 'ECONNREFUSED',
    });
    expect(params[6]).toBe('checkout');
    expect(params[7]).toBeInstanceOf(Date);
    expect(params).toHaveLength(8);
  });

  it('leaves a missing cause and source out of the statement', async () => {
    const { client, executed } = fakeClient();
    await new CassandraErrorAdapter(client, { createTable: false }).log({
      code: 'X',
      message: 'y',
    });
    expect(executed[0]?.query).toBe(
      'INSERT INTO error_log (bucket, occurred_at, id, code, message, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    expect(executed[0]?.params).toHaveLength(6);
    expect(executed[0]?.params?.[2]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('honors keyspace, table, bucket, TTL and consistency', async () => {
    const { client, executed } = fakeClient();
    await new CassandraErrorAdapter(client, {
      keyspace: 'logs',
      tableName: 'app_error',
      bucket: 'hour',
      ttlSeconds: 86_400,
      consistency: 6,
      createTable: false,
    }).log(entry);
    expect(executed[0]?.query).toContain('INSERT INTO logs.app_error (');
    expect(executed[0]?.query).toMatch(/VALUES \(\?(, \?)+\) USING TTL 86400$/);
    expect(executed[0]?.params?.[0]).toBe('2026-10-19T05');
    expect(executed[0]?.options).toEqual({ prepare: true, consistency: 6 });
  });

  it('retries the table creation after it fails', async () => {
    let creates = 0;
    const { client, executed } = fakeClient({
      async execute(query, params, options): Promise<unknown> {
        if (query.startsWith('CREATE TABLE')) {
          creates += 1;
          if (creates === 1) {
            throw new Error('Keyspace logs does not exist');
          }
        }
        executed.push({ query, params, options });
        return {};
      },
    });
    const adapter = new CassandraErrorAdapter(client);
    const first = await adapter.log(entry);
    expect(first).toEqual({
      ok: false,
      error:
        'CassandraErrorAdapter failed to write to table error_log: Keyspace logs does not exist',
    });
    expect(await adapter.log(entry)).toEqual({ ok: true });
    expect(creates).toBe(2);
  });

  it('reports a failed insert', async () => {
    const { client } = fakeClient({
      execute: () =>
        Promise.reject(
          new Error(
            'All host(s) tried for query failed. First host tried: ECONNREFUSED'
          )
        ),
    });
    const result = await new CassandraErrorAdapter(client, {
      createTable: false,
    }).log(entry);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('All host(s) tried for query failed');
  });

  it('times out a request that never completes', async () => {
    const { client } = fakeClient({
      execute: () => new Promise<unknown>(() => undefined),
    });
    const result = await new CassandraErrorAdapter(client, {
      createTable: false,
      timeoutMs: 20,
    }).log(entry);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Cassandra did not respond within 20 ms');
  });

  it('rejects an invalid id or timestamp without any request', async () => {
    const { client, executed } = fakeClient();
    const adapter = new CassandraErrorAdapter(client);
    expect((await adapter.log({ ...entry, id: 'nope' })).error).toContain(
      'entry.id must be a UUID'
    );
    expect(
      (await adapter.log({ ...entry, timestamp: 'yesterday' })).error
    ).toContain('is not a valid ISO 8601 date');
    expect(executed).toHaveLength(0);
  });

  it('rejects options that can never work', () => {
    const { client } = fakeClient();
    const bad =
      (options: object): (() => void) =>
      () =>
        new CassandraErrorAdapter(client, options);
    expect(bad({ tableName: 'x y' })).toThrow(RangeError);
    expect(bad({ keyspace: '1ks' })).toThrow(RangeError);
    expect(bad({ bucket: 'week' })).toThrow(
      'bucket must be hour, day or month'
    );
    expect(bad({ ttlSeconds: 0 })).toThrow(RangeError);
    expect(bad({ ttlSeconds: 1.5 })).toThrow(RangeError);
    expect(bad({ maxBatchSize: 0 })).toThrow(RangeError);
    expect(bad({ timeoutMs: 0 })).toThrow(RangeError);
  });

  describe('logBatch', () => {
    const at = (iso: string, code: string): ErrorLogEntry => ({
      code,
      message: code,
      timestamp: iso,
    });

    it('sends rows of one partition as one unlogged batch', async () => {
      const { client, batched, executed } = fakeClient();
      const result = await new CassandraErrorAdapter(client, {
        createTable: false,
      }).logBatch([
        at('2026-10-19T01:00:00.000Z', 'A'),
        at('2026-10-19T02:00:00.000Z', 'B'),
      ]);
      expect(result).toEqual({ ok: true });
      expect(executed).toHaveLength(0);
      expect(batched).toHaveLength(1);
      expect(batched[0]?.options).toEqual({ prepare: true, logged: false });
      expect(batched[0]?.statements).toHaveLength(2);
    });

    it('splits rows of different partitions into separate requests', async () => {
      const { client, batched, executed } = fakeClient();
      await new CassandraErrorAdapter(client, { createTable: false }).logBatch([
        at('2026-10-19T01:00:00.000Z', 'A'),
        at('2026-10-20T01:00:00.000Z', 'B'),
        at('2026-10-20T02:00:00.000Z', 'C'),
      ]);
      expect(executed).toHaveLength(1); // the lone row of 2026-10-19
      expect(batched).toHaveLength(1); // the two rows of 2026-10-20
      expect(batched[0]?.statements).toHaveLength(2);
    });

    it('keeps each batch within maxBatchSize', async () => {
      const { client, batched, executed } = fakeClient();
      const entries = Array.from({ length: 5 }, (_, i) =>
        at('2026-10-19T01:00:00.000Z', `E${i}`)
      );
      await new CassandraErrorAdapter(client, {
        createTable: false,
        maxBatchSize: 2,
      }).logBatch(entries);
      expect(batched.map((b) => b.statements.length)).toEqual([2, 2]);
      expect(executed).toHaveLength(1);
    });

    it('does nothing for an empty batch', async () => {
      const { client, executed, batched } = fakeClient();
      expect(await new CassandraErrorAdapter(client).logBatch([])).toEqual({
        ok: true,
      });
      expect(executed).toHaveLength(0);
      expect(batched).toHaveLength(0);
    });

    it('writes nothing when one entry is invalid', async () => {
      const { client, executed, batched } = fakeClient();
      const result = await new CassandraErrorAdapter(client).logBatch([
        at('2026-10-19T01:00:00.000Z', 'A'),
        { code: 'B', message: 'B', id: 'nope' },
      ]);
      expect(result.ok).toBe(false);
      expect(result.error).toContain(
        'entry 1 could not be prepared, so nothing was written'
      );
      expect(executed).toHaveLength(0);
      expect(batched).toHaveLength(0);
    });

    it('says how many rows were stored when some batches fail', async () => {
      const { client } = fakeClient({
        batch: () => Promise.reject(new Error('Operation timed out')),
      });
      const result = await new CassandraErrorAdapter(client, {
        createTable: false,
      }).logBatch([
        at('2026-10-19T01:00:00.000Z', 'A'), // lone row of its partition: stored
        at('2026-10-20T01:00:00.000Z', 'B'),
        at('2026-10-20T02:00:00.000Z', 'C'), // batch of two: fails
      ]);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Operation timed out');
      expect(result.error).toContain(
        '1 of 3 entries were stored; 1 of 2 batches failed'
      );
    });

    it('is used by BatchingErrorAdapter', async () => {
      const { client, batched } = fakeClient();
      const batching = new BatchingErrorAdapter(
        new CassandraErrorAdapter(client, { createTable: false }),
        { batchSize: 2, maxWaitMs: Infinity }
      );
      await batching.log(at('2026-10-19T01:00:00.000Z', 'A'));
      await batching.log(at('2026-10-19T02:00:00.000Z', 'B'));
      await batching.flush();
      expect(batched).toHaveLength(1);
    });
  });
});
