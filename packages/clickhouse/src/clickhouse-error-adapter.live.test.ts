/**
 * Live test for ClickHouseErrorAdapter against a real ClickHouse server over
 * HTTP. It is skipped unless CLICKHOUSE_TEST_URL is set, so `bun run test` and
 * CI never touch a server.
 *
 * Start a server and run it:
 *
 *   docker run -d -p 8123:8123 -e CLICKHOUSE_USER=default \
 *     -e CLICKHOUSE_PASSWORD=livetest123 clickhouse/clickhouse-server
 *   CLICKHOUSE_TEST_URL=http://127.0.0.1:8123 CLICKHOUSE_TEST_USER=default \
 *     CLICKHOUSE_TEST_PASSWORD=livetest123 bun run test:live
 *
 * The test creates tables named `error_log_live_test_<id>_*` in the default
 * database and drops them when it finishes.
 */
import { createClient } from '@clickhouse/client';
import type { ClickHouseClient } from '@clickhouse/client';
import { afterAll, describe, expect, it } from 'vitest';
import type { ErrorLogEntry } from '@richardmcquiston01/error-log-adapter';
import { ClickHouseErrorAdapter } from './clickhouse-error-adapter.js';

const url: string | undefined = process.env['CLICKHOUSE_TEST_URL'];
const isConfigured: boolean = url !== undefined;

const runId: string = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const namePrefix = `error_log_live_test_${runId}`;

interface StoredRow {
  id: string;
  code: string;
  message: string;
  cause: string | null;
  source: string | null;
  occurred_at: string;
  created_at: string;
}

