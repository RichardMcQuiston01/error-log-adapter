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

/** One document as this adapter stores it. */
export interface ArangoDocument {
  /** The entry's UUID. A second write of the same entry is ignored. */
  _key: string;
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

/** The insert options this adapter passes. */
export interface ArangoInsertOptionsLike {
  /** `ignore` skips a document whose `_key` already exists, without an error (ArangoDB 3.7 and newer). */
  overwriteMode?: 'ignore';
}

/**
 * What this adapter needs from an ArangoDB collection: `save` and `saveAll`.
 * A collection handle from `arangojs` (`db.collection('error_log')`) fits as it
 * is. The collection must exist; the adapter does not create it.
 */
export interface ArangoCollectionLike {
  save(
    data: ArangoDocument,
    options?: ArangoInsertOptionsLike
  ): Promise<unknown>;
  saveAll(
    data: ArangoDocument[],
    options?: ArangoInsertOptionsLike
  ): Promise<unknown[]>;
}

export interface ArangoDbErrorOptions {
  /** Text printed before failure messages. Defaults to `[error-log-adapter]`. */
  prefix?: string;
  /**
   * How long `log` waits for ArangoDB, in milliseconds. Defaults to 10000. Pass
   * `Infinity` to wait without limit. The request cannot be cancelled, so it
   * may still finish after `log` has returned a failure.
   */
  timeoutMs?: number;
}

/**
 * The persistent index that makes "latest errors" and time-range queries fast.
 * Pass it to `collection.ensureIndex(...)` once:
 *
 * ```ts
 * await collection.ensureIndex(buildErrorLogIndex());
 * ```
 */
export function buildErrorLogIndex(): {
  type: 'persistent';
  fields: string[];
  name: string;
} {
  return {
    type: 'persistent',
    fields: ['occurred_at'],
    name: 'error_log_occurred_at',
  };
}

/** ArangoDB error number for "unique constraint violated", which a key that already exists produces. */
const UNIQUE_CONSTRAINT_VIOLATED = 1210;

/** True when ArangoDB (or the client) says the document key already exists. */
function isKeyConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { errorNum?: unknown; code?: unknown };
  return (
    candidate.errorNum === UNIQUE_CONSTRAINT_VIOLATED ||
    (candidate.code === 409 && candidate.errorNum === undefined)
  );
}

/**
 * Describes a failure, adding ArangoDB's error number and HTTP status when the
 * client's error carries them (`arangojs` errors do): `ArangoDB error 1203
 * (HTTP 404): collection or view not found`.
 */
function describeArangoError(error: unknown): string {
  const text: string = describeError(error);
  if (typeof error !== 'object' || error === null) {
    return text;
  }
  const { errorNum, code } = error as { errorNum?: unknown; code?: unknown };
  if (typeof errorNum !== 'number') {
    return text;
  }
  return `ArangoDB error ${errorNum}${typeof code === 'number' ? ` (HTTP ${code})` : ''}: ${text}`;
}

/** A per-document failure inside a batch answer, as `arangojs` returns them. */
interface BatchFailure {
  error: true;
  errorNum: number;
  errorMessage?: string;
  code?: number;
}

function isBatchFailure(result: unknown): result is BatchFailure {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as { error?: unknown }).error === true
  );
}

/**
 * Stores each entry as an ArangoDB document whose `_key` is the entry's UUID,
 * with `code`, `message`, `cause`, `source`, `occurred_at` and `created_at`.
 * `cause` is stored as real JSON, not a string.
 *
 * Because the key is the entry id, logging the same entry again is a no-op:
 * documents are inserted with `overwriteMode: 'ignore'` (ArangoDB 3.7 and
 * newer), and on older servers the "key already exists" error is treated as
 * success. The first write is kept, so a retry after a timeout never stores an
 * entry twice.
 *
 * The collection has to exist (`await db.createCollection('error_log')`). A
 * missing collection, a bad login or an unreachable server comes back as
 * `ok: false` with ArangoDB's error number and message.
 *
 * `logBatch` writes a batch with one request (`saveAll`), which
 * `BatchingErrorAdapter` uses when it wraps this adapter.
 */
