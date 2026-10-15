import { resolveTimeoutMs, timeoutMessage, withTimeout } from '../timeout.js';
import { describeError, serializeEntry } from '../serialize.js';
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
    this.prefix = options.prefix ?? '[error-log-adapter]';
    this.timeoutMs = resolveTimeoutMs(options.timeoutMs, 'MongoDbErrorAdapter');
  }

  async log(entry: ErrorLogEntry<TCode>): Promise<ErrorLogResult> {
    try {
      const document: object = serializeEntry(entry);
      await withTimeout(
        (): Promise<unknown> => this.collection.insertOne(document),
        this.timeoutMs,
        timeoutMessage('MongoDB', this.timeoutMs)
      );
      return { ok: true };
    } catch (error: unknown) {
      console.error(`${this.prefix} MongoDbErrorAdapter:`, error);
      return {
        ok: false,
        error: `MongoDbErrorAdapter failed to insert entry: ${describeError(error)}`,
      };
    }
  }
}
