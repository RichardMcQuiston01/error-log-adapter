/**
 * Live test for RethinkDbErrorAdapter against a real RethinkDB server through
 * the real `rethinkdb-ts` driver. It is skipped unless RETHINKDB_TEST_HOST is
 * set, so `bun run test` and CI never touch a server.
 *
 * Start a server and run it:
 *
 *   docker run -d -p 28015:28015 rethinkdb:latest
 *   RETHINKDB_TEST_HOST=127.0.0.1 bun run test:live
 *
 * Optional: RETHINKDB_TEST_PORT (default 28015). The test creates a database
 * named `error_log_live_test_<id>` and drops it when it finishes.
 */
import { r } from 'rethinkdb-ts';
import type { Connection } from 'rethinkdb-ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ErrorLogEntry } from '@richardmcquiston01/error-log-adapter';
import {
  OCCURRED_AT_INDEX,
  RethinkDbErrorAdapter,
} from './rethinkdb-error-adapter.js';

const host: string | undefined = process.env['RETHINKDB_TEST_HOST'];
const isConfigured: boolean = host !== undefined;

const runId: string = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const databaseName = `error_log_live_test_${runId}`;

describe.skipIf(!isConfigured)(
  'RethinkDbErrorAdapter against a real server',
  () => {
    const port = Number(process.env['RETHINKDB_TEST_PORT'] ?? '28015');
    let connection: Connection;
    const db = r.db(databaseName);

    beforeAll(async () => {
      connection = await r.connect({ host: host ?? '127.0.0.1', port });
      await r.dbCreate(databaseName).run(connection);
    });

    afterAll(async () => {
      await r.dbDrop(databaseName).run(connection);
      await connection.close();
    });

    async function newTable(name: string) {
      await db.tableCreate(name).run(connection);
      return db.table(name);
    }

    it('stores an entry as a document keyed by its id, with native times', async () => {
      const table = await newTable('basic');
      const adapter = new RethinkDbErrorAdapter(table, connection);
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

      const stored = (await table.get(id).run(connection)) as Record<
        string,
        unknown
      >;
      expect(stored).toMatchObject({
        id,
        code: 'LIVE_ONE',
        message: 'first live entry',
        source: 'live-test',
      });
      expect(stored['occurred_at']).toBeInstanceOf(Date);
      expect((stored['occurred_at'] as Date).toISOString()).toBe(
        '2026-01-02T03:04:05.678Z'
      );
      expect(stored['created_at']).toBeInstanceOf(Date);
      expect(JSON.stringify(stored['cause'])).toContain('the cause');
      const names = (await db
        .table('basic')
        .typeOf()
        .run(connection)) as string;
      expect(names).toBe('TABLE');
    });

    it('keeps field names exactly as written, including inside the cause', async () => {
      const table = await newTable('names');
      const adapter = new RethinkDbErrorAdapter(table, connection);
      const id = '4a2b8c1e-5a7d-4e21-9c0a-1b2c3d4e5f61';
      await adapter.log({
        id,
        code: 'LIVE_NAMES',
        message: 'names',
        cause: { snake_case_key: 1, camelCaseKey: 2 },
      });
      const stored = (await table.get(id).run(connection)) as {
        cause: Record<string, unknown>;
      } & Record<string, unknown>;
      expect(Object.keys(stored).sort()).toEqual(
        ['cause', 'code', 'created_at', 'id', 'message', 'occurred_at'].sort()
      );
      expect(stored.cause).toMatchObject({
        snake_case_key: 1,
        camelCaseKey: 2,
      });
    });

    it('stores awkward text exactly as given', async () => {
      const table = await newTable('text');
      const adapter = new RethinkDbErrorAdapter(table, connection);
      const id = '5b2b8c1e-5a7d-4e21-9c0a-1b2c3d4e5f62';
      const message =
        'quote " backslash \\ new line \n tab \t é 日本 😀 $reql_type$ {"a":1}';
      await adapter.log({ id, code: 'LIVE_TEXT', message });
      const stored = (await table.get(id).run(connection)) as {
        message: string;
      };
      expect(stored.message).toBe(message);
    });

    it('keeps the stored document when the same entry is logged again', async () => {
      const table = await newTable('repeat');
      const adapter = new RethinkDbErrorAdapter(table, connection);
      const id = '11111111-2222-4333-8444-555555555555';
      expect(
        await adapter.log({ id, code: 'LIVE_REPEAT', message: 'first' })
      ).toEqual({ ok: true });
      expect(
        await adapter.log({ id, code: 'LIVE_REPEAT', message: 'second' })
      ).toEqual({ ok: true });
      expect(await table.count().run(connection)).toBe(1);
      expect(
        ((await table.get(id).run(connection)) as { message: string }).message
      ).toBe('first');
    });

    it('writes a batch with one insert, keeping an id that already exists', async () => {
      const table = await newTable('batch');
      const adapter = new RethinkDbErrorAdapter(table, connection);
      const existing: ErrorLogEntry = {
        id: '22222222-2222-4333-8444-555555555555',
        code: 'LIVE_BATCH',
        message: 'already there',
      };
      await adapter.log(existing);
      const entries: ErrorLogEntry[] = [
        { ...existing, message: 'rewritten?' },
        ...[1, 2, 3].map((n) => ({
          code: 'LIVE_BATCH',
          message: `batch entry ${n}`,
        })),
      ];
      expect(await adapter.logBatch(entries)).toEqual({ ok: true });
      expect(await table.count().run(connection)).toBe(4);
      expect(
        (
          (await table.get(existing.id ?? '').run(connection)) as {
            message: string;
          }
        ).message
      ).toBe('already there');
    });

    it('answers "newest first" through an occurred_at index', async () => {
      const table = await newTable('indexed');
      await table.indexCreate(OCCURRED_AT_INDEX).run(connection);
      await table.indexWait(OCCURRED_AT_INDEX).run(connection);
      const adapter = new RethinkDbErrorAdapter(table, connection);
      for (const hour of ['01', '03', '02']) {
        await adapter.log({
          code: `LIVE_${hour}`,
          message: 'ordering',
          timestamp: `2026-04-05T${hour}:00:00.000Z`,
        });
      }
      const newest = (await table
        .orderBy({ index: r.desc(OCCURRED_AT_INDEX) })
        .limit(2)
        .run(connection)) as { code: string }[];
      expect(newest.map((document) => document.code)).toEqual([
        'LIVE_03',
        'LIVE_02',
      ]);
    });

    it('works with soft durability', async () => {
      const table = await newTable('soft');
      const adapter = new RethinkDbErrorAdapter(table, connection, {
        durability: 'soft',
      });
      expect(await adapter.log({ code: 'LIVE_SOFT', message: 'soft' })).toEqual(
        { ok: true }
      );
      expect(await table.count().run(connection)).toBe(1);
    });

    it('works through the default connection pool, with no connection given', async () => {
      await r.connectPool({
        host: host ?? '127.0.0.1',
        port,
        db: databaseName,
      });
      try {
        const table = await newTable('pool');
        const adapter = new RethinkDbErrorAdapter(r.table('pool'));
        expect(
          await adapter.log({ code: 'LIVE_POOL', message: 'pooled' })
        ).toEqual({ ok: true });
        expect(await table.count().run(connection)).toBe(1);
      } finally {
        await r.getPoolMaster()?.drain();
      }
    });

    it('reports a missing table instead of throwing', async () => {
      const adapter = new RethinkDbErrorAdapter(
        db.table('does_not_exist'),
        connection,
        { timeoutMs: 15_000 }
      );
      const result = await adapter.log({ code: 'LIVE_FAIL', message: 'no' });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('does_not_exist');
      // The driver's own message repeats the whole query; the result keeps the reason.
      expect(result.error).not.toContain('insert(');
      expect(result.error).toContain('does not exist');
    });

    it('reports a closed connection instead of throwing', async () => {
      const table = await newTable('closed');
      const other = await r.connect({ host: host ?? '127.0.0.1', port });
      await other.close();
      const adapter = new RethinkDbErrorAdapter(table, other, {
        timeoutMs: 15_000,
      });
      const result = await adapter.log({ code: 'LIVE_FAIL', message: 'no' });
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    });
  }
);
