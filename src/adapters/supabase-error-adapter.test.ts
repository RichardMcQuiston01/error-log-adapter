import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ErrorLogEntry } from '../types.js';
import {
  SupabaseErrorAdapter,
  buildSupabaseSetupSql,
} from './supabase-error-adapter.js';
import type {
  SupabaseClientLike,
  SupabaseErrorLike,
  SupabaseErrorRow,
  SupabaseInsertResult,
} from './supabase-error-adapter.js';

const ENTRY: ErrorLogEntry = {
  code: 'PAYMENT_FAILED',
  message: 'card declined',
  source: 'checkout',
  cause: new Error('insufficient funds'),
  timestamp: '2026-01-02T03:04:05.678Z',
};

const UUID_PATTERN: RegExp =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function silenceConsole() {
  return vi.spyOn(console, 'error').mockImplementation(() => {});
}

function fakeClient(result: SupabaseInsertResult = { error: null }): {
  client: SupabaseClientLike;
  from: ReturnType<typeof vi.fn<[string], unknown>>;
  insert: ReturnType<
    typeof vi.fn<[SupabaseErrorRow], PromiseLike<SupabaseInsertResult>>
  >;
} {
  const insert = vi
    .fn<[SupabaseErrorRow], PromiseLike<SupabaseInsertResult>>()
    .mockResolvedValue(result);
  const from = vi.fn<[string], unknown>().mockReturnValue({ insert });
  return { client: { from } as unknown as SupabaseClientLike, from, insert };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SupabaseErrorAdapter', () => {
  it('inserts one row into the default table and returns ok', async () => {
    const { client, from, insert } = fakeClient();
    const result = await new SupabaseErrorAdapter(client).log(ENTRY);
    expect(result).toEqual({ ok: true });
    expect(from).toHaveBeenCalledWith('error_log');
    expect(insert).toHaveBeenCalledTimes(1);
    const row: SupabaseErrorRow = insert.mock.calls[0][0];
    expect(row.id).toMatch(UUID_PATTERN);
    expect(row).toMatchObject({
      code: 'PAYMENT_FAILED',
      message: 'card declined',
      source: 'checkout',
      occurred_at: '2026-01-02T03:04:05.678Z',
    });
    expect(row.cause).toMatchObject({
      name: 'Error',
      message: 'insufficient funds',
    });
  });

  it('stores null for a missing cause and source', async () => {
    const { client, insert } = fakeClient();
    await new SupabaseErrorAdapter(client).log({
      code: 'X',
      message: 'y',
      timestamp: '2026-01-02T03:04:05.678Z',
    });
    const row: SupabaseErrorRow = insert.mock.calls[0][0];
    expect(row.cause).toBeNull();
    expect(row.source).toBeNull();
  });

  it('adds a timestamp when the entry has none', async () => {
    const { client, insert } = fakeClient();
    await new SupabaseErrorAdapter(client).log({ code: 'X', message: 'y' });
    expect(Number.isNaN(Date.parse(insert.mock.calls[0][0].occurred_at))).toBe(
      false
    );
  });

  it('uses a custom table name and gives each row a new id', async () => {
    const { client, from, insert } = fakeClient();
    const adapter = new SupabaseErrorAdapter(client, {
      tableName: 'app_error',
    });
    await adapter.log(ENTRY);
    await adapter.log(ENTRY);
    expect(from).toHaveBeenCalledWith('app_error');
    expect(insert.mock.calls[0][0].id).not.toBe(insert.mock.calls[1][0].id);
  });

  it('reports the returned error with its code, details and hint', async () => {
    const spy = silenceConsole();
    const { client } = fakeClient({
      error: {
        message: 'new row violates row-level security policy',
        code: '42501',
        details: 'no insert policy',
        hint: 'add a policy',
      },
    });
    const result = await new SupabaseErrorAdapter(client).log(ENTRY);
    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      'SupabaseErrorAdapter failed to insert into table "error_log": new row violates row-level security policy; code 42501; details: no insert policy; hint: add a policy'
    );
    expect(spy).toHaveBeenCalled();
  });

  it('reports a returned error that has only a message', async () => {
    silenceConsole();
    const { client } = fakeClient({
      error: { message: 'TypeError: fetch failed' },
    });
    const result = await new SupabaseErrorAdapter(client).log(ENTRY);
    expect(result.error).toContain('TypeError: fetch failed');
    expect(result.error).not.toContain('code');
  });

  it('uses the HTTP status when the error has no message', async () => {
    silenceConsole();
    const { client, insert } = fakeClient();
    insert.mockResolvedValue({
      error: {} as SupabaseErrorLike,
      status: 404,
      statusText: 'Not Found',
    });
    const result = await new SupabaseErrorAdapter(client).log(ENTRY);
    expect(result.error).toContain('HTTP 404 Not Found with no error message');
    expect(result.error).toContain('table does not exist');
  });

  it('keeps only the first line of the error details', async () => {
    silenceConsole();
    const { client } = fakeClient({
      error: {
        message: 'TypeError: fetch failed',
        details:
          'TypeError: fetch failed\n\nCaused by: Error: bad port\n    at x',
      },
    });
    const result = await new SupabaseErrorAdapter(client).log(ENTRY);
    expect(result.error).toBe(
      'SupabaseErrorAdapter failed to insert into table "error_log": TypeError: fetch failed'
    );
  });

  it('returns ok: false instead of throwing when the client throws', async () => {
    silenceConsole();
    const { client, insert } = fakeClient();
    insert.mockImplementation(() => {
      throw new Error('client is closed');
    });
    const result = await new SupabaseErrorAdapter(client).log(ENTRY);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('client is closed');
  });

  it('returns ok: false when the insert promise rejects', async () => {
    silenceConsole();
    const { client, insert } = fakeClient();
    insert.mockRejectedValue(new Error('network down'));
    const result = await new SupabaseErrorAdapter(client).log(ENTRY);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('network down');
  });

  it('works with a thenable that is not a Promise', async () => {
    const { client, insert } = fakeClient();
    insert.mockReturnValue({
      then: (resolve: (value: { error: null }) => unknown) =>
        Promise.resolve(resolve({ error: null })),
    } as unknown as PromiseLike<{ error: null }>);
    expect(await new SupabaseErrorAdapter(client).log(ENTRY)).toEqual({
      ok: true,
    });
  });

  it('uses the prefix when reporting failures', async () => {
    const spy = silenceConsole();
    const { client } = fakeClient({ error: { message: 'boom' } });
    await new SupabaseErrorAdapter(client, { prefix: '[app]' }).log(ENTRY);
    expect(spy.mock.calls[0][0]).toBe('[app] SupabaseErrorAdapter:');
  });

  it('rejects an empty table name', () => {
    const { client } = fakeClient();
    expect(() => new SupabaseErrorAdapter(client, { tableName: '  ' })).toThrow(
      RangeError
    );
  });
});

describe('buildSupabaseSetupSql', () => {
  it('creates the table and turns on row level security', () => {
    const statements: string[] = buildSupabaseSetupSql();
    expect(statements[0]).toContain('CREATE TABLE IF NOT EXISTS "error_log"');
    expect(statements).toContain(
      'ALTER TABLE "error_log" ENABLE ROW LEVEL SECURITY'
    );
    expect(statements.some((sql: string) => sql.includes('POLICY'))).toBe(
      false
    );
  });

  it('adds an insert-only policy for the given roles', () => {
    const statements: string[] = buildSupabaseSetupSql('app_error', {
      insertRoles: ['anon', 'authenticated'],
    });
    expect(statements).toContain(
      'CREATE POLICY "app_error_insert_only" ON "app_error" FOR INSERT TO "anon", "authenticated" WITH CHECK (true)'
    );
  });

  it('rejects an invalid table or role name', () => {
    expect(() => buildSupabaseSetupSql('bad name')).toThrow(RangeError);
    expect(() =>
      buildSupabaseSetupSql('error_log', { insertRoles: ['anon; DROP'] })
    ).toThrow(RangeError);
  });
});
