import { hasCallerId, resolveEntryId } from '../entry-id.js';
import { describeError, serializeEntry } from '../serialize.js';
import type { SerializedErrorLogEntry } from '../serialize.js';
import type {
  ErrorLogAdapter,
  ErrorLogEntry,
  ErrorLogResult,
} from '../types.js';

/** Default object store name. */
export const DEFAULT_STORE_NAME = 'error_log';

/** Event handler slot. Typed loosely so real DOM `IDBTransaction` objects fit. */
type IdbHandler = ((event: never) => unknown) | null;

/** The subset of an `IDBObjectStore` this adapter uses. */
export interface IdbObjectStoreLike {
  add(value: unknown): unknown;
  /**
   * Replaces the record with the same key. Used for entries that carry their own
   * `id`, so logging one again does not fail on the existing key. A real
   * `IDBObjectStore` has it; a fake without it falls back to `add`.
   */
  put?(value: unknown): unknown;
}

/** The subset of an `IDBTransaction` this adapter uses. */
export interface IdbTransactionLike {
  objectStore(name: string): IdbObjectStoreLike;
  oncomplete: IdbHandler;
  onerror: IdbHandler;
  onabort: IdbHandler;
  readonly error?: { message?: string } | null;
}

/** The subset of an `IDBDatabase` this adapter uses. */
export interface IdbDatabaseLike {
  transaction(storeNames: string, mode: 'readwrite'): IdbTransactionLike;
}

/** The subset of an `IDBDatabase` available inside `onupgradeneeded`. */
export interface IdbUpgradeDatabaseLike {
  readonly objectStoreNames: { contains(name: string): boolean };
  createObjectStore(
    name: string,
    options: { keyPath: string }
  ): { createIndex(name: string, keyPath: string): unknown };
}

/** A stored record: the serialized entry plus its generated UUID key. */
export interface IndexedDbErrorRecord extends SerializedErrorLogEntry {
  id: string;
}

export interface IndexedDbErrorOptions {
  /** Object store to write to. Defaults to `error_log`. */
  storeName?: string;
  /** Text printed before failure messages. Defaults to `[error-log-adapter]`. */
  prefix?: string;
}

/**
 * Creates the error log object store (UUID `id` key, `timestamp` index).
 * Call it from your `onupgradeneeded` handler. Does nothing if it already exists.
 */
export function createErrorLogStore(
  database: IdbUpgradeDatabaseLike,
  storeName: string = DEFAULT_STORE_NAME
): void {
  if (database.objectStoreNames.contains(storeName)) {
    return;
  }
  database
    .createObjectStore(storeName, { keyPath: 'id' })
    .createIndex('timestamp', 'timestamp');
}

export class IndexedDbErrorAdapter<
  TCode extends string = string,
> implements ErrorLogAdapter<TCode> {
  private readonly storeName: string;
  private readonly prefix: string;

  constructor(
    private readonly database: IdbDatabaseLike,
    options: IndexedDbErrorOptions = {}
  ) {
    this.storeName = options.storeName ?? DEFAULT_STORE_NAME;
    this.prefix = options.prefix ?? '[error-log-adapter]';
  }

  async log(entry: ErrorLogEntry<TCode>): Promise<ErrorLogResult> {
    try {
      const record: IndexedDbErrorRecord = {
        id: resolveEntryId(entry),
        ...serializeEntry(entry),
      };
      await this.write(record, hasCallerId(entry));
      return { ok: true };
    } catch (error: unknown) {
      console.error(`${this.prefix} IndexedDbErrorAdapter:`, error);
      return {
        ok: false,
        error: `IndexedDbErrorAdapter failed to write to object store "${this.storeName}": ${describeError(error)}`,
      };
    }
  }

  /** Resolves once the transaction commits; rejects if it errors or aborts. */
  private write(
    record: IndexedDbErrorRecord,
    replaceExisting: boolean
  ): Promise<void> {
    return new Promise<void>(
      (resolve: () => void, reject: (reason: unknown) => void): void => {
        const transaction: IdbTransactionLike = this.database.transaction(
          this.storeName,
          'readwrite'
        );
        const fail = (action: string) => (): void =>
          reject(
            new Error(
              `transaction ${action}: ${transaction.error?.message ?? 'no details provided'}`
            )
          );
        transaction.oncomplete = (): void => resolve();
        transaction.onerror = fail('failed');
        transaction.onabort = fail('aborted');
        const store: IdbObjectStoreLike = transaction.objectStore(
          this.storeName
        );
        if (replaceExisting && typeof store.put === 'function') {
          store.put(record);
        } else {
          store.add(record);
        }
      }
    );
  }
}
