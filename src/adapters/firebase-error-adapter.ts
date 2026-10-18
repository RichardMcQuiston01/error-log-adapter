import { DEFAULT_PREFIX, reportFailure } from '../fail.js';
import { hasCallerId, resolveEntryId } from '../entry-id.js';
import {
  DEFAULT_TIMEOUT_MS,
  resolveTimeoutMs,
  withTimeout,
} from '../timeout.js';
import { serializeEntry } from '../serialize.js';
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
  doc(documentId: string): {
    set(data: FirestoreErrorRecord): Promise<unknown>;
  };
}

/**
 * What the Firestore adapter writes: the usual fields, plus the expiry field
 * (a `Date`, which Firestore stores as a timestamp) when `expireAfterMs` is set.
 */
export type FirestoreErrorRecord = FirebaseErrorRecord & {
  [field: string]: unknown;
};

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
export const DEFAULT_WRITE_TIMEOUT_MS: number = DEFAULT_TIMEOUT_MS;

export interface FirebaseErrorOptions {
  /**
   * How long `log` waits for the write to be saved before giving up, in
   * milliseconds. Defaults to 10000. Pass `Infinity` to wait without limit.
   *
   * The Firebase SDKs keep writes queued while the connection is down, and
   * their promises stay pending until it returns, so without a limit `log`
   * could hang for as long as an outage lasts. A write that timed out is still
   * queued by the SDK and may be saved later. Retry a timeout only with the same
   * `ErrorLogEntry.id`, so the retry overwrites the first write instead of
   * adding a second one.
   */
  timeoutMs?: number;
  /** Text printed before failure messages. Defaults to `[error-log-adapter]`. */
  prefix?: string;
}

/** Default name of the field that holds a document's expiry time. */
export const DEFAULT_EXPIRE_FIELD = 'expire_at';

const RESERVED_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'code',
  'message',
  'timestamp',
  'source',
  'cause',
]);

export interface FirestoreErrorOptions extends FirebaseErrorOptions {
  /**
   * Add an expiry time to every document: the entry's `timestamp` plus this
   * many milliseconds, stored as a Firestore timestamp in `expireField`. This
   * only writes the field. Firestore deletes nothing until you turn on a TTL
   * policy for that field, for example:
   *
   * ```sh
   * gcloud firestore fields ttls update expire_at \
   *   --collection-group=error_log --enable-ttl
   * ```
   *
   * Firestore then removes documents some time after they expire (typically
   * within a day), and the deletes are billed like any other. Off by default.
   */
  expireAfterMs?: number;
  /** Name of the expiry field. Defaults to `expire_at`. Only used with `expireAfterMs`. */
  expireField?: string;
}

/** Waits for the write, but rejects with a descriptive error if it takes longer than `timeoutMs`. */
function waitForWrite(
  start: () => PromiseLike<unknown>,
  timeoutMs: number
): Promise<unknown> {
  return withTimeout(
    start,
    timeoutMs,
    `the write was not saved within ${timeoutMs} ms (the connection may be down; the SDK keeps the write queued and may still save it later, so logging the entry again could store it twice unless it carries an id)`
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
 * the entry's UUID, so the SDK finishing one queued write twice cannot create two
 * documents. Calling `log` again without an `id` on the entry is a new write
 * with a new UUID: if a call reported a timeout, the first write may still be
 * saved later, and logging the same entry again can store it twice. Give the
 * entry an `id` and the retry overwrites the same document.
 */
export class FirestoreErrorAdapter<
  TCode extends string = string,
> implements ErrorLogAdapter<TCode> {
  private readonly prefix: string;
  private readonly timeoutMs: number;
  private readonly expireAfterMs: number | undefined;
  private readonly expireField: string;

  /** @throws {RangeError} if `options.timeoutMs` is not a positive number or `Infinity`, or the expiry options are invalid. */
  constructor(
    private readonly collection: FirestoreCollectionLike,
    options: FirestoreErrorOptions = {}
  ) {
    this.prefix = options.prefix ?? DEFAULT_PREFIX;
    this.timeoutMs = resolveTimeoutMs(
      options.timeoutMs,
      'FirestoreErrorAdapter'
    );
    this.expireAfterMs = options.expireAfterMs;
    this.expireField = options.expireField ?? DEFAULT_EXPIRE_FIELD;
    if (
      this.expireAfterMs !== undefined &&
      (!Number.isFinite(this.expireAfterMs) || this.expireAfterMs <= 0)
    ) {
      throw new RangeError(
        `FirestoreErrorAdapter: expireAfterMs must be a positive number of milliseconds, received ${String(options.expireAfterMs)}.`
      );
    }
    if (
      this.expireField === '' ||
      /[./]/.test(this.expireField) ||
      RESERVED_FIELDS.has(this.expireField)
    ) {
      throw new RangeError(
        `FirestoreErrorAdapter: expireField must be a name other than ${[...RESERVED_FIELDS].join(', ')}, without "." or "/", received ${JSON.stringify(this.expireField)}.`
      );
    }
  }

  async log(entry: ErrorLogEntry<TCode>): Promise<ErrorLogResult> {
    try {
      const record: FirestoreErrorRecord = { ...buildRecord(entry) };
      if (this.expireAfterMs !== undefined) {
        const occurredAt: number = Date.parse(record.timestamp);
        if (Number.isNaN(occurredAt)) {
          throw new RangeError(
            `timestamp "${record.timestamp}" is not a valid ISO 8601 date, so the expiry time cannot be worked out`
          );
        }
        record[this.expireField] = new Date(occurredAt + this.expireAfterMs);
      }
      await waitForWrite(
        () => this.collection.doc(record.id).set(record),
        this.timeoutMs
      );
      return { ok: true };
    } catch (error: unknown) {
      return reportFailure({
        adapterName: 'FirestoreErrorAdapter',
        prefix: this.prefix,
        action: `to write the document`,
        error,
      });
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
    this.prefix = options.prefix ?? DEFAULT_PREFIX;
    this.timeoutMs = resolveTimeoutMs(
      options.timeoutMs,
      'RealtimeDatabaseErrorAdapter'
    );
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
      await waitForWrite(() => write, this.timeoutMs);
      return { ok: true };
    } catch (error: unknown) {
      return reportFailure({
        adapterName: 'RealtimeDatabaseErrorAdapter',
        prefix: this.prefix,
        action: `to write the entry`,
        error,
      });
    }
  }
}
