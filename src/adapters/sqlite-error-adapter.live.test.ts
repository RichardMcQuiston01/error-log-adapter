/**
 * Live test for SqliteErrorAdapter against the real SQLite engine, through
 * Node's built-in `node:sqlite` (Node 22.5 or newer) and the one-line wrapper
 * from the adapter's documentation. SQLite runs inside the test process, so
 * there is no server to start and nothing to set: the suite runs whenever
 * `node:sqlite` can be loaded and is skipped on older Node versions. Every test
 * uses a private in-memory database.
 */
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import type { ErrorLogEntry } from '../types.js';
import {
  SqliteErrorAdapter,
  buildCreateErrorLogTableSql,
} from './sqlite-error-adapter.js';
import type { SqliteClientLike } from './sqlite-error-adapter.js';

/** The part of `node:sqlite`'s `DatabaseSync` this test uses. */
interface SyncDatabase {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): Record<string, unknown>[];
  };
  exec(sql: string): void;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (path: string) => SyncDatabase;
}

function loadSqlite(): SqliteModule | undefined {
  try {
    // `require` keeps Vite's module loader from rewriting `node:sqlite`, which
    // it does not yet know as a built-in, and fails cleanly on older Node.
    return createRequire(import.meta.url)('node:sqlite') as SqliteModule;
  } catch {
    return undefined;
  }
}

const sqlite: SqliteModule | undefined = loadSqlite();

interface StoredRow {
  id: string;
  code: string;
  message: string;
  cause: string | null;
  source: string | null;
  occurred_at: string;
  created_at: string;
}

describe.skipIf(sqlite === undefined)(
  'SqliteErrorAdapter against the real SQLite engine',
  () => {
    const databases: SyncDatabase[] = [];

    function newDatabase(): { db: SyncDatabase; client: SqliteClientLike } {
      const db = new (sqlite as SqliteModule).DatabaseSync(':memory:');
      databases.push(db);
      // The wrapper from the adapter's documentation.
      const client: SqliteClientLike = {
        run: (sql, params) => db.prepare(sql).run(...params),
      };
      return { db, client };
    }

    function rows(db: SyncDatabase, table = 'error_log'): StoredRow[] {
      return db
        .prepare(`SELECT * FROM ${table} ORDER BY occurred_at`)
        .all() as unknown as StoredRow[];
    }

    afterAll(() => {
      for (const db of databases) {
        db.close();
      }
    });

    it('creates the table and its index on first use', async () => {
      const { db, client } = newDatabase();
      expect(
        await new SqliteErrorAdapter(client).log({ code: 'X', message: 'm' })
      ).toEqual({ ok: true });
      const objects = db
        .prepare(`SELECT type, name FROM sqlite_master ORDER BY name`)
        .all();
      expect(objects).toContainEqual({ type: 'table', name: 'error_log' });
      expect(objects).toContainEqual({
        type: 'index',
        name: 'error_log_occurred_at_idx',
      });
    });

    it('stores an entry as a row with the expected columns', async () => {
      const { db, client } = newDatabase();
      const id = '3f2b8c1e-5a7d-4e21-9c0a-1b2c3d4e5f60';
      const result = await new SqliteErrorAdapter(client).log({
        id,
        code: 'LIVE_ONE',
        message: 'first live entry',
        source: 'live-test',
        cause: new Error('the cause'),
        timestamp: '2026-01-02T03:04:05.678Z',
      });
      expect(result).toEqual({ ok: true });
      const [row] = rows(db);
      expect(row).toMatchObject({
        id,
        code: 'LIVE_ONE',
        message: 'first live entry',
        source: 'live-test',
        occurred_at: '2026-01-02T03:04:05.678Z',
      });
      expect(row?.cause).toContain('the cause');
      expect(() => JSON.parse(row?.cause ?? '')).not.toThrow();
      expect(row?.created_at).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
      );
    });

    it('stores null for an absent cause and source', async () => {
      const { db, client } = newDatabase();
      await new SqliteErrorAdapter(client).log({
        code: 'LIVE_SPARSE',
        message: 'no extras',
      });
      const [row] = rows(db);
      expect(row?.cause).toBeNull();
      expect(row?.source).toBeNull();
    });

    it('stores awkward and long text exactly as given', async () => {
      const { db, client } = newDatabase();
      const message =
        'quote " single \' backslash \\ percent % question ? new line \n é 日本 😀 ; DROP TABLE error_log; --';
      const longCode = 'C'.repeat(5000);
      await new SqliteErrorAdapter(client).log({
        code: longCode,
        message,
        source: 'S'.repeat(5000),
      });
      const [row] = rows(db);
      expect(row?.message).toBe(message);
      expect(row?.code).toBe(longCode);
      expect(row?.source).toBe('S'.repeat(5000));
    });

    it('keeps the stored row when the same entry id is logged again', async () => {
      const { db, client } = newDatabase();
      const adapter = new SqliteErrorAdapter(client);
      const entry: ErrorLogEntry = {
        id: '11111111-2222-4333-8444-555555555555',
        code: 'LIVE_REPEAT',
        message: 'first',
      };
      expect(await adapter.log(entry)).toEqual({ ok: true });
      expect(await adapter.log({ ...entry, message: 'second' })).toEqual({
        ok: true,
      });
      const stored = rows(db);
      expect(stored).toHaveLength(1);
      expect(stored[0]?.message).toBe('first');
    });

    it('uses a custom table name', async () => {
      const { db, client } = newDatabase();
      await new SqliteErrorAdapter(client, { tableName: 'app_errors' }).log({
        code: 'LIVE_NAME',
        message: 'named',
      });
      expect(rows(db, 'app_errors')).toHaveLength(1);
    });

    it('works with a table made from buildCreateErrorLogTableSql and createTable off', async () => {
      const { db, client } = newDatabase();
      for (const statement of buildCreateErrorLogTableSql('own_ddl')) {
        db.exec(statement);
      }
      const adapter = new SqliteErrorAdapter(client, {
        tableName: 'own_ddl',
        createTable: false,
      });
      expect(await adapter.log({ code: 'LIVE_DDL', message: 'own' })).toEqual({
        ok: true,
      });
      expect(rows(db, 'own_ddl')).toHaveLength(1);
    });

    it('creates the table once when several entries are logged at the same time', async () => {
      const { db, client } = newDatabase();
      const adapter = new SqliteErrorAdapter(client);
      const results = await Promise.all(
        [1, 2, 3, 4, 5].map((n) =>
          adapter.log({ code: 'LIVE_PAR', message: `entry ${n}` })
        )
      );
      expect(results.every((result) => result.ok)).toBe(true);
      expect(rows(db)).toHaveLength(5);
    });

    it('reports a missing table instead of throwing', async () => {
      const { client } = newDatabase();
      const adapter = new SqliteErrorAdapter(client, { createTable: false });
      const result = await adapter.log({ code: 'LIVE_FAIL', message: 'no' });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('no such table');
    });

    it('reports a closed database instead of throwing', async () => {
      const { db, client } = newDatabase();
      db.close();
      const result = await new SqliteErrorAdapter(client).log({
        code: 'LIVE_FAIL',
        message: 'no',
      });
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
      databases.splice(databases.indexOf(db), 1);
    });
  }
);
