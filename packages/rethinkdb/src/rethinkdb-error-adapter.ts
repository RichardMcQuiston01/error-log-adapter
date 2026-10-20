import type {
  ErrorLogAdapter,
  ErrorLogEntry,
  ErrorLogResult,
} from '@richardmcquiston01/error-log-adapter';
import { serializeEntry } from '@richardmcquiston01/error-log-adapter';
import {
  DEFAULT_PREFIX,
  describeError,
  reportFailure,
  resolveEntryId,
  resolveTimeoutMs,
  timeoutMessage,
  withTimeout,
} from '@richardmcquiston01/error-log-adapter/kit';

/** Name of the secondary index `occurred_at`, for the index command in the README. */
export const OCCURRED_AT_INDEX = 'occurred_at';

/** One document as this adapter stores it. */
export interface RethinkDbDocument {
  /** The entry's UUID, the table's primary key. */
  id: string;
  code: string;
  message: string;
  /** The serialized cause, as real JSON. Left out when the entry has none. */
  cause?: unknown;
  /** Left out when the entry has none. */
  source?: string;
  /** Stored as RethinkDB's native time type. */
  occurred_at: Date;
  /** Stored as RethinkDB's native time type: when the adapter wrote it. */
  created_at: Date;
}

/**
 * Decides what happens when a document with the same primary key exists. The
 * adapter passes a function that returns the existing document, which keeps it.
 * It must take three arguments, because the driver turns it into a ReQL
 * function and RethinkDB checks the count.
 */
export type RethinkDbConflictFunction = (
  // `any`, because the driver passes ReQL terms (`RDatum`) here, not plain values.
  id: any,
  oldDocument: any,
  newDocument: any
) => Record<string, unknown>;

/** The insert options this adapter passes. */
export interface RethinkDbInsertOptionsLike {
  conflict?: RethinkDbConflictFunction;
  durability?: 'hard' | 'soft';
}

/** The part of a write result this adapter reads. */
export interface RethinkDbWriteResultLike {
  /** How many documents were refused. RethinkDB reports this instead of throwing. */
  errors?: number;
  /** The first refusal's message. */
  first_error?: string;
  inserted?: number;
  unchanged?: number;
}

/**
 * What this adapter needs from a table: `insert`, whose result has a `run`.
 * A table from [`rethinkdb-ts`](https://www.npmjs.com/package/rethinkdb-ts)
 * (`r.db('logs').table('error_log')`) fits as it is.
 */
export interface RethinkDbTableLike<TConnection = unknown> {
  insert(
    documents: RethinkDbDocument | RethinkDbDocument[],
    options?: RethinkDbInsertOptionsLike
  ): {
    run(connection?: TConnection): Promise<RethinkDbWriteResultLike>;
  };
}

export interface RethinkDbErrorOptions {
  /**
   * `hard` (RethinkDB's default) waits until the write is on disk; `soft`
   * answers as soon as it is in memory. Left out, the table's setting applies.
   */
  durability?: 'hard' | 'soft';
  /** Text printed before failure messages. Defaults to `[error-log-adapter]`. */
  prefix?: string;
  /**
   * How long to wait for RethinkDB, in milliseconds. Defaults to 10000. Pass
   * `Infinity` to wait without limit. The request cannot be cancelled, so it
   * may still finish after `log` has returned a failure.
   */
  timeoutMs?: number;
}

/**
 * Describes a failure. `rethinkdb-ts` errors put the whole query, document
 * included, in `message`; their `msg` is just the server's reason, so that is
 * used when it is there: `RethinkDB error ReqlOpFailedError: Table
 * \`logs.error_log\` does not exist.`
 */
function describeRethinkError(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const { msg, name } = error as { msg?: unknown; name?: unknown };
    if (typeof msg === 'string' && msg !== '') {
      const reason: string = msg.replace(/\s+/g, ' ').trim();
      return typeof name === 'string' && name !== ''
        ? `RethinkDB error ${name}: ${reason}`
        : `RethinkDB error: ${reason}`;
    }
  }
  return describeError(error);
}

/** Keeps the document that is already stored when the primary key exists. */
const keepExisting: RethinkDbConflictFunction = (
  _id,
  oldDocument,
  _newDocument
): Record<string, unknown> => oldDocument;

/**
 * Stores each entry as a RethinkDB document whose primary key `id` is the
 * entry's UUID, with `code`, `message`, `cause`, `source`, `occurred_at` and
 * `created_at`. `cause` is stored as real JSON and the two times as RethinkDB's
 * native time type, so `orderBy` on an `occurred_at` index works.
 *
 * Because the primary key is the entry id, logging the same entry again leaves
 * the stored document as it was, so a retry after a timeout never stores an
 * entry twice.
 *
 * RethinkDB answers a refused write with a result whose `errors` count is not 0
 * instead of an error, so this adapter reads that count and reports the first
 * error. The table has to exist (`r.db('logs').tableCreate('error_log')`).
 *
 * `logBatch` writes a batch with one `insert`, which `BatchingErrorAdapter`
 * uses when it wraps this adapter.
 */