describe.skipIf(!isConfigured)(
  'ClickHouseErrorAdapter against a real server',
  () => {
    const username: string = process.env['CLICKHOUSE_TEST_USER'] ?? 'default';
    const password: string = process.env['CLICKHOUSE_TEST_PASSWORD'] ?? '';
    const client: ClickHouseClient = createClient({
      url: url ?? 'http://127.0.0.1:8123',
      username,
      password,
    });
    const tables: string[] = [];

    function newTable(name: string): string {
      const table = `${namePrefix}_${name}`;
      tables.push(table);
      return table;
    }

    async function rows(table: string, final = false): Promise<StoredRow[]> {
      const result = await client.query({
        query: `SELECT * FROM ${table}${final ? ' FINAL' : ''} ORDER BY occurred_at, message`,
        format: 'JSONEachRow',
        clickhouse_settings: { date_time_output_format: 'iso' },
      });
      return (await result.json()) as StoredRow[];
    }

    afterAll(async () => {
      for (const table of tables) {
        await client.command({ query: `DROP TABLE IF EXISTS ${table}` });
      }
      await client.close();
    });

    it('creates the table and stores an entry as a row', async () => {
      const table = newTable('basic');
      const adapter = new ClickHouseErrorAdapter(client, { tableName: table });
      const id = '3f2b8c1e-5a7d-4e21-9c0a-1b2c3d4e5f60';
      const result = await adapter.log({
        id,
        code: 'LIVE_ONE',
        message: 'first live entry',
        source: 'live-test',
        cause: new Error('the cause'),
        timestamp: '2026-01-02T03:04:05.678Z',
      });
      expect(result).toEqual({ ok: true });

      const stored = await rows(table);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        id,
        code: 'LIVE_ONE',
        message: 'first live entry',
        source: 'live-test',
      });
      expect(stored[0]?.cause).toContain('the cause');
      expect(stored[0]?.occurred_at).toContain('2026-01-02T03:04:05.678');
      expect(stored[0]?.created_at).toBeTruthy();
    });

    it('stores null for an absent cause and source', async () => {
      const table = newTable('sparse');
      const adapter = new ClickHouseErrorAdapter(client, { tableName: table });
      await adapter.log({
        code: 'LIVE_SPARSE',
        message: 'no extras',
        timestamp: '2026-02-03T00:00:00.000Z',
      });
      const stored = await rows(table);
      expect(stored).toHaveLength(1);
      expect(stored[0]?.cause).toBeNull();
      expect(stored[0]?.source).toBeNull();
    });

    it('stores awkward text exactly as given', async () => {
      const table = newTable('escaping');
      const adapter = new ClickHouseErrorAdapter(client, { tableName: table });
      const message =
        'quote " backslash \\ single \' comma , tab \t new line \n é 日本 ${x} {y:String}';
      await adapter.log({
        code: 'LIVE_ESCAPE',
        message,
        source: "a'b",
        timestamp: '2026-02-04T00:00:00.000Z',
      });
      const stored = await rows(table);
      expect(stored[0]?.message).toBe(message);
      expect(stored[0]?.source).toBe("a'b");
    });

    it('collapses a repeat with the same id and timestamp once the engine merges', async () => {
      const table = newTable('repeat');
      const adapter = new ClickHouseErrorAdapter(client, { tableName: table });
      const entry: ErrorLogEntry = {
        id: '11111111-2222-4333-8444-555555555555',
        code: 'LIVE_REPEAT',
        message: 'logged twice',
        timestamp: '2026-03-04T05:06:07.000Z',
      };
      expect(await adapter.log(entry)).toEqual({ ok: true });
      expect(await adapter.log(entry)).toEqual({ ok: true });
      expect(await rows(table, true)).toHaveLength(1);
      await client.command({ query: `OPTIMIZE TABLE ${table} FINAL` });
      expect(await rows(table)).toHaveLength(1);
    });

    it('writes a batch in a single insert', async () => {
      const table = newTable('batch');
      const adapter = new ClickHouseErrorAdapter(client, { tableName: table });
      const entries: ErrorLogEntry[] = [1, 2, 3, 4].map((n) => ({
        code: 'LIVE_BATCH',
        message: `batch entry ${n}`,
        timestamp: `2026-05-06T00:00:0${n}.000Z`,
      }));
      expect(await adapter.logBatch(entries)).toEqual({ ok: true });
      expect(await rows(table)).toHaveLength(4);
    });

    it('works with plain synchronous inserts', async () => {
      const table = newTable('sync');
      const adapter = new ClickHouseErrorAdapter(client, {
        tableName: table,
        clickhouseSettings: {},
      });
      expect(
        await adapter.log({ code: 'LIVE_SYNC', message: 'sync insert' })
      ).toEqual({ ok: true });
      expect(await rows(table)).toHaveLength(1);
    });

    it('creates the table with a TTL when ttlDays is given', async () => {
      const table = newTable('ttl');
      const adapter = new ClickHouseErrorAdapter(client, {
        tableName: table,
        ttlDays: 90,
      });
      await adapter.log({ code: 'LIVE_TTL', message: 'expires' });
      const result = await client.query({
        query: `SHOW CREATE TABLE ${table}`,
        format: 'TabSeparatedRaw',
      });
      const ddl: string = await result.text();
      expect(ddl).toContain('TTL');
      expect(ddl).toContain('toIntervalDay(90)');
    });

    it('reports a missing database instead of throwing', async () => {
      const adapter = new ClickHouseErrorAdapter(client, {
        tableName: newTable('nodb'),
        database: `${namePrefix}_no_such_database`,
        timeoutMs: 15_000,
      });
      const result = await adapter.log({ code: 'LIVE_FAIL', message: 'no' });
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it('reports a wrong password instead of throwing', async () => {
      const badClient = createClient({
        url: url ?? 'http://127.0.0.1:8123',
        username,
        password: 'definitely-not-the-password',
      });
      const adapter = new ClickHouseErrorAdapter(badClient, {
        tableName: newTable('badlogin'),
        timeoutMs: 15_000,
      });
      const result = await adapter.log({ code: 'LIVE_FAIL', message: 'no' });
      await badClient.close();
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    });
  }
);
