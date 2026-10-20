/**
 * Live test for CassandraErrorAdapter against a real Cassandra (or ScyllaDB)
 * server. It is skipped unless CASSANDRA_TEST_HOST is set, so `bun run test`
 * and CI never touch a server.
 *
 * Start a server (it takes a minute or two to accept connections) and run it:
 *
 *   docker run -d -p 9042:9042 cassandra:5
 *   CASSANDRA_TEST_HOST=127.0.0.1 bun run test:live
 *
 * Optional: CASSANDRA_TEST_PORT (default 9042) and CASSANDRA_TEST_DC (the local
 * data center, default datacenter1). The test creates a keyspace named
 * `error_log_live_test_<id>` with a single replica and drops it when it
 * finishes.
 */
import { Client, types } from 'cassandra-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ErrorLogEntry } from '@richardmcquiston01/error-log-adapter';
import { CassandraErrorAdapter } from './cassandra-error-adapter.js';

const host: string | undefined = process.env['CASSANDRA_TEST_HOST'];
const isConfigured: boolean = host !== undefined;

const runId: string = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const keyspace = `error_log_live_test_${runId}`;

describe.skipIf(!isConfigured)(
  'CassandraErrorAdapter against a real server',
  () => {
    const port: string = process.env['CASSANDRA_TEST_PORT'] ?? '9042';
    const client: Client = new Client({
      contactPoints: [`${host ?? '127.0.0.1'}:${port}`],
      localDataCenter: process.env['CASSANDRA_TEST_DC'] ?? 'datacenter1',
    });

    beforeAll(async () => {
      await client.connect();
      await client.execute(
        `CREATE KEYSPACE ${keyspace} WITH replication = ` +
          `{'class': 'SimpleStrategy', 'replication_factor': 1}`
      );
    }, 120_000);

    afterAll(async () => {
      await client.execute(`DROP KEYSPACE IF EXISTS ${keyspace}`);
      await client.shutdown();
    }, 60_000);

    it('creates the table and writes an entry as a row', async () => {
      const adapter = new CassandraErrorAdapter(client, {
        keyspace,
        tableName: 'basic',
      });
      const result = await adapter.log({
        code: 'LIVE_ONE',
        message: 'first live entry',
        source: 'live-test',
        cause: new Error('the cause'),
        timestamp: '2026-01-02T03:04:05.678Z',
      });
      expect(result).toEqual({ ok: true });

      const rows = (
        await client.execute(
          `SELECT * FROM ${keyspace}.basic WHERE bucket = '2026-01-02'`
        )
      ).rows;
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row?.['code']).toBe('LIVE_ONE');
      expect(row?.['message']).toBe('first live entry');
      expect(row?.['source']).toBe('live-test');
      expect(String(row?.['cause'])).toContain('the cause');
      expect((row?.['occurred_at'] as Date).toISOString()).toBe(
        '2026-01-02T03:04:05.678Z'
      );
      expect(String(row?.['id'])).toMatch(/^[0-9a-f-]{36}$/);
      expect(row?.['created_at']).toBeInstanceOf(Date);
    });

    it('leaves out an absent cause and source', async () => {
      const adapter = new CassandraErrorAdapter(client, {
        keyspace,
        tableName: 'sparse',
      });
      await adapter.log({
        code: 'LIVE_SPARSE',
        message: 'no extras',
        timestamp: '2026-02-03T00:00:00.000Z',
      });
      const rows = (
        await client.execute(
          `SELECT cause, source FROM ${keyspace}.sparse WHERE bucket = '2026-02-03'`
        )
      ).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.['cause']).toBeNull();
      expect(rows[0]?.['source']).toBeNull();
    });

    it('rewrites the same row when the same id and timestamp are logged again', async () => {
      const adapter = new CassandraErrorAdapter(client, {
        keyspace,
        tableName: 'repeat',
      });
      const entry: ErrorLogEntry = {
        id: '11111111-2222-4333-8444-555555555555',
        code: 'LIVE_REPEAT',
        message: 'logged twice',
        timestamp: '2026-03-04T05:06:07.000Z',
      };
      expect(await adapter.log(entry)).toEqual({ ok: true });
      expect(await adapter.log(entry)).toEqual({ ok: true });
      const rows = (
        await client.execute(
          `SELECT id FROM ${keyspace}.repeat WHERE bucket = '2026-03-04'`
        )
      ).rows;
      expect(rows).toHaveLength(1);
    });

    it('returns the newest entries first within a partition', async () => {
      const adapter = new CassandraErrorAdapter(client, {
        keyspace,
        tableName: 'ordered',
      });
      for (const hour of ['01', '03', '02']) {
        await adapter.log({
          code: `LIVE_${hour}`,
          message: 'ordering',
          timestamp: `2026-04-05T${hour}:00:00.000Z`,
        });
      }
      const rows = (
        await client.execute(
          `SELECT code FROM ${keyspace}.ordered WHERE bucket = '2026-04-05'`
        )
      ).rows;
      expect(rows.map((row) => row['code'])).toEqual([
        'LIVE_03',
        'LIVE_02',
        'LIVE_01',
      ]);
    });

    it('uses the hour bucket when asked', async () => {
      const adapter = new CassandraErrorAdapter(client, {
        keyspace,
        tableName: 'hourly',
        bucket: 'hour',
      });
      await adapter.log({
        code: 'LIVE_HOUR',
        message: 'hourly',
        timestamp: '2026-05-06T07:08:09.000Z',
      });
      const rows = (
        await client.execute(
          `SELECT code FROM ${keyspace}.hourly WHERE bucket = '2026-05-06T07'`
        )
      ).rows;
      expect(rows).toHaveLength(1);
    });

    it('writes a batch that spans partitions and splits by maxBatchSize', async () => {
      const adapter = new CassandraErrorAdapter(client, {
        keyspace,
        tableName: 'batched',
        maxBatchSize: 2,
      });
      const entries: ErrorLogEntry[] = [];
      for (let n = 0; n < 5; n += 1) {
        entries.push({
          code: 'LIVE_BATCH',
          message: `day one entry ${n}`,
          timestamp: `2026-06-07T00:00:0${n}.000Z`,
        });
      }
      for (let n = 0; n < 3; n += 1) {
        entries.push({
          code: 'LIVE_BATCH',
          message: `day two entry ${n}`,
          timestamp: `2026-06-08T00:00:0${n}.000Z`,
        });
      }
      expect(await adapter.logBatch(entries)).toEqual({ ok: true });
      const first = await client.execute(
        `SELECT code FROM ${keyspace}.batched WHERE bucket = '2026-06-07'`
      );
      const second = await client.execute(
        `SELECT code FROM ${keyspace}.batched WHERE bucket = '2026-06-08'`
      );
      expect(first.rows).toHaveLength(5);
      expect(second.rows).toHaveLength(3);
    });

    it('applies ttlSeconds and the consistency level', async () => {
      const adapter = new CassandraErrorAdapter(client, {
        keyspace,
        tableName: 'expiring',
        ttlSeconds: 3600,
        consistency: types.consistencies.one,
      });
      const result = await adapter.log({
        code: 'LIVE_TTL',
        message: 'expires',
        timestamp: '2026-07-08T00:00:00.000Z',
      });
      expect(result).toEqual({ ok: true });
      const rows = (
        await client.execute(
          `SELECT TTL(message) AS ttl FROM ${keyspace}.expiring WHERE bucket = '2026-07-08'`
        )
      ).rows;
      const ttl: number = Number(rows[0]?.['ttl']);
      expect(ttl).toBeGreaterThan(3500);
      expect(ttl).toBeLessThanOrEqual(3600);
    });

    it('reports a missing keyspace instead of throwing', async () => {
      const adapter = new CassandraErrorAdapter(client, {
        keyspace: `${keyspace}_missing`,
        tableName: 'nothing',
        createTable: false,
        timeoutMs: 15_000,
      });
      const result = await adapter.log({ code: 'LIVE_FAIL', message: 'no' });
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    });
  }
);
