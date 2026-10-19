import type {
  ErrorLogAdapter,
  ErrorLogEntry,
  ErrorLogResult,
} from '@richardmcquiston01/error-log-adapter';
import { serializeEntry } from '@richardmcquiston01/error-log-adapter';
import {
  DEFAULT_PREFIX,
  assertIdentifier,
  describeError,
  reportFailure,
  resolveEntryId,
  resolveTimeoutMs,
  timeoutMessage,
  withTimeout,
} from '@richardmcquiston01/error-log-adapter/kit';

/** Node label used when the `label` option is not given. */
export const DEFAULT_LABEL = 'ErrorLog';

/** Query parameters: plain values only (strings, here). */
export type Neo4jParameters = Record<string, unknown>;

export interface Neo4jExecuteQueryConfigLike {
  /** Database to run in. Defaults to the user's home database. */
  database?: string;
  /** Always `WRITE` here (the value of `neo4j.routing.WRITE`). */
  routing?: 'WRITE';
}

/**
 * What this adapter needs from a Neo4j driver: `executeQuery`, which runs one
 * query in a managed transaction and retries it on transient failures. The
 * `Driver` from `neo4j-driver` (`neo4j.driver(url, auth)`) fits as it is.
 */
export interface Neo4jDriverLike {
  executeQuery(
    query: string,
    parameters?: Neo4jParameters,
    config?: Neo4jExecuteQueryConfigLike
  ): Promise<unknown>;
}

export interface Neo4jErrorOptions {
  /** Node label. Defaults to `ErrorLog`. Letters, digits and `_` only. */
  label?: string;
  /** Database to write to, when not the user's home database. */
  database?: string;
  /** Create the uniqueness constraint and the time index on first use. Defaults to `true`. */
  createSchema?: boolean;
  /** Text printed before failure messages. Defaults to `[error-log-adapter]`. */
  prefix?: string;
  /**
   * How long `log` waits for each Neo4j request, in milliseconds. Defaults to
   * 10000. Pass `Infinity` to wait without limit. The request cannot be
   * cancelled, so it may still finish after `log` has returned a failure.
   */
  timeoutMs?: number;
}

/** `ErrorLog` becomes `ErrorLog` (with backticks), after checking it cannot alter a statement. */
function quoteLabel(label: string, owner: string): string {
  assertIdentifier(label, 'node label', owner);
  return `\`${label}\``;
}

/**
 * The statements that make writes safe and reads fast: a uniqueness constraint
 * on `id` (what `MERGE` relies on, and what makes a repeat of an entry a no-op)
 * and an index on `occurred_at`. Uses the `IF NOT EXISTS` syntax of Neo4j 4.4
 * and 5. Run them yourself when `createSchema` is off.
 */
export function buildNeo4jSchemaStatements(
  label: string = DEFAULT_LABEL
): string[] {
  const quoted: string = quoteLabel(label, 'buildNeo4jSchemaStatements');
  const base: string = label.toLowerCase();
  return [
    `CREATE CONSTRAINT \`${base}_id\` IF NOT EXISTS FOR (e:${quoted}) REQUIRE e.id IS UNIQUE`,
    `CREATE INDEX \`${base}_occurred_at\` IF NOT EXISTS FOR (e:${quoted}) ON (e.occurred_at)`,
  ];
}

/**
 * The query for one entry. `MERGE` on `id` creates the node once; the
 * properties are set only `ON CREATE`, so a repeat leaves the first node as it
 * was. `cause` is a JSON string and `source` may be null (a null property is
 * simply not stored).
 */
export function buildNeo4jInsertStatement(
  label: string = DEFAULT_LABEL
): string {
  return (
    `MERGE (e:${quoteLabel(label, 'buildNeo4jInsertStatement')} {id: $id}) ` +
    'ON CREATE SET e.code = $code, e.message = $message, e.cause = $cause, ' +
    'e.source = $source, e.occurred_at = datetime($occurred_at), ' +
    'e.created_at = datetime()'
  );
}

/** The same as `buildNeo4jInsertStatement`, for a list of entries in `$entries`, in one transaction. */
export function buildNeo4jBatchStatement(
  label: string = DEFAULT_LABEL
): string {
  return (
    'UNWIND $entries AS entry ' +
    `MERGE (e:${quoteLabel(label, 'buildNeo4jBatchStatement')} {id: entry.id}) ` +
    'ON CREATE SET e.code = entry.code, e.message = entry.message, ' +
    'e.cause = entry.cause, e.source = entry.source, ' +
    'e.occurred_at = datetime(entry.occurred_at), e.created_at = datetime()'
  );
}

interface EntryParameters extends Neo4jParameters {
  id: string;
  code: string;
  message: string;
  cause: string | null;
  source: string | null;
  occurred_at: string;
}

