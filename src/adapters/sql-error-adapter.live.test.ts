/**
 * Live test for MySqlErrorAdapter and PostgresErrorAdapter against real
 * servers. Each block is skipped unless its URL variable is set, so
 * `bun run test` and CI never touch a database.
 *
 * MySQL, MariaDB or Percona Server (any server `mysql2` can talk to):
 *
 *   docker run -d -p 3306:3306 -e MARIADB_ROOT_PASSWORD=livetest123 \
 *     -e MARIADB_DATABASE=live mariadb:11
 *   MYSQL_TEST_URL=mysql://root:livetest123@127.0.0.1:3306/live bun run test:live
 *
 * Postgres or CockroachDB (anything `pg` can talk to):
 *
 *   docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=livetest123 postgres:16
 *   POSTGRES_TEST_URL=postgres://postgres:livetest123@127.0.0.1:5432/postgres \
 *     bun run test:live
 *
 * CockroachDB started with `--insecure` accepts any password, so set
 * POSTGRES_TEST_INSECURE=1 to skip the wrong-login test there.
 *
 * Each test creates a table named `el_live_<id>_*` and drops it
 * when it finishes.
 */
import mysql from 'mysql2/promise';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import type { ErrorLogEntry } from '../types.js';
import {
  MySqlErrorAdapter,
  PostgresErrorAdapter,
  buildErrorLogTableDdl,
} from './sql-error-adapter.js';
import type { SqlClientLike, SqlDialect } from './sql-error-adapter.js';

const mysqlUrl: string | undefined = process.env['MYSQL_TEST_URL'];
const postgresUrl: string | undefined = process.env['POSTGRES_TEST_URL'];

const runId: string = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const namePrefix = `el_live_${runId}`;

interface StoredRow {
  id: string;
  code: string;
  message: string;
  cause: unknown;
  source: string | null;
  occurred_at: string;
  has_created_at: boolean | number;
}

/** What the two blocks differ on; the tests themselves are shared. */
interface Backend {
  dialect: SqlDialect;
  client: SqlClientLike;
  makeAdapter(
    client: SqlClientLike,
    options: { tableName: string; createTable?: boolean; timeoutMs?: number }
  ): MySqlErrorAdapter | PostgresErrorAdapter;
  /** SELECT that returns the `StoredRow` columns, `occurred_at` as UTC `YYYY-MM-DDTHH:MM:SS.mmm`. */
  selectAll(table: string): Promise<StoredRow[]>;
  count(table: string): Promise<number>;
  run(sql: string): Promise<void>;
  /** A client whose login is wrong. */
  badClient(): SqlClientLike;
  /** False when the server accepts any password. */
  checksLogin: boolean;
  /** A client pointing at a port nothing listens on. */
  deadClient(): SqlClientLike;
  close(): Promise<void>;
}

