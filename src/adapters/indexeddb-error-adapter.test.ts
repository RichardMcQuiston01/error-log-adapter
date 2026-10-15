import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { ErrorLogEntry } from '../types.js';
import {
  IndexedDbErrorAdapter,
  createErrorLogStore,
} from './indexeddb-error-adapter.js';
import type {
  IdbDatabaseLike,
  IdbTransactionLike,
  IdbUpgradeDatabaseLike,
} from './indexeddb-error-adapter.js';

const ENTRY: ErrorLogEntry = {
  code: 'RULE_EVAL_FAILED',
  message: 'bad rule',
  cause: new Error('x'),
};

type Outcome = 'complete' | 'error' | 'abort';

/** Fake database whose transaction settles with the given outcome. */
function fakeDatabase(outcome: Outcome): {
  database: IdbDatabaseLike;
  add: ReturnType<typeof vi.fn>;
  transaction: Mock<[string, string], IdbTransactionLike>;
} {
  const add = vi.fn();
  const transaction = vi.fn(
    (_name: string, _mode: string): IdbTransactionLike => {
      const tx: IdbTransactionLike = {
        oncomplete: null,
        onerror: null,
        onabort: null,
        error: outcome === 'complete' ? null : { message: 'disk full' },
        objectStore: () => ({
          add: (value: unknown): void => {
            add(value);
            queueMicrotask(() => {
              const handler =
                outcome === 'complete'
                  ? tx.oncomplete
                  : outcome === 'error'
                    ? tx.onerror
                    : tx.onabort;
              handler?.(undefined as never);
            });
          },
        }),
      };
      return tx;
    }
  );
  return { database: { transaction }, add, transaction };
}

