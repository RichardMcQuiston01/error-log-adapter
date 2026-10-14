import { describe, expect, it, vi } from 'vitest';
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
