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

/** Value of the `type` field when the `docType` option is not given. */
export const DEFAULT_DOC_TYPE = 'error_log';

/** One document as this adapter stores it. */
export interface CouchDbDocument {
  /** The entry's UUID. A second write of the same entry hits a conflict, which is treated as success. */
  _id: string;
  /** Marks the document as an error log entry, so one database can hold other kinds. Left out when `docType` is empty. */
  type?: string;
  code: string;
  message: string;
  /** The serialized cause as JSON. Left out when the entry has none. */
  cause?: unknown;
  /** Left out when the entry has none. */
  source?: string;
  /** ISO 8601, UTC. */
  occurred_at: string;
  /** ISO 8601, UTC: when the adapter wrote it. */
  created_at: string;
}

/** One element of a `_bulk_docs` answer. */
export interface CouchDbBulkResult {
  id?: string;
  ok?: boolean;
  /** For example `conflict`. */
  error?: string;
  reason?: string;
}

/**
 * What this adapter needs from a CouchDB database: `insert` and `bulk`. A
 * database handle from `nano` (`nano(url).use('error_log')`) fits as it is.
 * The database must exist; the adapter does not create it.
 */
export interface CouchDbDatabaseLike {
  insert(document: CouchDbDocument): Promise<unknown>;
  bulk(request: { docs: CouchDbDocument[] }): Promise<CouchDbBulkResult[]>;
}

export interface CouchDbErrorOptions {
  /**
   * Value of each document's `type` field. Defaults to `error_log`. Pass `''`
   * to leave the field out.
   */
  docType?: string;
  /** Text printed before failure messages. Defaults to `[error-log-adapter]`. */
  prefix?: string;
  /**
   * How long `log` waits for CouchDB, in milliseconds. Defaults to 10000. Pass
   * `Infinity` to wait without limit. The request cannot be cancelled, so it
   * may still finish after `log` has returned a failure.
   */
  timeoutMs?: number;
}

/**
 * The Mango index that makes "latest errors" and "errors in a time range"
 * queries fast. Pass it to `db.createIndex(...)` once:
 *
 * ```ts
 * await db.createIndex(buildErrorLogIndex());
 * ```
 */
export function buildErrorLogIndex(docType: string = DEFAULT_DOC_TYPE): {
  index: { fields: string[] };
  name: string;
  type: 'json';
} {
  return {
    index: {
      fields: docType === '' ? ['occurred_at'] : ['type', 'occurred_at'],
    },
    name: 'error_log_occurred_at',
    type: 'json',
  };
}

/**
 * Describes a failure, adding CouchDB's HTTP status and error name when the
 * client's error carries them (`nano` errors do): `CouchDB answered HTTP 404
 * (not_found): Database does not exist.`
 */
function describeCouchError(error: unknown): string {
  const text: string = describeError(error);
  if (typeof error !== 'object' || error === null) {
    return text;
  }
  const { statusCode, error: name } = error as {
    statusCode?: unknown;
    error?: unknown;
  };
  if (typeof statusCode !== 'number') {
    return text;
  }
  return `CouchDB answered HTTP ${statusCode}${typeof name === 'string' ? ` (${name})` : ''}: ${text}`;
}

/** True for CouchDB's "a document with this id already exists" answer. */
function isConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { statusCode?: unknown; error?: unknown };
  return candidate.statusCode === 409 || candidate.error === 'conflict';
}

/**
 * Stores each entry as a CouchDB document whose `_id` is the entry's UUID, with
 * `code`, `message`, `cause`, `source`, `occurred_at` and `created_at` fields.
 * `cause` is stored as real JSON, not a string.
 *
 * Because the document id is the entry id, logging the same entry again is
 * answered with a conflict, which this adapter treats as success: the stored
 * document is kept, so a retry after a timeout never stores an entry twice.
 *
 * The database has to exist (`nano.db.create('error_log')`). A missing
 * database, a bad login or an unreachable server comes back as `ok: false` with
 * CouchDB's reason.
 *
 * `logBatch` writes a batch with one `_bulk_docs` request, which
 * `BatchingErrorAdapter` uses when it wraps this adapter.
 */
export class CouchDbErrorAdapter<
  TCode extends string = string,
