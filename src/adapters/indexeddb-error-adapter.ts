import { DEFAULT_PREFIX, reportFailure } from '../fail.js';
import { hasCallerId, resolveEntryId } from '../entry-id.js';
import { resolveTimeoutMs, timeoutMessage, withTimeout } from '../timeout.js';
import { serializeEntry } from '../serialize.js';
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

/** The parts of a DOM event this adapter calls. */
interface IdbEventLike {
  preventDefault?(): void;
  stopPropagation?(): void;
}

/** The error object of a failed request or transaction (a `DOMException`). */
interface IdbErrorLike {
  name?: string;
  message?: string;
}

/** The subset of an `IDBRequest` this adapter uses. */
export interface IdbRequestLike {
  onerror: IdbHandler;
  readonly error?: IdbErrorLike | null;
}

/** The subset of an `IDBObjectStore` this adapter uses. */
export interface IdbObjectStoreLike {
  /** Returns an `IDBRequest`. Fakes that return nothing also work. */
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
  readonly error?: IdbErrorLike | null;
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
  /**
   * How long `log` waits for the transaction to finish, in milliseconds. Defaults
   * to 10000. Pass `Infinity` to wait without limit. A transaction can stay
   * pending when a version change in another tab blocks it, or when the browser
   * has evicted the origin's storage. The write may still finish afterwards.
   */
  timeoutMs?: number;
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
  private readonly timeoutMs: number;

  /** @throws {RangeError} if `options.timeoutMs` is not a positive number or Infinity. */
  constructor(
    private readonly database: IdbDatabaseLike,
    options: IndexedDbErrorOptions = {}
  ) {
    this.storeName = options.storeName ?? DEFAULT_STORE_NAME;
    this.prefix = options.prefix ?? DEFAULT_PREFIX;
    this.timeoutMs = resolveTimeoutMs(
      options.timeoutMs,
      'IndexedDbErrorAdapter'
    );
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
      return reportFailure({
        adapterName: 'IndexedDbErrorAdapter',
        prefix: this.prefix,
        action: `to write to object store "${this.storeName}"`,
        error,
      });
    }
  }

  /**
   * Resolves once the transaction commits; rejects if the request fails, the
   * transaction aborts, or it does not finish within `timeoutMs`.
   *
   * Error events are handled here (`preventDefault` and `stopPropagation`), so a
   * failed log write does not reach the `onerror` handler an app may have set on
   * its own database object.
   */
  private write(
    record: IndexedDbErrorRecord,
    replaceExisting: boolean
  ): Promise<void> {
    return withTimeout(
      (): Promise<void> =>
        new Promise<void>(
          (resolve: () => void, reject: (reason: unknown) => void): void => {
            const transaction: IdbTransactionLike = this.database.transaction(
              this.storeName,
              'readwrite'
            );
            const fail =
              (what: string, source: { error?: IdbErrorLike | null }) =>
              (event?: IdbEventLike): void => {
                event?.preventDefault?.();
                event?.stopPropagation?.();
                reject(new Error(`${what}: ${describeDomError(source.error)}`));
              };
            transaction.oncomplete = (): void => resolve();
            transaction.onerror = fail('transaction failed', transaction);
            transaction.onabort = fail('transaction aborted', transaction);
            const store: IdbObjectStoreLike = transaction.objectStore(
              this.storeName
            );
            const request: unknown =
              replaceExisting && typeof store.put === 'function'
                ? store.put(record)
                : store.add(record);
            if (typeof request === 'object' && request !== null) {
              // The request error holds the details (for example a
              // ConstraintError); the transaction's own error is null for it.
              (request as IdbRequestLike).onerror = fail(
                'request failed',
                request as IdbRequestLike
              );
            }
          }
        ),
      this.timeoutMs,
      timeoutMessage('IndexedDB', this.timeoutMs, 'finish the transaction')
    );
  }
}

/** `ConstraintError: Unable to add key to index...`, or a note that nothing was given. */
function describeDomError(error: IdbErrorLike | null | undefined): string {
  if (error === null || error === undefined) {
    return 'no details provided';
  }
  const text: string = [error.name, error.message]
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join(': ');
  return text === '' ? 'no details provided' : text;
}
