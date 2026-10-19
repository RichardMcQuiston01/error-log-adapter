import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BatchingErrorAdapter } from '@richardmcquiston01/error-log-adapter';
import type { ErrorLogEntry } from '@richardmcquiston01/error-log-adapter';
import {
  ClickHouseErrorAdapter,
  buildClickHouseTableDdl,
} from './clickhouse-error-adapter.js';
import type {
  ClickHouseClientLike,
  ClickHouseCommandParamsLike,
  ClickHouseInsertParamsLike,
} from './clickhouse-error-adapter.js';

interface Fake {
  client: ClickHouseClientLike;
  commands: string[];
  inserts: ClickHouseInsertParamsLike[];
}

function fakeClient(overrides: Partial<ClickHouseClientLike> = {}): Fake {
  const commands: string[] = [];
  const inserts: ClickHouseInsertParamsLike[] = [];
  const client: ClickHouseClientLike = {
    async command(params: ClickHouseCommandParamsLike): Promise<unknown> {
      commands.push(params.query);
      return {};
    },
    async insert(params: ClickHouseInsertParamsLike): Promise<unknown> {
      inserts.push(params);
      return {};
    },
    ...overrides,
  };
  return { client, commands, inserts };
}

const entry: ErrorLogEntry = {
  code: 'DB_DOWN',
  message: 'cannot reach the database',
  source: 'checkout',
  cause: new Error('ECONNREFUSED'),
  timestamp: '2026-10-19T05:00:00.123Z',
  id: '3f2b8c1e-5a7d-4e21-9c0a-1b2c3d4e5f60',
};

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildClickHouseTableDdl', () => {
  it('builds the default table', () => {
    expect(buildClickHouseTableDdl()).toBe(
      "CREATE TABLE IF NOT EXISTS `error_log` (id UUID, code String, message String, cause Nullable(String), source Nullable(String), occurred_at DateTime64(3, 'UTC'), created_at DateTime64(3, 'UTC') DEFAULT now64(3)) ENGINE = ReplacingMergeTree(created_at) PARTITION BY toYYYYMM(occurred_at) ORDER BY (occurred_at, id)"
    );
  });

  it('adds a database and a TTL', () => {
    const ddl = buildClickHouseTableDdl('app_error', {
      database: 'logs',
      ttlDays: 30,
    });
    expect(ddl).toContain('`logs`.`app_error`');
    expect(ddl).toMatch(
      /ORDER BY \(occurred_at, id\) TTL toDateTime\(occurred_at\) \+ INTERVAL 30 DAY$/
    );
  });

  it('rejects names and TTLs that could alter the statement', () => {
    expect(() => buildClickHouseTableDdl('a; DROP TABLE x')).toThrow(
      RangeError
    );
    expect(() => buildClickHouseTableDdl('ok', { database: 'a.b' })).toThrow(
      RangeError
    );
    expect(() => buildClickHouseTableDdl('ok', { ttlDays: 0 })).toThrow(
      RangeError
    );
    expect(() => buildClickHouseTableDdl('ok', { ttlDays: 1.5 })).toThrow(
      RangeError
    );
  });
});