function defineTests(label: string, backend: () => Backend): void {
  describe(label, () => {
    const tables: string[] = [];
    const be: Backend = backend();

    function newTable(name: string): string {
      const table = `${namePrefix}_${name}`;
      tables.push(table);
      return table;
    }

    afterAll(async () => {
      for (const table of tables) {
        await be.run(`DROP TABLE IF EXISTS ${table}`);
      }
      await be.close();
    });

    it('creates the table and stores an entry as a row', async () => {
      const table = newTable('basic');
      const adapter = be.makeAdapter(be.client, { tableName: table });
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

      const rows = await be.selectAll(table);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id,
        code: 'LIVE_ONE',
        message: 'first live entry',
        source: 'live-test',
        occurred_at: '2026-01-02T03:04:05.678',
      });
      expect(Boolean(rows[0]?.has_created_at)).toBe(true);
      const cause: unknown =
        typeof rows[0]?.cause === 'string'
          ? JSON.parse(rows[0].cause)
          : rows[0]?.cause;
      expect(JSON.stringify(cause)).toContain('the cause');
    });

    it('stores null for an absent cause and source', async () => {
      const table = newTable('sparse');
      const adapter = be.makeAdapter(be.client, { tableName: table });
      await adapter.log({
        code: 'LIVE_SPARSE',
        message: 'no extras',
        timestamp: '2026-02-03T00:00:00.000Z',
      });
      const rows = await be.selectAll(table);
      expect(rows[0]?.cause).toBeNull();
      expect(rows[0]?.source).toBeNull();
    });

    it('stores awkward text and long values exactly as given', async () => {
      const table = newTable('text');
      const adapter = be.makeAdapter(be.client, { tableName: table });
      const message =
        'quote " single \' backslash \\ percent % question ? dollar $1 new line \n é 日本 😀';
      const longCode = 'C'.repeat(600);
      const longSource = 'S'.repeat(600);
      const result = await adapter.log({
        code: longCode,
        message,
        source: longSource,
        timestamp: '2026-02-04T00:00:00.000Z',
      });
      expect(result).toEqual({ ok: true });
      const rows = await be.selectAll(table);
      expect(rows[0]?.message).toBe(message);
      expect(rows[0]?.code).toBe(longCode);
      expect(rows[0]?.source).toBe(longSource);
    });

    it('keeps the stored row when the same entry id is logged again', async () => {
      const table = newTable('repeat');
      const adapter = be.makeAdapter(be.client, { tableName: table });
      const entry: ErrorLogEntry = {
        id: '11111111-2222-4333-8444-555555555555',
        code: 'LIVE_REPEAT',
        message: 'first',
      };
      expect(await adapter.log(entry)).toEqual({ ok: true });
      expect(await adapter.log({ ...entry, message: 'second' })).toEqual({
        ok: true,
      });
      expect(await be.count(table)).toBe(1);
      expect((await be.selectAll(table))[0]?.message).toBe('first');
    });

    it('works with a table made from buildErrorLogTableDdl and createTable off', async () => {
      const table = newTable('ddl');
      for (const statement of buildErrorLogTableDdl(be.dialect, table)) {
        await be.run(statement);
      }
      const adapter = be.makeAdapter(be.client, {
        tableName: table,
        createTable: false,
      });
      expect(
        await adapter.log({ code: 'LIVE_DDL', message: 'own ddl' })
      ).toEqual({ ok: true });
      expect(await be.count(table)).toBe(1);
    });

    it('creates the table once when several entries are logged at the same time', async () => {
      const table = newTable('concurrent');
      const adapter = be.makeAdapter(be.client, { tableName: table });
      const results = await Promise.all(
        [1, 2, 3, 4, 5].map((n) =>
          adapter.log({ code: 'LIVE_PAR', message: `entry ${n}` })
        )
      );
      expect(results.every((result) => result.ok)).toBe(true);
      expect(await be.count(table)).toBe(5);
    });

    it('reports a missing table instead of throwing', async () => {
      const adapter = be.makeAdapter(be.client, {
        tableName: newTable('missing'),
        createTable: false,
        timeoutMs: 15_000,
      });
      const result = await adapter.log({ code: 'LIVE_FAIL', message: 'no' });
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it.skipIf(!be.checksLogin)(
      'reports a wrong login instead of throwing',
      async () => {
        const adapter = be.makeAdapter(be.badClient(), {
          tableName: newTable('badlogin'),
          timeoutMs: 15_000,
        });
        const result = await adapter.log({ code: 'LIVE_FAIL', message: 'no' });
        expect(result.ok).toBe(false);
        expect(result.error).toBeTruthy();
      }
    );

    it('reports an unreachable server instead of throwing', async () => {
      const dead = be.deadClient();
      const adapter = be.makeAdapter(dead, {
        tableName: newTable('dead'),
        timeoutMs: 15_000,
      });
      const result = await adapter.log({ code: 'LIVE_FAIL', message: 'no' });
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    });
  });
}

