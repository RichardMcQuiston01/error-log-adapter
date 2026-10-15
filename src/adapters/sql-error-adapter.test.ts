import { describe, expect, it, vi } from 'vitest';
import type { ErrorLogEntry } from '../types.js';
import {
  MySqlErrorAdapter,
  PostgresErrorAdapter,
  buildErrorLogTableDdl,
} from './sql-error-adapter.js';
import type { SqlClientLike } from './sql-error-adapter.js';

const ENTRY: ErrorLogEntry = {
  code: 'RULE_EVAL_FAILED',
  message: 'bad rule',
  source: 'rules-engine',
  cause: new Error('x'),
  timestamp: '2026-01-02T03:04:05.678Z',
};

type Query = ReturnType<typeof vi.fn<[string, unknown[]], Promise<unknown>>>;

function fakeClient(): { client: SqlClientLike; query: Query } {
  const query: Query = vi.fn().mockResolvedValue({ rows: [] });
  return { client: { query }, query };
}

function silenceConsole() {
  return vi.spyOn(console, 'error').mockImplementation(() => {});
}

function inserts(query: Query): [string, unknown[]][] {
  return query.mock.calls.filter(([sql]) => sql.startsWith('INSERT'));
}

describe.each([
  {
    name: 'PostgresErrorAdapter',
    create: (client: SqlClientLike, options?: object) =>
      new PostgresErrorAdapter(client, options),
    insertStart:
      'INSERT INTO "error_log" (id, code, message, cause, source, occurred_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING',
    occurredAt: '2026-01-02T03:04:05.678Z',
  },
  {
    name: 'MySqlErrorAdapter',
    create: (client: SqlClientLike, options?: object) =>
      new MySqlErrorAdapter(client, options),
    insertStart:
      'INSERT INTO `error_log` (id, code, message, cause, source, occurred_at) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE id = id',
    occurredAt: '2026-01-02 03:04:05.678',
  },
])('$name', ({ name, create, insertStart, occurredAt }) => {
  it('creates the table once, then inserts a row with the dialect placeholders', async () => {
    const { client, query } = fakeClient();
    const adapter = create(client);

    expect(await adapter.log(ENTRY)).toEqual({ ok: true });
    expect(await adapter.log(ENTRY)).toEqual({ ok: true });

    const created = query.mock.calls.filter(([sql]) =>
      sql.startsWith('CREATE')
    );
    expect(created.length).toBeGreaterThanOrEqual(1);
    expect(created.length).toBeLessThanOrEqual(2);
    const rows = inserts(query);
    expect(rows).toHaveLength(2);
    const [sql, params] = rows[0] ?? ['', []];
    expect(sql).toBe(insertStart);
    expect(params[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(params.slice(1, 3)).toEqual(['RULE_EVAL_FAILED', 'bad rule']);
    expect(JSON.parse(params[3] as string)).toMatchObject({
      name: 'Error',
      message: 'x',
    });
    expect(params.slice(4)).toEqual(['rules-engine', occurredAt]);
  });

  it('stores null for a missing cause and source', async () => {
    const { client, query } = fakeClient();

    await create(client, { createTable: false }).log({
      code: 'X',
      message: 'm',
      timestamp: ENTRY.timestamp,
    });

    expect(query).toHaveBeenCalledTimes(1);
    const params = query.mock.calls[0]?.[1] ?? [];
    expect(params[3]).toBeNull();
    expect(params[4]).toBeNull();
  });

  it('honors tableName and skips table creation when createTable is false', async () => {
    const { client, query } = fakeClient();

    await create(client, { createTable: false, tableName: 'app_error' }).log(
      ENTRY
    );

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toMatch(/INSERT INTO .app_error. /);
  });

  it('returns a failure result naming the table if the insert rejects', async () => {
    const { client, query } = fakeClient();
    query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('INSERT')) {
        throw new Error('connection terminated');
      }
      return {};
    });
    const spy = silenceConsole();

    const result = await create(client, { prefix: '[my-app]' }).log(ENTRY);

    expect(result.ok).toBe(false);
    expect(result.error).toContain(name);
    expect(result.error).toContain('"error_log"');
    expect(result.error).toContain('connection terminated');
    expect(spy).toHaveBeenCalledWith(`[my-app] ${name}:`, expect.any(Error));
    spy.mockRestore();
  });

  it('retries table creation after a failed attempt', async () => {
    const { client, query } = fakeClient();
    let failCreate = true;
    query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('CREATE TABLE') && failCreate) {
        throw new Error('permission denied for schema public');
      }
      return {};
    });
    const spy = silenceConsole();
    const adapter = create(client);

    const first = await adapter.log(ENTRY);
    failCreate = false;
    const second = await adapter.log(ENTRY);

    expect(first.ok).toBe(false);
    expect(first.error).toContain('permission denied');
    expect(second).toEqual({ ok: true });
    spy.mockRestore();
  });

  it('fails without touching the database for an invalid timestamp', async () => {
    const { client, query } = fakeClient();
    const spy = silenceConsole();

    const result = await create(client).log({
      ...ENTRY,
      timestamp: 'yesterday-ish',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('"yesterday-ish" is not a valid ISO 8601');
    expect(query).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('fails without touching the database if the cause cannot be serialized', async () => {
    const { client, query } = fakeClient();
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const spy = silenceConsole();

    const result = await create(client).log({ ...ENTRY, cause: circular });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('circular');
    expect(query).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it.each(['error log', 'x"; DROP TABLE y; --', '1table', '', 'a'.repeat(48)])(
    'rejects the unsafe or too-long table name %j',
    (tableName: string) => {
      const { client } = fakeClient();

      expect(() => create(client, { tableName })).toThrowError(
        new RegExp(`${name}: (invalid table name|table name)`)
      );
    }
  );

  it('accepts a table name of exactly 47 characters', () => {
    const { client } = fakeClient();

    expect(() => create(client, { tableName: 'a'.repeat(47) })).not.toThrow();
  });
});

describe('buildErrorLogTableDdl', () => {
  it('builds Postgres DDL with a native UUID key, JSONB and TIMESTAMPTZ', () => {
    const [createTable, createIndex] = buildErrorLogTableDdl('postgres');

    expect(createTable).toContain('CREATE TABLE IF NOT EXISTS "error_log"');
    expect(createTable).toContain('id UUID PRIMARY KEY');
    expect(createTable).toContain('cause JSONB');
    expect(createTable).toContain('occurred_at TIMESTAMPTZ NOT NULL');
    expect(createTable).toContain(
      'created_at TIMESTAMPTZ NOT NULL DEFAULT now()'
    );
    expect(createIndex).toBe(
      'CREATE INDEX IF NOT EXISTS "error_log_occurred_at_idx" ON "error_log" (occurred_at)'
    );
  });

  it('builds MySQL DDL with a CHAR(36) key and the index inside the table', () => {
    const statements = buildErrorLogTableDdl('mysql');

    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('CREATE TABLE IF NOT EXISTS `error_log`');
    expect(statements[0]).toContain('id CHAR(36) NOT NULL PRIMARY KEY');
    expect(statements[0]).toContain('cause JSON NULL');
    expect(statements[0]).toContain(
      'created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)'
    );
    expect(statements[0]).toContain(
      'INDEX `error_log_occurred_at_idx` (occurred_at)'
    );
  });

  it('validates the table name', () => {
    expect(() => buildErrorLogTableDdl('postgres', 'bad name')).toThrowError(
      /invalid table name/
    );
  });
});
