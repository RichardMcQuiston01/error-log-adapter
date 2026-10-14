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
      await this.collection.insertOne(serializeEntry(entry));
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