function mysqlBackend(): Backend {
  const url: string = mysqlUrl ?? 'mysql://root@127.0.0.1:3306/live';
  const pool = mysql.createPool({ uri: url, timezone: 'Z' });
  const bad = new URL(url);
  bad.password = 'definitely-not-the-password';
  const badPool = mysql.createPool({ uri: bad.toString(), timezone: 'Z' });
  const dead = new URL(url);
  dead.port = '1';
  const deadPool = mysql.createPool({ uri: dead.toString(), timezone: 'Z' });
  return {
    dialect: 'mysql',
    client: pool as unknown as SqlClientLike,
    makeAdapter: (client, options) => new MySqlErrorAdapter(client, options),
    async selectAll(table) {
      const [rows] = await pool.query(
        `SELECT id, code, message, cause, source, ` +
          `DATE_FORMAT(occurred_at, '%Y-%m-%dT%H:%i:%s.%f') AS occurred_at, ` +
          `created_at IS NOT NULL AS has_created_at FROM ${table} ORDER BY occurred_at`
      );
      return (rows as StoredRow[]).map((row) => ({
        ...row,
        occurred_at: String(row.occurred_at).slice(0, 23),
      }));
    },
    async count(table) {
      const [rows] = await pool.query(`SELECT COUNT(*) AS total FROM ${table}`);
      return Number((rows as { total: number | string }[])[0]?.total);
    },
    async run(sql) {
      await pool.query(sql);
    },
    badClient: () => badPool as unknown as SqlClientLike,
    checksLogin: true,
    deadClient: () => deadPool as unknown as SqlClientLike,
    async close() {
      await badPool.end();
      await deadPool.end();
      await pool.end();
    },
  };
}

function postgresBackend(): Backend {
  const url: string =
    postgresUrl ?? 'postgres://postgres@127.0.0.1:5432/postgres';
  const pool = new Pool({ connectionString: url });
  const bad = new URL(url);
  bad.password = 'definitely-not-the-password';
  const badPool = new Pool({ connectionString: bad.toString() });
  const dead = new URL(url);
  dead.port = '1';
  const deadPool = new Pool({ connectionString: dead.toString() });
  return {
    dialect: 'postgres',
    client: pool as unknown as SqlClientLike,
    makeAdapter: (client, options) => new PostgresErrorAdapter(client, options),
    async selectAll(table) {
      const result = await pool.query(
        `SELECT id::text AS id, code, message, cause, source, ` +
          `to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS occurred_at, ` +
          `created_at IS NOT NULL AS has_created_at FROM ${table} ORDER BY occurred_at`
      );
      return result.rows as StoredRow[];
    },
    async count(table) {
      const result = await pool.query(`SELECT COUNT(*) AS total FROM ${table}`);
      return Number((result.rows as { total: string }[])[0]?.total);
    },
    async run(sql) {
      await pool.query(sql);
    },
    badClient: () => badPool as unknown as SqlClientLike,
    checksLogin: process.env['POSTGRES_TEST_INSECURE'] !== '1',
    deadClient: () => deadPool as unknown as SqlClientLike,
    async close() {
      await badPool.end();
      await deadPool.end();
      await pool.end();
    },
  };
}

if (mysqlUrl !== undefined) {
  defineTests(
    'MySqlErrorAdapter against a real MySQL-family server',
    mysqlBackend
  );
} else {
  describe.skip('MySqlErrorAdapter against a real MySQL-family server', () => {
    it('needs MYSQL_TEST_URL', () => undefined);
  });
}

if (postgresUrl !== undefined) {
  defineTests(
    'PostgresErrorAdapter against a real Postgres-family server',
    postgresBackend
  );
} else {
  describe.skip('PostgresErrorAdapter against a real Postgres-family server', () => {
    it('needs POSTGRES_TEST_URL', () => undefined);
  });
}