/**
 * Stores each entry as a node `(:ErrorLog {id, code, message, cause, source,
 * occurred_at, created_at})`, created with `MERGE` on `id`. `occurred_at` and
 * `created_at` are Neo4j `datetime` values, so time-range queries work; `cause`
 * is a JSON string (a property cannot hold a map). Nodes are standalone: relate
 * them to your own nodes with a later query.
 *
 * Logging the same entry again is harmless: `MERGE` finds the node by its `id`
 * and `ON CREATE` leaves the first one untouched, so a retry after a timeout
 * never stores an entry twice. This relies on the uniqueness constraint
 * (`createSchema`, on by default), which also keeps two concurrent writers from
 * creating the node twice.
 *
 * Writes go through `driver.executeQuery`, which retries transient failures
 * (a leader change, a deadlock). `logBatch` writes a whole batch in one query
 * and one transaction, so the batch is stored completely or not at all, which
 * `BatchingErrorAdapter` uses when it wraps this adapter.
 */
export class Neo4jErrorAdapter<
  TCode extends string = string,
> implements ErrorLogAdapter<TCode> {
  private readonly label: string;
  private readonly database: string | undefined;
  private readonly createSchema: boolean;
  private readonly logPrefix: string;
  private readonly timeoutMs: number;
  private readonly insertQuery: string;
  private readonly batchQuery: string;
  private schemaReady: Promise<void> | null = null;

  /** @throws {RangeError} if `label` is not a plain identifier or `timeoutMs` is invalid. */
  constructor(
    private readonly driver: Neo4jDriverLike,
    options: Neo4jErrorOptions = {}
  ) {
    this.label = options.label ?? DEFAULT_LABEL;
    this.database = options.database;
    this.createSchema = options.createSchema ?? true;
    this.logPrefix = options.prefix ?? DEFAULT_PREFIX;
    this.timeoutMs = resolveTimeoutMs(options.timeoutMs, 'Neo4jErrorAdapter');
    assertIdentifier(this.label, 'node label', 'Neo4jErrorAdapter');
    this.insertQuery = buildNeo4jInsertStatement(this.label);
    this.batchQuery = buildNeo4jBatchStatement(this.label);
  }

  async log(entry: ErrorLogEntry<TCode>): Promise<ErrorLogResult> {
    try {
      const parameters: EntryParameters = this.toParameters(entry);
      await this.ensureSchema();
      await this.run(this.insertQuery, parameters);
      return { ok: true };
    } catch (error: unknown) {
      return reportFailure({
        adapterName: 'Neo4jErrorAdapter',
        prefix: this.logPrefix,
        action: `to write an :${this.label} node`,
        error,
      });
    }
  }

  /**
   * Writes several entries in one query and one transaction. Every entry is
   * checked first, so one that cannot be stored (an invalid `id` or
   * `timestamp`) fails the whole call and nothing is written. Entries that
   * already exist are left as they are.
   */
  async logBatch(entries: ErrorLogEntry<TCode>[]): Promise<ErrorLogResult> {
    if (entries.length === 0) {
      return { ok: true };
    }
    const count: number = entries.length;
    try {
      const rows: EntryParameters[] = [];
      for (const [index, entry] of entries.entries()) {
        try {
          rows.push(this.toParameters(entry));
        } catch (error: unknown) {
          throw new Error(
            `${describeError(error)} (entry ${index} could not be prepared, so nothing was written)`
          );
        }
      }
      await this.ensureSchema();
      await this.run(this.batchQuery, { entries: rows });
      return { ok: true };
    } catch (error: unknown) {
      return reportFailure({
        adapterName: 'Neo4jErrorAdapter',
        prefix: this.logPrefix,
        action: `to write ${count} :${this.label} node${count === 1 ? '' : 's'}`,
        error,
      });
    }
  }

  private toParameters(entry: ErrorLogEntry<TCode>): EntryParameters {
    const serialized = serializeEntry(entry);
    const occurredAt: Date = new Date(serialized.timestamp);
    if (Number.isNaN(occurredAt.getTime())) {
      throw new RangeError(
        `timestamp "${serialized.timestamp}" is not a valid ISO 8601 date`
      );
    }
    return {
      id: resolveEntryId(entry),
      code: serialized.code,
      message: serialized.message,
      cause:
        serialized.cause === undefined
          ? null
          : JSON.stringify(serialized.cause),
      source: serialized.source ?? null,
      occurred_at: occurredAt.toISOString(),
    };
  }

  /** Runs one write query, giving up waiting after `timeoutMs`. */
  private run(query: string, parameters: Neo4jParameters): Promise<unknown> {
    return withTimeout(
      (): Promise<unknown> =>
        this.driver.executeQuery(query, parameters, {
          routing: 'WRITE',
          ...(this.database !== undefined && { database: this.database }),
        }),
      this.timeoutMs,
      timeoutMessage('Neo4j', this.timeoutMs)
    );
  }

  /** Creates the constraint and the index once. A failed attempt is retried on the next call. */
  private ensureSchema(): Promise<void> {
    if (!this.createSchema) {
      return Promise.resolve();
    }
    if (this.schemaReady === null) {
      this.schemaReady = (async (): Promise<void> => {
        for (const statement of buildNeo4jSchemaStatements(this.label)) {
          await this.run(statement, {});
        }
      })().catch((error: unknown): never => {
        this.schemaReady = null;
        throw error;
      });
    }
    return this.schemaReady;
  }
}