export class ArangoDbErrorAdapter<
  TCode extends string = string,
> implements ErrorLogAdapter<TCode> {
  private readonly logPrefix: string;
  private readonly timeoutMs: number;

  /** @throws {RangeError} if `timeoutMs` is invalid. */
  constructor(
    private readonly collection: ArangoCollectionLike,
    options: ArangoDbErrorOptions = {}
  ) {
    this.logPrefix = options.prefix ?? DEFAULT_PREFIX;
    this.timeoutMs = resolveTimeoutMs(
      options.timeoutMs,
      'ArangoDbErrorAdapter'
    );
  }

  async log(entry: ErrorLogEntry<TCode>): Promise<ErrorLogResult> {
    try {
      const document: ArangoDocument = this.toDocument(entry);
      try {
        await withTimeout(
          (): Promise<unknown> =>
            this.collection.save(document, { overwriteMode: 'ignore' }),
          this.timeoutMs,
          timeoutMessage('ArangoDB', this.timeoutMs)
        );
      } catch (error: unknown) {
        if (!isKeyConflict(error)) {
          throw error;
        }
      }
      return { ok: true };
    } catch (error: unknown) {
      return reportFailure({
        adapterName: 'ArangoDbErrorAdapter',
        prefix: this.logPrefix,
        action: 'to write a document',
        error,
        reason: describeArangoError(error),
      });
    }
  }

  /**
   * Writes several entries with one request. Every entry is checked first, so
   * one that cannot be stored (an invalid `id` or `timestamp`) fails the whole
   * call and nothing is written. ArangoDB then answers per document: keys that
   * already exist count as stored, and if any other document is refused the
   * error says how many were stored and why the others were not. Trying the
   * batch again is safe.
   */
  async logBatch(entries: ErrorLogEntry<TCode>[]): Promise<ErrorLogResult> {
    if (entries.length === 0) {
      return { ok: true };
    }
    const count: number = entries.length;
    try {
      const documents: ArangoDocument[] = [];
      for (const [index, entry] of entries.entries()) {
        try {
          documents.push(this.toDocument(entry));
        } catch (error: unknown) {
          throw new Error(
            `${describeError(error)} (entry ${index} could not be prepared, so nothing was written)`
          );
        }
      }
      const results: unknown[] = await withTimeout(
        (): Promise<unknown[]> =>
          this.collection.saveAll(documents, { overwriteMode: 'ignore' }),
        this.timeoutMs,
        timeoutMessage('ArangoDB', this.timeoutMs)
      );
      const refused: BatchFailure[] = (
        Array.isArray(results) ? results : []
      ).filter(
        (result: unknown): result is BatchFailure =>
          isBatchFailure(result) && !isKeyConflict(result)
      );
      if (refused.length > 0) {
        const reasons: string = refused
          .slice(0, 3)
          .map(
            (result: BatchFailure): string =>
              `error ${result.errorNum}${result.errorMessage === undefined ? '' : ` (${result.errorMessage})`}`
          )
          .join('; ');
        throw new Error(
          `ArangoDB refused ${refused.length} of ${count} documents, so ${count - refused.length} were stored: ${reasons}${refused.length > 3 ? '; and more' : ''}`
        );
      }
      return { ok: true };
    } catch (error: unknown) {
      return reportFailure({
        adapterName: 'ArangoDbErrorAdapter',
        prefix: this.logPrefix,
        action: `to write ${count} document${count === 1 ? '' : 's'}`,
        error,
        reason: describeArangoError(error),
      });
    }
  }

  private toDocument(entry: ErrorLogEntry<TCode>): ArangoDocument {
    const serialized = serializeEntry(entry);
    const occurredAt: Date = new Date(serialized.timestamp);
    if (Number.isNaN(occurredAt.getTime())) {
      throw new RangeError(
        `timestamp "${serialized.timestamp}" is not a valid ISO 8601 date`
      );
    }
    const document: ArangoDocument = {
      _key: resolveEntryId(entry),
      code: serialized.code,
      message: serialized.message,
      occurred_at: occurredAt.toISOString(),
      created_at: new Date().toISOString(),
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
