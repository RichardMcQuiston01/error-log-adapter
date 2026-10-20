/**
 * Live test for InfluxDbErrorAdapter against a real InfluxDB 2.x server. It is
 * skipped unless INFLUXDB_TEST_URL is set, so `bun run test` and CI never touch
 * a server.
 *
 * Start a server and run it:
 *
 *   docker run -d -p 8086:8086 \
 *     -e DOCKER_INFLUXDB_INIT_MODE=setup -e DOCKER_INFLUXDB_INIT_USERNAME=admin \
 *     -e DOCKER_INFLUXDB_INIT_PASSWORD=livetest123 -e DOCKER_INFLUXDB_INIT_ORG=live \
 *     -e DOCKER_INFLUXDB_INIT_BUCKET=errors \
 *     -e DOCKER_INFLUXDB_INIT_ADMIN_TOKEN=livetoken123 influxdb:2
 *   INFLUXDB_TEST_URL=http://127.0.0.1:8086 INFLUXDB_TEST_TOKEN=livetoken123 \
 *     INFLUXDB_TEST_ORG=live INFLUXDB_TEST_BUCKET=errors bun run test:live
 *
 * The test writes points to measurements named `error_log_live_test_<id>_*` and
 * deletes them when it finishes.
 *
 * InfluxDb3ErrorAdapter has its own block, skipped unless INFLUXDB3_TEST_URL is
 * set. It needs an InfluxDB 3 Core server without authentication:
 *
 *   docker run -d -p 8181:8181 influxdb:3-core influxdb3 serve --node-id live \
 *     --object-store file --data-dir /var/lib/influxdb3 --without-auth
 *   INFLUXDB3_TEST_URL=http://127.0.0.1:8181 bun run test:live
 *
 * It writes to a database named `error_log_live_test_<id>`, which InfluxDB 3
 * creates on the first write; the test leaves it in place (a Core server has no
 * way to delete a database without a token).
 */
import { InfluxDB } from '@influxdata/influxdb-client';
import type { QueryApi } from '@influxdata/influxdb-client';
import { afterAll, describe, expect, it } from 'vitest';
import type { ErrorLogEntry } from '@richardmcquiston01/error-log-adapter';
import { InfluxDBClient } from '@influxdata/influxdb3-client';
import {
  InfluxDb3ErrorAdapter,
  InfluxDbErrorAdapter,
} from './influxdb-error-adapter.js';

const url: string | undefined = process.env['INFLUXDB_TEST_URL'];
const isConfigured: boolean = url !== undefined;

const runId: string = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const measurementPrefix = `error_log_live_test_${runId}`;

interface PointRow {
  _time: string;
  code?: string;
  source?: string;
  id?: string;
  message?: string;
  cause?: string;
}

