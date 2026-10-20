import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BatchingErrorAdapter } from '@richardmcquiston01/error-log-adapter';
import type { ErrorLogEntry } from '@richardmcquiston01/error-log-adapter';
import { RethinkDbErrorAdapter } from './rethinkdb-error-adapter.js';
import type {
  RethinkDbDocument,
  RethinkDbInsertOptionsLike,
  RethinkDbTableLike,
  RethinkDbWriteResultLike,
} from './rethinkdb-error-adapter.js';

interface Insert {
  documents: RethinkDbDocument | RethinkDbDocument[];
  options: RethinkDbInsertOptionsLike | undefined;
  connection: unknown;
}

interface FakeTable extends RethinkDbTableLike<string> {
  inserts: Insert[];
}

function fakeTable(
  respond: (
    insert: Insert
  ) => Promise<RethinkDbWriteResultLike> = async () => ({
    errors: 0,
    inserted: 1,
  })
): FakeTable {
  const inserts: Insert[] = [];
  return {
    inserts,
    insert(documents, options) {
      return {
        run(connection): Promise<RethinkDbWriteResultLike> {
          const insert: Insert = { documents, options, connection };
          inserts.push(insert);
          return respond(insert);
        },
      };
    },
  };
}

const entry: ErrorLogEntry = {
  id: '3f2b8c1e-5a7d-4e21-9c0a-1b2c3d4e5f60',
  code: 'DB_DOWN',
  message: 'cannot reach the database',
  source: 'checkout',
  cause: new Error('ECONNREFUSED'),
  timestamp: '2026-01-02T03:04:05.678Z',
};

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('RethinkDbErrorAdapter', () => {
  it('inserts one document keyed by the entry id, with real times', async () => {
    const table = fakeTable();
    const adapter = new RethinkDbErrorAdapter(table, 'conn');
    expect(await adapter.log(entry)).toEqual({ ok: true });
    expect(table.inserts).toHaveLength(1);
    const document = table.inserts[0]?.documents as RethinkDbDocument;
    expect(document).toMatchObject({
      id: entry.id,
      code: 'DB_DOWN',
      message: 'cannot reach the database',
      source: 'checkout',
    });
    expect(document.occurred_at).toBeInstanceOf(Date);
    expect(document.occurred_at.toISOString()).toBe('2026-01-02T03:04:05.678Z');
    expect(document.created_at).toBeInstanceOf(Date);
    expect(JSON.stringify(document.cause)).toContain('ECONNREFUSED');
  });

  it('leaves out an absent cause and source', async () => {
    const table = fakeTable();
    const adapter = new RethinkDbErrorAdapter(table);
    await adapter.log({ code: 'X', message: 'plain' });
    const document = table.inserts[0]?.documents as RethinkDbDocument;
    expect('cause' in document).toBe(false);
    expect('source' in document).toBe(false);
  });

  it('runs on the connection it was given, or none', async () => {
    const withConnection = fakeTable();
    await new RethinkDbErrorAdapter(withConnection, 'conn').log(entry);
    expect(withConnection.inserts[0]?.connection).toBe('conn');
    const without = fakeTable();
    await new RethinkDbErrorAdapter(without).log(entry);
    expect(without.inserts[0]?.connection).toBeUndefined();
  });

  it('passes a three-argument conflict function that keeps the existing document', async () => {
    const table = fakeTable();
    await new RethinkDbErrorAdapter(table).log(entry);
    const conflict = table.inserts[0]?.options?.conflict;
    expect(conflict).toBeTypeOf('function');
    // RethinkDB checks the argument count of a conflict function.
    expect(conflict?.length).toBe(3);
    const stored = { id: 'a', message: 'stored' };
    expect(conflict?.('a', stored, { id: 'a', message: 'new' })).toBe(stored);
  });

  it('passes durability when given, and not otherwise', async () => {
    const soft = fakeTable();
    await new RethinkDbErrorAdapter(soft, undefined, {
      durability: 'soft',
    }).log(entry);
    expect(soft.inserts[0]?.options?.durability).toBe('soft');
    const plain = fakeTable();
    await new RethinkDbErrorAdapter(plain).log(entry);
    expect('durability' in (plain.inserts[0]?.options ?? {})).toBe(false);
  });

  it('reports a write result with errors, which RethinkDB returns instead of throwing', async () => {
    const table = fakeTable(async () => ({
      errors: 1,
      first_error: 'Primary key too long:\n  "very long"',
    }));
    const result = await new RethinkDbErrorAdapter(table).log(entry);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('RethinkDB refused 1 of 1 document');
    expect(result.error).toContain('Primary key too long');
    expect(result.error).not.toContain('very long');
  });

  it('reports a rejected request with its reason', async () => {
    const table = fakeTable(async () => {
      throw new Error('Table `logs.error_log` does not exist');
    });
    const result = await new RethinkDbErrorAdapter(table).log(entry);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('does not exist');
    expect(result.error).toContain('to write a document');
  });

  it('uses the short reason from a driver error instead of its long message', async () => {
    const table = fakeTable(async () => {
      throw Object.assign(
        new Error(
          'Table `logs.error_log` does not exist in:\nr.db("logs").table("error_log").insert({ ...the document... })'
        ),
        {
          name: 'ReqlOpFailedError',
          msg: 'Table `logs.error_log` does not exist.',
        }
      );
    });
    const result = await new RethinkDbErrorAdapter(table).log(entry);
    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      'RethinkDbErrorAdapter failed to write a document: RethinkDB error ReqlOpFailedError: Table `logs.error_log` does not exist.'
    );
  });

  it('times out a request that never answers', async () => {
    const table = fakeTable(() => new Promise(() => undefined));
    const adapter = new RethinkDbErrorAdapter(table, undefined, {
      timeoutMs: 20,
    });
    const result = await adapter.log(entry);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/RethinkDB/);
  });

  it('refuses an invalid timestamp without contacting the server', async () => {
    const table = fakeTable();
    const result = await new RethinkDbErrorAdapter(table).log({
      code: 'X',
      message: 'bad time',
      timestamp: 'yesterday',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not a valid ISO 8601 date');
    expect(table.inserts).toEqual([]);
  });

  it.each([
    [{ durability: 'maybe' as 'hard' }, /durability/],
    [{ timeoutMs: -5 }, /timeoutMs/],
  ])('rejects the option %j', (options, message) => {
    expect(
      () => new RethinkDbErrorAdapter(fakeTable(), undefined, options)
    ).toThrow(message);
  });

  describe('logBatch', () => {
    it('writes every entry with one insert', async () => {
      const table = fakeTable();
      const adapter = new RethinkDbErrorAdapter(table);
      const entries: ErrorLogEntry[] = [1, 2, 3].map((n) => ({
        code: 'X',
        message: `entry ${n}`,
      }));
      expect(await adapter.logBatch(entries)).toEqual({ ok: true });
      expect(table.inserts).toHaveLength(1);
      expect(table.inserts[0]?.documents).toHaveLength(3);
    });

    it('does nothing for an empty batch', async () => {
      const table = fakeTable();
      expect(await new RethinkDbErrorAdapter(table).logBatch([])).toEqual({
        ok: true,
      });
      expect(table.inserts).toEqual([]);
    });

    it('checks every entry first and writes nothing if one is invalid', async () => {
      const table = fakeTable();
      const result = await new RethinkDbErrorAdapter(table).logBatch([
        { code: 'X', message: 'fine' },
        { code: 'X', message: 'bad', timestamp: 'nope' },
      ]);
      expect(result.ok).toBe(false);
      expect(result.error).toContain(
        'entry 1 could not be prepared, so nothing was written'
      );
      expect(table.inserts).toEqual([]);
    });

    it('reports how many documents RethinkDB refused', async () => {
      const table = fakeTable(async () => ({
        errors: 2,
        first_error: 'Document is too large',
      }));
      const result = await new RethinkDbErrorAdapter(table).logBatch(
        [1, 2, 3].map((n) => ({ code: 'X', message: `entry ${n}` }))
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain('refused 2 of 3 documents');
      expect(result.error).toContain('Document is too large');
    });

    it('is used by BatchingErrorAdapter', async () => {
      const table = fakeTable();
      const batching = new BatchingErrorAdapter(
        new RethinkDbErrorAdapter(table),
        { batchSize: 2, maxWaitMs: 5 }
      );
      await batching.log({ code: 'X', message: 'one' });
      await batching.log({ code: 'X', message: 'two' });
      expect(await batching.flush()).toEqual({ ok: true });
      expect(table.inserts).toHaveLength(1);
      expect(table.inserts[0]?.documents).toHaveLength(2);
    });
  });
});