> implements ErrorLogAdapter<TCode> {
  private readonly docType: string;
  private readonly logPrefix: string;
  private readonly timeoutMs: number;

  /** @throws {RangeError} if `timeoutMs` is invalid. */
  constructor(
    private readonly database: CouchDbDatabaseLike,
    options: CouchDbErrorOptions = {}
  ) {
    this.docType = options.docType ?? DEFAULT_DOC_TYPE;
    this.logPrefix = options.prefix ?? DEFAULT_PREFIX;
    this.timeoutMs = resolveTimeoutMs(options.timeoutMs, 'CouchDbErrorAdapter');
  }

  async log(entry: ErrorLogEntry<TCode>): Promise<ErrorLogResult> {
    try {
      const document: CouchDbDocument = this.toDocument(entry);
      try {
        await withTimeout(
          (): Promise<unknown> => this.database.insert(document),
          this.timeoutMs,
          timeoutMessage('CouchDB', this.timeoutMs)
        );
      } catch (error: unknown) {
        if (!isConflict(error)) {
          throw error;
        }
      }
      return { ok: true };
    } catch (error: unknown) {
      return reportFailure({
        adapterName: 'CouchDbErrorAdapter',
        prefix: this.logPrefix,
        action: 'to write a document',
        error,
        reason: describeCouchError(error),
      });
    }
  }

  /**
   * Writes several entries with one `_bulk_docs` request. Every entry is
   * checked first, so one that cannot be stored (an invalid `id` or
   * `timestamp`) fails the whole call and nothing is written. CouchDB then
   * answers per document: entries that already exist count as stored, and if
   * any other document is refused the error says how many were stored and why
   * the others were not. Trying the batch again is safe.
   */
  async logBatch(entries: ErrorLogEntry<TCode>[]): Promise<ErrorLogResult> {
    if (entries.length === 0) {
      return { ok: true };
    }
    const count: number = entries.length;
    try {
      const docs: CouchDbDocument[] = [];
      for (const [index, entry] of entries.entries()) {
        try {
          docs.push(this.toDocument(entry));
        } catch (error: unknown) {
          throw new Error(
            `${describeError(error)} (entry ${index} could not be prepared, so nothing was written)`
          );
        }
      }
      const results: CouchDbBulkResult[] = await withTimeout(
        (): Promise<CouchDbBulkResult[]> => this.database.bulk({ docs }),
        this.timeoutMs,
        timeoutMessage('CouchDB', this.timeoutMs)
      );
      const refused: CouchDbBulkResult[] = (
        Array.isArray(results) ? results : []
      ).filter(
        (result: CouchDbBulkResult): boolean =>
          result.error !== undefined && result.error !== 'conflict'
      );
      if (refused.length > 0) {
        const reasons: string = refused
          .slice(0, 3)
          .map(
            (result: CouchDbBulkResult): string =>
              `${result.id ?? 'a document'}: ${result.error ?? 'error'}${result.reason === undefined ? '' : ` (${result.reason})`}`
          )
          .join('; ');
        throw new Error(
          `CouchDB refused ${refused.length} of ${count} documents, so ${count - refused.length} were stored: ${reasons}${refused.length > 3 ? '; and more' : ''}`
        );
      }
      return { ok: true };
    } catch (error: unknown) {
      return reportFailure({
        adapterName: 'CouchDbErrorAdapter',
        prefix: this.logPrefix,
        action: `to write ${count} document${count === 1 ? '' : 's'}`,
        error,
        reason: describeCouchError(error),
      });
    }
  }

  private toDocument(entry: ErrorLogEntry<TCode>): CouchDbDocument {
    const serialized = serializeEntry(entry);
    const occurredAt: Date = new Date(serialized.timestamp);
    if (Number.isNaN(occurredAt.getTime())) {
      throw new RangeError(
        `timestamp "${serialized.timestamp}" is not a valid ISO 8601 date`
      );
    }
    const document: CouchDbDocument = {
      _id: resolveEntryId(entry),
      code: serialized.code,
      message: serialized.message,
      occurred_at: occurredAt.toISOString(),
      created_at: new Date().toISOString(),
    };
    if (this.docType !== '') {
      document.type = this.docType;
    }
    if (serialized.cause !== undefined) {
      document.cause = serialized.cause;
    }
    if (serialized.source !== undefined) {
      document.source = serialized.source;
    }
    return document;
  }
}