describe('ClickHouseErrorAdapter', () => {
  it('creates the table once, then inserts the row as JSONEachRow', async () => {
    const { client, commands, inserts } = fakeClient();
    const adapter = new ClickHouseErrorAdapter(client);
    expect(await adapter.log(entry)).toEqual({ ok: true });
    expect(await adapter.log(entry)).toEqual({ ok: true });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain('CREATE TABLE IF NOT EXISTS `error_log`');
    expect(inserts).toHaveLength(2);
    expect(inserts[0]).toEqual({
      table: 'error_log',
      format: 'JSONEachRow',
      clickhouse_settings: { async_insert: 1, wait_for_async_insert: 1 },
      values: [
        {
          id: entry.id,
          code: 'DB_DOWN',
          message: 'cannot reach the database',
          cause: expect.stringContaining('ECONNREFUSED'),
          source: 'checkout',
          occurred_at: '2026-10-19 05:00:00.123',
        },
      ],
    });
  });

  it('stores null for a missing cause and source, and generates an id', async () => {
    const { client, inserts } = fakeClient();
    await new ClickHouseErrorAdapter(client).log({ code: 'X', message: 'y' });
    const [row] = inserts[0]?.values ?? [];
    expect(row?.cause).toBeNull();
    expect(row?.source).toBeNull();
    expect(row?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row?.occurred_at).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}$/);
  });

  it('honors table, database, settings and createTable options', async () => {
    const { client, commands, inserts } = fakeClient();
    await new ClickHouseErrorAdapter(client, {
      tableName: 'app_error',
      database: 'logs',
      ttlDays: 7,
      clickhouseSettings: {},
    }).log(entry);
    expect(commands[0]).toContain('`logs`.`app_error`');
    expect(commands[0]).toContain('INTERVAL 7 DAY');
    expect(inserts[0]?.table).toBe('logs.app_error');
    expect(inserts[0]?.clickhouse_settings).toEqual({});

    const second = fakeClient();
    await new ClickHouseErrorAdapter(second.client, {
      createTable: false,
    }).log(entry);
    expect(second.commands).toHaveLength(0);
    expect(second.inserts).toHaveLength(1);
  });

  it('retries the table creation after it fails', async () => {
    let attempts = 0;
    const { client, inserts } = fakeClient({
      async command(): Promise<unknown> {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('Code: 516. Authentication failed');
        }
        return {};
      },
    });
    const adapter = new ClickHouseErrorAdapter(client);
    const first = await adapter.log(entry);
    expect(first).toEqual({
      ok: false,
      error:
        'ClickHouseErrorAdapter failed to write to table `error_log`: Code: 516. Authentication failed',
    });
    expect(inserts).toHaveLength(0);
    expect(await adapter.log(entry)).toEqual({ ok: true });
    expect(attempts).toBe(2);
  });

  it('reports a failed insert', async () => {
    const { client } = fakeClient({
      async insert(): Promise<unknown> {
        throw new Error('Code: 60. Table error_log does not exist');
      },
    });
    const result = await new ClickHouseErrorAdapter(client, {
      createTable: false,
    }).log(entry);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Table error_log does not exist');
  });

  it('times out a request that never completes', async () => {
    const { client } = fakeClient({
      insert: () => new Promise<unknown>(() => undefined),
    });
    const result = await new ClickHouseErrorAdapter(client, {
      createTable: false,
      timeoutMs: 20,
    }).log(entry);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ClickHouse did not respond within 20 ms');
  });

  it('rejects an invalid id or timestamp without touching the server', async () => {
    const { client, commands, inserts } = fakeClient();
    const adapter = new ClickHouseErrorAdapter(client);
    const badId = await adapter.log({ ...entry, id: 'nope' });
    const badTime = await adapter.log({ ...entry, timestamp: 'yesterday' });
    expect(badId.error).toContain('entry.id must be a UUID');
    expect(badTime.error).toContain('is not a valid ISO 8601 date');
    expect(commands).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it('rejects options that can never work', () => {
    const { client } = fakeClient();
    expect(
      () => new ClickHouseErrorAdapter(client, { tableName: 'x y' })
    ).toThrow(RangeError);
    expect(() => new ClickHouseErrorAdapter(client, { timeoutMs: 0 })).toThrow(
      RangeError
    );
    expect(() => new ClickHouseErrorAdapter(client, { ttlDays: -1 })).toThrow(
      RangeError
    );
  });

  describe('logBatch', () => {
    it('writes every entry in one insert', async () => {
      const { client, inserts } = fakeClient();
      const result = await new ClickHouseErrorAdapter(client).logBatch([
        { code: 'A', message: '1' },
        { code: 'B', message: '2' },
        { code: 'C', message: '3' },
      ]);
      expect(result).toEqual({ ok: true });
      expect(inserts).toHaveLength(1);
      expect(inserts[0]?.values.map((row) => row.code)).toEqual([
        'A',
        'B',
        'C',
      ]);
    });

    it('succeeds on an empty batch without any request', async () => {
      const { client, commands, inserts } = fakeClient();
      expect(await new ClickHouseErrorAdapter(client).logBatch([])).toEqual({
        ok: true,
      });
      expect(commands).toHaveLength(0);
      expect(inserts).toHaveLength(0);
    });

    it('writes nothing when one entry is invalid', async () => {
      const { client, inserts } = fakeClient();
      const result = await new ClickHouseErrorAdapter(client).logBatch([
        { code: 'A', message: '1' },
        { code: 'B', message: '2', id: 'nope' },
      ]);
      expect(result.ok).toBe(false);
      expect(result.error).toContain(
        'entry 1 could not be prepared, so nothing was written'
      );
      expect(result.error).toContain('2 entries');
      expect(inserts).toHaveLength(0);
    });

    it('reports a failed insert for the whole batch', async () => {
      const { client } = fakeClient({
        async insert(): Promise<unknown> {
          throw new Error('Code: 241. Memory limit exceeded');
        },
      });
      const result = await new ClickHouseErrorAdapter(client, {
        createTable: false,
      }).logBatch([{ code: 'A', message: '1' }]);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('to write 1 entry to table');
      expect(result.error).toContain('Memory limit exceeded');
    });

    it('is used by BatchingErrorAdapter', async () => {
      const { client, inserts } = fakeClient();
      const batching = new BatchingErrorAdapter(
        new ClickHouseErrorAdapter(client),
        { batchSize: 2, maxWaitMs: Infinity }
      );
      await batching.log({ code: 'A', message: '1' });
      await batching.log({ code: 'B', message: '2' });
      await batching.flush();
      expect(inserts).toHaveLength(1);
      expect(inserts[0]?.values).toHaveLength(2);
    });
  });
});
