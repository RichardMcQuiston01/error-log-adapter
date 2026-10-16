import { DEFAULT_PREFIX, reportFailure } from '../fail.js';
import { hasCallerId, resolveEntryId } from '../entry-id.js';
import { resolveTimeoutMs, timeoutMessage, withTimeout } from '../timeout.js';
import { serializeEntry } from '../serialize.js';
import type {
  ErrorLogAdapter,
  ErrorLogEntry,
  ErrorLogResult,
} from '../types.js';

/** The subset of a MongoDB `Collection` this adapter uses. */
export interface CollectionLike {
  insertOne(doc: object): Promise<unknown>;
}

export interface MongoDbErrorOptions {
  /** Text printed before failure messages. Defaults to `[error-log-adapter]`. */
  prefix?: string;
  /**
   * How long `log` waits for the insert before giving up, in milliseconds. Defaults to
   * 10000. Pass `Infinity` to wait without limit. The call cannot be cancelled,
   * so it may still finish after `log` has returned a failure.
   */
  timeoutMs?: number;
}

/** MongoDB reports a repeated `_id` as error code 11000. */
function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 11000
  );
}

export class MongoDbErrorAdapter<
  TCode extends string = string,
> implements ErrorLogAdapter<TCode> {
  private readonly prefix: string;
  private readonly timeoutMs: number;

  /** @throws {RangeError} if `options.timeoutMs` is not a positive number or Infinity. */
  constructor(
    private readonly collection: CollectionLike,
    options: MongoDbErrorOptions = {}
  ) {
    this.prefix = options.prefix ?? DEFAULT_PREFIX;
    this.timeoutMs = resolveTimeoutMs(options.timeoutMs, 'MongoDbErrorAdapter');
  }

  async log(entry: ErrorLogEntry<TCode>): Promise<ErrorLogResult> {
    try {
      const document: object = hasCallerId(entry)
        ? { _id: resolveEntryId(entry), ...serializeEntry(entry) }
        : serializeEntry(entry);
      await withTimeout(
        (): Promise<unknown> => this.collection.insertOne(document),
        this.timeoutMs,
        timeoutMessage('MongoDB', this.timeoutMs)
      );
      return { ok: true };
    } catch (error: unknown) {
      if (hasCallerId(entry) && isDuplicateKeyError(error)) {
        // The same id was stored before: this call is a retry that already succeeded.
        return { ok: true };
      }
      return reportFailure({
        adapterName: 'MongoDbErrorAdapter',
        prefix: this.prefix,
        action: 'to insert entry',
        error,
      });
    }
  }
}
