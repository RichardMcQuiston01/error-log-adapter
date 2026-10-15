import { hasCallerId, resolveEntryId } from '../entry-id.js';
import { describeError, serializeEntry } from '../serialize.js';
import type {
  ErrorLogAdapter,
  ErrorLogEntry,
  ErrorLogResult,
} from '../types.js';

/** The fields stored for each entry, in Firestore and in the Realtime Database. */
export interface FirebaseErrorRecord {
  /** UUID. In Firestore it is also the document id. */
  id: string;
  code: string;
  message: string;
  /** ISO 8601 timestamp of the entry. */
  timestamp: string;
  source?: string;
  /**
   * The entry's cause as a JSON string. Plain text avoids Firestore's limits on
   * custom objects and nested arrays, and the Realtime Database's limits on key
   * characters, so an odd cause can never make the write fail.
   */
  cause?: string;
}

/**
 * The only thing the Firestore adapter needs from a collection: `doc(id).set(data)`.
 * A `firebase-admin` collection (`getFirestore().collection('error_log')`) fits
 * as it is. With the web SDK, wrap it:
 *
 * ```ts
 * const collectionLike: FirestoreCollectionLike = {
 *   doc: (id) => ({ set: (data) => setDoc(doc(db, 'error_log', id), data) }),
 * };
 * ```
 */
export interface FirestoreCollectionLike {
  doc(documentId: string): { set(data: FirebaseErrorRecord): Promise<unknown> };
}

/**
 * The only thing the Realtime Database adapter needs from a reference:
 * `push(value)`, which resolves once the write is saved. A `firebase-admin`
 * reference (`getDatabase().ref('error_log')`) fits as it is. With the web SDK, wrap it:
 *
 * ```ts
 * const refLike: RealtimeDatabaseRefLike = {
 *   push: (value) => push(ref(db, 'error_log'), value),
 *   child: (key) => ({ set: (value) => set(ref(db, `error_log/${key}`), value) }),
 * };
 * ```
 *
 * `child(key).set(value)` is only needed for entries that carry their own `id`
 * (see `ErrorLogEntry.id`): they are written under that key, so logging the same
 * entry again overwrites the record instead of adding a second one.
 */
export interface RealtimeDatabaseRefLike {
  push(value: FirebaseErrorRecord): PromiseLike<unknown>;
  child?(key: string): {
    set(value: FirebaseErrorRecord): PromiseLike<unknown>;
  };
}

/** Default time to wait for a write to be saved, in milliseconds. */
export const DEFAULT_WRITE_TIMEOUT_MS = 10_000;

export interface FirebaseErrorOptions {
  /**
   * How long `log` waits for the write to be saved before giving up, in
   * milliseconds. Defaults to 10000. Pass `Infinity` to wait without limit.
   *
   * The Firebase SDKs keep writes queued while the connection is down, and
   * their promises stay pending until it returns, so without a limit `log`
   * could hang for as long as an outage lasts. A write that timed out is still
   * queued by the SDK and may be saved later.
   */
  timeoutMs?: number;
  /** Text printed before failure messages. Defaults to `[error-log-adapter]`. */
  prefix?: string;
}

