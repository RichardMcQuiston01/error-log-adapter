import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import type { ErrorLogEntry } from '../types.js';
import {
  SqliteErrorAdapter,
  buildCreateErrorLogTableSql,
} from './sqlite-error-adapter.js';
import type { SqliteClientLike } from './sqlite-error-adapter.js';

const ENTRY: ErrorLogEntry = {
  code: 'RULE_EVAL_FAILED',
  message: 'bad rule',
  source: 'rules-engine',
  cause: new Error('x'),
  timestamp: '2026-01-02T03:04:05.000Z',
};

describe('SqliteErrorAdapter', () => {
  it('creates the table once, then inserts a row with a UUID id', async () => {
    const run = vi.fn<[string, unknown[]], unknown>();
    const adapter = new SqliteErrorAdapter({ run });

    expect(await adapter.log(ENTRY)).toEqual({ ok: true });
    expect(await adapter.log(ENTRY)).toEqual({ ok: true });

    const statements: string[] = run.mock.calls.map((call) => call[0]);
    expect(statements.filter((sql) => sql.startsWith('CREATE'))).toHaveLength(
      2
    );
    const inserts = run.mock.calls.filter((call) =>
      call[0].startsWith('INSERT INTO error_log')
    );
    expect(inserts).toHaveLength(2);
    const params = inserts[0]?.[1] ?? [];
    expect(params[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(params.slice(1, 3)).toEqual(['RULE_EVAL_FAILED', 'bad rule']);
    expect(JSON.parse(params[3] as string)).toMatchObject({
      name: 'Error',
      message: 'x',
    });
    expect(params.slice(4)).toEqual([
      'rules-engine',
      '2026-01-02T03:04:05.000Z',
    ]);
  });

  it('stores null for a missing cause and source', async () => {
    const run = vi.fn<[string, unknown[]], unknown>();

    await new SqliteErrorAdapter({ run }, { createTable: false }).log({
      code: 'X',
      message: 'm',
    });

    expect(run).toHaveBeenCalledTimes(1);
    const params = run.mock.calls[0]?.[1] ?? [];
    expect(params[3]).toBeNull();
    expect(params[4]).toBeNull();
  });

  it('skips table creation when createTable is false and honors tableName', async () => {
    const run = vi.fn<[string, unknown[]], unknown>();

    await new SqliteErrorAdapter(
      { run },
      { createTable: false, tableName: 'app_error' }
    ).log(ENTRY);

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toContain('INSERT INTO app_error');
  });

  it('supports async clients', async () => {
    const run = vi.fn().mockResolvedValue(undefined);

    const result = await new SqliteErrorAdapter({ run }).log(ENTRY);

    expect(result).toEqual({ ok: true });
  });

  it('returns a failure result if the insert throws', async () => {
    const run: SqliteClientLike['run'] = (sql) => {
      if (sql.startsWith('INSERT')) {
        throw new Error('database is locked');
      }
      return undefined;
    };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await new SqliteErrorAdapter(
      { run },
      { prefix: '[my-app]' }
    ).log(ENTRY);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('database is locked');
    expect(result.error).toContain('"error_log"');
    expect(spy).toHaveBeenCalledWith(
      '[my-app] SqliteErrorAdapter:',
      expect.any(Error)
    );
    spy.mockRestore();
  });

  it('retries table creation after a failed attempt', async () => {
    let failCreate = true;
    const run = vi.fn((sql: string): unknown => {
      if (sql.startsWith('CREATE TABLE') && failCreate) {
        throw new Error('disk I/O error');
      }
      return undefined;
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const adapter = new SqliteErrorAdapter({ run });

    const first = await adapter.log(ENTRY);
    failCreate = false;
    const second = await adapter.log(ENTRY);

    expect(first.ok).toBe(false);
    expect(first.error).toContain('disk I/O error');
    expect(second).toEqual({ ok: true });
    spy.mockRestore();
  });

  it('stores an entry whose cause is circular, marking the loop', async () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const run = vi.fn<[string, unknown[]], unknown>();

    const result = await new SqliteErrorAdapter({ run }).log({
      ...ENTRY,
      cause: circular,
    });

    expect(result).toEqual({ ok: true });
    expect(JSON.stringify(run.mock.calls)).toContain('[Circular]');
  });

  it.each(['error log', 'x; DROP TABLE y', '1table', ''])(
    'rejects the unsafe table name %j',
    (tableName: string) => {
      const run = vi.fn();

      expect(() => new SqliteErrorAdapter({ run }, { tableName })).toThrowError(
        /invalid table name/
      );
    }
  );
});

describe('buildCreateErrorLogTableSql', () => {
  it('builds snake_case DDL with a text UUID key and timestamps', () => {
    const [createTable, createIndex] = buildCreateErrorLogTableSql();

    expect(createTable).toContain('CREATE TABLE IF NOT EXISTS error_log');
    expect(createTable).toContain('id TEXT PRIMARY KEY NOT NULL');
    expect(createTable).toContain('occurred_at TEXT NOT NULL');
    expect(createTable).toContain('created_at TEXT NOT NULL DEFAULT');
    expect(createIndex).toContain('ON error_log (occurred_at)');
  });
});

// Runs the adapter against a real SQLite engine when this Node has node:sqlite.
interface NodeSqliteStatement {
  all(): Record<string, unknown>[];
  run(...params: unknown[]): unknown;
}
interface NodeSqliteDatabase {
  prepare(sql: string): NodeSqliteStatement;
}
function loadNodeSqlite(): {
  DatabaseSync: new (path: string) => NodeSqliteDatabase;
} | null {
  try {
    return createRequire(import.meta.url)('node:sqlite');
  } catch {
    return null;
  }
}
const sqliteModule = loadNodeSqlite();

describe.skipIf(sqliteModule === null)(
  'SqliteErrorAdapter with node:sqlite',
  () => {
    it('persists entries in a real database', async () => {
      const database = new sqliteModule!.DatabaseSync(':memory:');
      const client: SqliteClientLike = {
        run: (sql, params) => database.prepare(sql).run(...params),
      };

      const result = await new SqliteErrorAdapter(client).log(ENTRY);

      expect(result).toEqual({ ok: true });
      const rows = database.prepare('SELECT * FROM error_log').all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        code: 'RULE_EVAL_FAILED',
        message: 'bad rule',
        source: 'rules-engine',
        occurred_at: '2026-01-02T03:04:05.000Z',
      });
      expect(JSON.parse(rows[0]?.['cause'] as string)).toMatchObject({
        name: 'Error',
      });
      expect(rows[0]?.['created_at']).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  }
);
