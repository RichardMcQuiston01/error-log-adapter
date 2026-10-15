import { hasCallerId, resolveEntryId } from '../entry-id.js';
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

  constructor(
    private readonly collection: CollectionLike,
    options: MongoDbErrorOptions = {}
  ) {
    this.prefix = options.prefix ?? '[error-log-adapter]';
  }

  async log(entry: ErrorLogEntry<TCode>): Promise<ErrorLogResult> {
    try {
      const document: object = hasCallerId(entry)
        ? { _id: resolveEntryId(entry), ...serializeEntry(entry) }
        : serializeEntry(entry);
      await this.collection.insertOne(document);
      return { ok: true };
    } catch (error: unknown) {
      if (hasCallerId(entry) && isDuplicateKeyError(error)) {
        // The same id was stored before: this call is a retry that already succeeded.
        return { ok: true };
      }
      console.error(`${this.prefix} MongoDbErrorAdapter:`, error);
      return {
        ok: false,
        error: `MongoDbErrorAdapter failed to insert entry: ${describeError(error)}`,
      };
    }
  }
}