function resolveTimeout(
  options: FirebaseErrorOptions,
  adapter: string
): number {
  const timeoutMs: number = options.timeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS;
  if (Number.isNaN(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(
      `${adapter}: timeoutMs must be a positive number or Infinity, received ${String(options.timeoutMs)}.`
    );
  }
  return timeoutMs;
}

/** Waits for the write, but rejects with a descriptive error if it takes longer than `timeoutMs`. */
function waitForWrite(
  write: PromiseLike<unknown>,
  timeoutMs: number
): Promise<unknown> {
  if (timeoutMs === Infinity) {
    return Promise.resolve(write);
  }
  return new Promise<unknown>(
    (resolve: (value: unknown) => void, reject: (reason: unknown) => void) => {
      const timer = setTimeout((): void => {
        reject(
          new Error(
            `the write was not saved within ${timeoutMs} ms (the connection may be down; the SDK keeps the write queued and may still save it later)`
          )
        );
      }, timeoutMs);
      write.then(
        (value: unknown): void => {
          clearTimeout(timer);
          resolve(value);
        },
        (reason: unknown): void => {
          clearTimeout(timer);
          reject(reason);
        }
      );
    }
  );
}

function buildRecord<TCode extends string>(
  entry: ErrorLogEntry<TCode>
): FirebaseErrorRecord {
  const serialized = serializeEntry(entry);
  const record: FirebaseErrorRecord = {
    id: resolveEntryId(entry),
    code: serialized.code,
    message: serialized.message,
    timestamp: serialized.timestamp,
  };
  if (serialized.source !== undefined) {
    record.source = serialized.source;
  }
  if (serialized.cause !== undefined) {
    record.cause = JSON.stringify(serialized.cause);
  }
  return record;
}

/**
 * Writes each entry as a document in a Firestore collection. The document id is
 * the entry's UUID, so retrying a write never creates a duplicate.
 */
export class FirestoreErrorAdapter<
  TCode extends string = string,
> implements ErrorLogAdapter<TCode> {
  private readonly prefix: string;
  private readonly timeoutMs: number;

  /** @throws {RangeError} if `options.timeoutMs` is not a positive number or `Infinity`. */
  constructor(
    private readonly collection: FirestoreCollectionLike,
    options: FirebaseErrorOptions = {}
  ) {
    this.prefix = options.prefix ?? '[error-log-adapter]';
    this.timeoutMs = resolveTimeout(options, 'FirestoreErrorAdapter');
  }

  async log(entry: ErrorLogEntry<TCode>): Promise<ErrorLogResult> {
    try {
      const record: FirebaseErrorRecord = buildRecord(entry);
      await waitForWrite(
        this.collection.doc(record.id).set(record),
        this.timeoutMs
      );
      return { ok: true };
    } catch (error: unknown) {
      console.error(`${this.prefix} FirestoreErrorAdapter:`, error);
      return {
        ok: false,
        error: `FirestoreErrorAdapter failed to write the document: ${describeError(error)}`,
      };
    }
  }
}

/**
 * Writes each entry under a Realtime Database reference with `push`, which
 * generates a chronologically ordered key.
 */
export class RealtimeDatabaseErrorAdapter<
  TCode extends string = string,
> implements ErrorLogAdapter<TCode> {
  private readonly prefix: string;
  private readonly timeoutMs: number;

  /** @throws {RangeError} if `options.timeoutMs` is not a positive number or `Infinity`. */
  constructor(
    private readonly reference: RealtimeDatabaseRefLike,
    options: FirebaseErrorOptions = {}
  ) {
    this.prefix = options.prefix ?? '[error-log-adapter]';
    this.timeoutMs = resolveTimeout(options, 'RealtimeDatabaseErrorAdapter');
  }

  async log(entry: ErrorLogEntry<TCode>): Promise<ErrorLogResult> {
    try {
      const record: FirebaseErrorRecord = buildRecord(entry);
      let write: PromiseLike<unknown>;
      if (hasCallerId(entry)) {
        if (this.reference.child === undefined) {
          throw new TypeError(
            'the entry has an id, which needs a reference with child(key).set(value) so a repeat overwrites the first write; add child to the reference or log without an id'
          );
        }
        write = this.reference.child(record.id).set(record);
      } else {
        write = this.reference.push(record);
      }
      await waitForWrite(write, this.timeoutMs);
      return { ok: true };
    } catch (error: unknown) {
      console.error(`${this.prefix} RealtimeDatabaseErrorAdapter:`, error);
      return {
        ok: false,
        error: `RealtimeDatabaseErrorAdapter failed to write the entry: ${describeError(error)}`,
      };
    }
  }
}