export class RethinkDbErrorAdapter<
  TCode extends string = string,
  TConnection = unknown,
> implements ErrorLogAdapter<TCode> {
  private readonly durability: 'hard' | 'soft' | undefined;
  private readonly logPrefix: string;
  private readonly timeoutMs: number;

  /**
   * @param table A table such as `r.db('logs').table('error_log')`.
   * @param connection The connection to run on. Leave it out when the driver
   * has a default connection pool.
   * @throws {RangeError} if `durability` is not `hard` or `soft`, or `timeoutMs` is invalid.
   */
  constructor(
    private readonly table: RethinkDbTableLike<TConnection>,
    private readonly connection?: TConnection,
    options: RethinkDbErrorOptions = {}
  ) {
    this.durability = options.durability;
    if (
      this.durability !== undefined &&
      this.durability !== 'hard' &&
      this.durability !== 'soft'
    ) {
      throw new RangeError(
        `RethinkDbErrorAdapter: durability must be "hard" or "soft", received ${JSON.stringify(this.durability)}.`
      );
    }
    this.logPrefix = options.prefix ?? DEFAULT_PREFIX;
    this.timeoutMs = resolveTimeoutMs(
      options.timeoutMs,
      'RethinkDbErrorAdapter'
    );
  }

  async log(entry: ErrorLogEntry<TCode>): Promise<ErrorLogResult> {
    try {
      await this.write(this.toDocument(entry));
      return { ok: true };
    } catch (error: unknown) {
      return reportFailure({
        adapterName: 'RethinkDbErrorAdapter',
        prefix: this.logPrefix,
        action: 'to write a document',
        error,
        reason: describeRethinkError(error),
      });
    }
  }

  /**
   * Writes several entries with one `insert`. Every entry is checked first, so
   * one that cannot be stored (an invalid `id` or `timestamp`) fails the whole
   * call and nothing is written. If RethinkDB refuses any document, the error
   * gives the count and the first reason. Trying the batch again is safe:
   * documents that exist are left as they are.
   */
  async logBatch(entries: ErrorLogEntry<TCode>[]): Promise<ErrorLogResult> {
    if (entries.length === 0) {
      return { ok: true };
    }
    const count: number = entries.length;
    try {
      const documents: RethinkDbDocument[] = [];
      for (const [index, entry] of entries.entries()) {
        try {
          documents.push(this.toDocument(entry));
        } catch (error: unknown) {
          throw new Error(
            `${describeError(error)} (entry ${index} could not be prepared, so nothing was written)`
          );
        }
      }
      await this.write(documents);
      return { ok: true };
    } catch (error: unknown) {
      return reportFailure({
        adapterName: 'RethinkDbErrorAdapter',
        prefix: this.logPrefix,
        action: `to write ${count} document${count === 1 ? '' : 's'}`,
        error,
        reason: describeRethinkError(error),
      });
    }
  }

  private async write(
    documents: RethinkDbDocument | RethinkDbDocument[]
  ): Promise<void> {
    const options: RethinkDbInsertOptionsLike = { conflict: keepExisting };
    if (this.durability !== undefined) {
      options.durability = this.durability;
    }
    const result: RethinkDbWriteResultLike = await withTimeout(
      (): Promise<RethinkDbWriteResultLike> =>
        this.table.insert(documents, options).run(this.connection),
      this.timeoutMs,
      timeoutMessage('RethinkDB', this.timeoutMs)
    );
    const errors: number =
      typeof result === 'object' && result !== null
        ? Number(result.errors ?? 0)
        : 0;
    if (errors > 0) {
      const total: number = Array.isArray(documents) ? documents.length : 1;
      const reason: string = (result.first_error ?? 'no reason given').split(
        '\n'
      )[0] as string;
      throw new Error(
        `RethinkDB refused ${errors} of ${total} document${total === 1 ? '' : 's'}: ${reason}`
      );
    }
  }

  private toDocument(entry: ErrorLogEntry<TCode>): RethinkDbDocument {
    const serialized = serializeEntry(entry);
    const occurredAt: Date = new Date(serialized.timestamp);
    if (Number.isNaN(occurredAt.getTime())) {
      throw new RangeError(
        `timestamp "${serialized.timestamp}" is not a valid ISO 8601 date`
      );
    }
    const document: RethinkDbDocument = {
      id: resolveEntryId(entry),
      code: serialized.code,
      message: serialized.message,
      occurred_at: occurredAt,
      created_at: new Date(),
    };
    if (serialized.cause !== undefined) {
      document.cause = serialized.cause;
    }
    if (serialized.source !== undefined) {
      document.source = serialized.source;
    }
    return document;
  }
}