describe.skipIf(!isConfigured)(
  'InfluxDbErrorAdapter against a real InfluxDB 2.x server',
  () => {
    const token: string = process.env['INFLUXDB_TEST_TOKEN'] ?? '';
    const org: string = process.env['INFLUXDB_TEST_ORG'] ?? '';
    const bucket: string = process.env['INFLUXDB_TEST_BUCKET'] ?? '';
    const influx: InfluxDB = new InfluxDB({
      url: url ?? 'http://127.0.0.1:8086',
      token,
    });
    const queryApi: QueryApi = influx.getQueryApi(org);
    const measurements: string[] = [];

    function newAdapter(name: string): InfluxDbErrorAdapter {
      const measurement = `${measurementPrefix}_${name}`;
      measurements.push(measurement);
      const writeApi = influx.getWriteApi(org, bucket, 'ns', {
        maxRetries: 0,
      });
      return new InfluxDbErrorAdapter(writeApi, { measurement });
    }

    async function readPoints(name: string): Promise<PointRow[]> {
      const flux =
        `from(bucket: "${bucket}") |> range(start: 2020-01-01T00:00:00Z, stop: 2031-01-01T00:00:00Z) ` +
        `|> filter(fn: (r) => r._measurement == "${measurementPrefix}_${name}") ` +
        `|> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")`;
      return queryApi.collectRows<PointRow>(flux);
    }

    afterAll(async () => {
      for (const measurement of measurements) {
        await fetch(
          `${url}/api/v2/delete?org=${encodeURIComponent(org)}&bucket=${encodeURIComponent(bucket)}`,
          {
            method: 'POST',
            headers: {
              Authorization: `Token ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              start: '2020-01-01T00:00:00Z',
              stop: '2031-01-01T00:00:00Z',
              predicate: `_measurement="${measurement}"`,
            }),
          }
        );
      }
    });

    it('writes an entry as a point with tags and fields', async () => {
      const adapter = newAdapter('basic');
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

      const rows = await readPoints('basic');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        code: 'LIVE_ONE',
        source: 'live-test',
        id,
        message: 'first live entry',
      });
      expect(rows[0]?.cause).toContain('the cause');
      expect(rows[0]?._time.startsWith('2026-01-02T03:04:05.678')).toBe(true);
    });

    it('stores awkward text exactly as given', async () => {
      const adapter = newAdapter('escaping');
      const message =
        'quote " backslash \\ comma , equals = space \n new line é 日本';
      const result = await adapter.log({
        code: 'LIVE_ESCAPE',
        message,
        source: 'a b,c=d',
        timestamp: '2026-02-03T00:00:00.000Z',
      });
      expect(result).toEqual({ ok: true });
      const rows = await readPoints('escaping');
      expect(rows).toHaveLength(1);
      // Flux's CSV answer writes a line break inside a value as CRLF; the stored
      // value is unchanged (a Flux strlen() of it equals the length sent).
      expect(rows[0]?.message?.replace(/\r\n/g, '\n')).toBe(message);
      expect(rows[0]?.source).toBe('a b,c=d');
    });

    it('overwrites instead of duplicating when the same entry is logged again', async () => {
      const adapter = newAdapter('repeat');
      const entry: ErrorLogEntry = {
        id: '11111111-2222-4333-8444-555555555555',
        code: 'LIVE_REPEAT',
        message: 'logged twice',
        timestamp: '2026-03-04T05:06:07.000Z',
      };
      expect(await adapter.log(entry)).toEqual({ ok: true });
      expect(await adapter.log(entry)).toEqual({ ok: true });
      expect(await readPoints('repeat')).toHaveLength(1);
    });

    it('keeps two errors with the same tags and millisecond as separate points', async () => {
      const adapter = newAdapter('samems');
      const timestamp = '2026-04-05T06:07:08.009Z';
      await adapter.log({ code: 'LIVE_SAME', message: 'one', timestamp });
      await adapter.log({ code: 'LIVE_SAME', message: 'two', timestamp });
      const rows = await readPoints('samems');
      expect(rows.map((row) => row.message).sort()).toEqual(['one', 'two']);
    });

    it('writes a batch in one request', async () => {
      const adapter = newAdapter('batch');
      const entries: ErrorLogEntry[] = [1, 2, 3, 4].map((n) => ({
        code: 'LIVE_BATCH',
        message: `batch entry ${n}`,
        timestamp: `2026-05-06T00:00:0${n}.000Z`,
      }));
      expect(await adapter.logBatch(entries)).toEqual({ ok: true });
      expect(await readPoints('batch')).toHaveLength(4);
    });

    it('reports a rejected token instead of throwing', async () => {
      const badWriteApi = new InfluxDB({
        url: url ?? 'http://127.0.0.1:8086',
        token: 'definitely-not-the-token',
      }).getWriteApi(org, bucket, 'ns', { maxRetries: 0 });
      const adapter = new InfluxDbErrorAdapter(badWriteApi, {
        measurement: `${measurementPrefix}_badtoken`,
        timeoutMs: 15_000,
      });
      const result = await adapter.log({ code: 'LIVE_FAIL', message: 'no' });
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it('reports a missing bucket instead of throwing', async () => {
      const writeApi = influx.getWriteApi(
        org,
        `${bucket}-does-not-exist`,
        'ns',
        {
          maxRetries: 0,
        }
      );
      const adapter = new InfluxDbErrorAdapter(writeApi, {
        measurement: `${measurementPrefix}_nobucket`,
        timeoutMs: 15_000,
      });
      const result = await adapter.log({ code: 'LIVE_FAIL', message: 'no' });
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    });
  }
);

const url3: string | undefined = process.env['INFLUXDB3_TEST_URL'];

describe.skipIf(url3 === undefined)(
  'InfluxDb3ErrorAdapter against a real InfluxDB 3 server',
  () => {
    const host: string = url3 ?? 'http://127.0.0.1:8181';
    const database = `error_log_live_test_${runId}`;
    const client: InfluxDBClient = new InfluxDBClient({
      host,
      token: 'not-checked-without-auth',
      database,
    });

    async function query(sql: string): Promise<Record<string, unknown>[]> {
      const response = await fetch(
        `${host}/api/v3/query_sql?db=${database}&format=json&q=${encodeURIComponent(sql)}`
      );
      return (await response.json()) as Record<string, unknown>[];
    }

    function newAdapter(name: string): InfluxDb3ErrorAdapter {
      return new InfluxDb3ErrorAdapter(client, {
        measurement: `${measurementPrefix}_${name}`,
      });
    }

    it('writes an entry as a point with tags and fields', async () => {
      const id = '3f2b8c1e-5a7d-4e21-9c0a-1b2c3d4e5f60';
      const result = await newAdapter('basic').log({
        id,
        code: 'LIVE_ONE',
        message: 'first live entry',
        source: 'live-test',
        cause: new Error('the cause'),
        timestamp: '2026-01-02T03:04:05.678Z',
      });
      expect(result).toEqual({ ok: true });
      const rows = await query(`SELECT * FROM "${measurementPrefix}_basic"`);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        code: 'LIVE_ONE',
        source: 'live-test',
        id,
        message: 'first live entry',
      });
      expect(String(rows[0]?.['cause'])).toContain('the cause');
      expect(String(rows[0]?.['time'])).toContain('2026-01-02T03:04:05.678');
    });

    it('stores awkward text exactly as given', async () => {
      const message =
        'quote " backslash \\ comma , equals = space \n new line é 日本';
      const result = await newAdapter('escaping').log({
        code: 'LIVE_ESCAPE',
        message,
        source: 'a b,c=d',
        timestamp: '2026-02-03T00:00:00.000Z',
      });
      expect(result).toEqual({ ok: true });
      const rows = await query(`SELECT * FROM "${measurementPrefix}_escaping"`);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.['message']).toBe(message);
      expect(rows[0]?.['source']).toBe('a b,c=d');
    });

    it('overwrites instead of duplicating when the same entry is logged again', async () => {
      const entry: ErrorLogEntry = {
        id: '11111111-2222-4333-8444-555555555555',
        code: 'LIVE_REPEAT',
        message: 'logged twice',
        timestamp: '2026-03-04T05:06:07.000Z',
      };
      const adapter = newAdapter('repeat');
      expect(await adapter.log(entry)).toEqual({ ok: true });
      expect(await adapter.log(entry)).toEqual({ ok: true });
      expect(
        await query(`SELECT * FROM "${measurementPrefix}_repeat"`)
      ).toHaveLength(1);
    });

    it('keeps two errors with the same tags and millisecond as separate points', async () => {
      const adapter = newAdapter('samems');
      const timestamp = '2026-04-05T06:07:08.009Z';
      await adapter.log({ code: 'LIVE_SAME', message: 'one', timestamp });
      await adapter.log({ code: 'LIVE_SAME', message: 'two', timestamp });
      const rows = await query(`SELECT * FROM "${measurementPrefix}_samems"`);
      expect(rows.map((row) => row['message']).sort()).toEqual(['one', 'two']);
    });

    it('writes a batch in one request', async () => {
      const entries: ErrorLogEntry[] = [1, 2, 3, 4].map((n) => ({
        code: 'LIVE_BATCH',
        message: `batch entry ${n}`,
        timestamp: `2026-05-06T00:00:0${n}.000Z`,
      }));
      expect(await newAdapter('batch').logBatch(entries)).toEqual({ ok: true });
      expect(
        await query(`SELECT * FROM "${measurementPrefix}_batch"`)
      ).toHaveLength(4);
    });

    it('reports an unreachable server instead of throwing', async () => {
      const deadClient = new InfluxDBClient({
        host: 'http://127.0.0.1:1',
        token: 'x',
        database,
      });
      const adapter = new InfluxDb3ErrorAdapter(deadClient, {
        measurement: `${measurementPrefix}_dead`,
        timeoutMs: 15_000,
      });
      const result = await adapter.log({ code: 'LIVE_FAIL', message: 'no' });
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    });
  }
);