describe('IndexedDbErrorAdapter', () => {
  it('adds a serialized record with a UUID id in a readwrite transaction', async () => {
    const { database, add, transaction } = fakeDatabase('complete');

    const result = await new IndexedDbErrorAdapter(database).log(ENTRY);

    expect(result).toEqual({ ok: true });
    expect(transaction).toHaveBeenCalledWith('error_log', 'readwrite');
    const record = add.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(record['id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(record['code']).toBe('RULE_EVAL_FAILED');
    expect(record['cause']).toMatchObject({ name: 'Error', message: 'x' });
    expect(typeof record['timestamp']).toBe('string');
  });

  it('uses a custom store name', async () => {
    const { database, transaction } = fakeDatabase('complete');

    await new IndexedDbErrorAdapter(database, { storeName: 'logs' }).log(ENTRY);

    expect(transaction).toHaveBeenCalledWith('logs', 'readwrite');
  });

  it.each<Outcome>(['error', 'abort'])(
    'returns a failure result when the transaction ends with %s',
    async (outcome: Outcome) => {
      const { database } = fakeDatabase(outcome);
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await new IndexedDbErrorAdapter(database).log(ENTRY);

      expect(result.ok).toBe(false);
      expect(result.error).toContain('disk full');
      expect(result.error).toContain('"error_log"');
      spy.mockRestore();
    }
  );

  it('returns a failure result if opening the transaction throws', async () => {
    const database: IdbDatabaseLike = {
      transaction: () => {
        throw new Error('NotFoundError: no such object store');
      },
    };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await new IndexedDbErrorAdapter(database, {
      prefix: '[my-app]',
    }).log(ENTRY);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('no such object store');
    expect(spy).toHaveBeenCalledWith(
      '[my-app] IndexedDbErrorAdapter:',
      expect.any(Error)
    );
    spy.mockRestore();
  });
});

describe('createErrorLogStore', () => {
  it('creates the store with an id key path and a timestamp index', () => {
    const createIndex = vi.fn();
    const createObjectStore = vi.fn().mockReturnValue({ createIndex });
    const database: IdbUpgradeDatabaseLike = {
      objectStoreNames: { contains: () => false },
      createObjectStore,
    };

    createErrorLogStore(database);

    expect(createObjectStore).toHaveBeenCalledWith('error_log', {
      keyPath: 'id',
    });
    expect(createIndex).toHaveBeenCalledWith('timestamp', 'timestamp');
  });

  it('does nothing if the store already exists', () => {
    const createObjectStore = vi.fn();
    const database: IdbUpgradeDatabaseLike = {
      objectStoreNames: { contains: () => true },
      createObjectStore,
    };

    createErrorLogStore(database);

    expect(createObjectStore).not.toHaveBeenCalled();
  });
});

/** A fake whose pieces the test fires by hand, with spy-able events. */
function manualDatabase(options: { requestless?: boolean } = {}) {
  const request = {
    onerror: null as ((event: never) => unknown) | null,
    error: null as { name?: string; message?: string } | null,
  };
  const tx = {
    oncomplete: null as ((event: never) => unknown) | null,
    onerror: null as ((event: never) => unknown) | null,
    onabort: null as ((event: never) => unknown) | null,
    error: null as { name?: string; message?: string } | null,
    objectStore: () => ({
      add: (): unknown => (options.requestless ? undefined : request),
    }),
  };
  const database: IdbDatabaseLike = { transaction: () => tx };
  const event = () => ({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
  return { database, request, tx, event };
}

describe('IndexedDbErrorAdapter error handling', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reports the request error details and keeps the event from reaching the app', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { database, request, event } = manualDatabase();
    const pending = new IndexedDbErrorAdapter(database).log(ENTRY);
    await Promise.resolve();

    request.error = {
      name: 'ConstraintError',
      message: 'Unable to add key to index',
    };
    const fired = event();
    request.onerror?.(fired as never);
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(result.error).toContain(
      'request failed: ConstraintError: Unable to add key to index'
    );
    expect(fired.preventDefault).toHaveBeenCalled();
    expect(fired.stopPropagation).toHaveBeenCalled();
  });

  it.each([
    ['onerror', 'transaction failed'],
    ['onabort', 'transaction aborted'],
  ] as const)(
    'handles the transaction %s event without letting it propagate',
    async (slot, text) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { database, tx, event } = manualDatabase({ requestless: true });
      const pending = new IndexedDbErrorAdapter(database).log(ENTRY);
      await Promise.resolve();

      tx.error = { name: 'QuotaExceededError', message: 'full' };
      const fired = event();
      tx[slot]?.(fired as never);
      const result = await pending;

      expect(result.error).toContain(`${text}: QuotaExceededError: full`);
      expect(fired.preventDefault).toHaveBeenCalled();
      expect(fired.stopPropagation).toHaveBeenCalled();
    }
  );

  it('says when the browser gave no details', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { database, tx } = manualDatabase({ requestless: true });
    const pending = new IndexedDbErrorAdapter(database).log(ENTRY);
    await Promise.resolve();
    tx.onabort?.(undefined as never);
    expect((await pending).error).toContain(
      'transaction aborted: no details provided'
    );
  });

  it('returns ok: false instead of throwing when add throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const database: IdbDatabaseLike = {
      transaction: () => ({
        oncomplete: null,
        onerror: null,
        onabort: null,
        objectStore: () => ({
          add: (): never => {
            throw new Error('DataError: bad key');
          },
        }),
      }),
    };
    const result = await new IndexedDbErrorAdapter(database).log(ENTRY);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('DataError: bad key');
  });

  it('gives up when the transaction never finishes', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { database } = manualDatabase();

    const pending = new IndexedDbErrorAdapter(database).log(ENTRY);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(result.error).toContain(
      'IndexedDB did not finish the transaction within 10000 ms'
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses a custom timeoutMs and clears the timer when the write completes', async () => {
    vi.useFakeTimers();
    const { database, tx } = manualDatabase();
    const pending = new IndexedDbErrorAdapter(database, {
      timeoutMs: 250,
    }).log(ENTRY);
    await Promise.resolve();
    tx.oncomplete?.(undefined as never);

    expect(await pending).toEqual({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, -1, NaN])('rejects timeoutMs %s', (value: number) => {
    const { database } = manualDatabase();
    expect(
      () => new IndexedDbErrorAdapter(database, { timeoutMs: value })
    ).toThrow(/IndexedDbErrorAdapter: timeoutMs must be a positive number/);
  });
});
