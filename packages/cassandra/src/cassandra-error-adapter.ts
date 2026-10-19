import type {
  ErrorLogAdapter,
  ErrorLogEntry,
  ErrorLogResult,
} from '@richardmcquiston01/error-log-adapter';
import { serializeEntry } from '@richardmcquiston01/error-log-adapter';
import {
  DEFAULT_PREFIX,
  DEFAULT_TABLE_NAME,
  assertIdentifier,
  describeError,
  reportFailure,
  resolveEntryId,
  resolveTimeoutMs,
  timeoutMessage,
  withTimeout,
} from '@richardmcquiston01/error-log-adapter/kit';

/** How long a partition covers. Smaller buckets mean smaller partitions and more of them to read for a long range. */
export type CassandraBucket = 'hour' | 'day' | 'month';

export interface CassandraQueryOptionsLike {
  prepare?: boolean;
  /** `false` sends an unlogged batch. */
  logged?: boolean;
  /** A consistency level from the driver's `types.consistencies`. */
  consistency?: number;
}

export interface CassandraStatementLike {
  query: string;
  params?: unknown[];
}

/**
 * What this adapter needs from a Cassandra client: `execute` and `batch`. The
 * `Client` from `cassandra-driver` fits as it is. The keyspace must exist.
 */
export interface CassandraClientLike {
  execute(
    query: string,
    params?: unknown[],
    options?: CassandraQueryOptionsLike
  ): Promise<unknown>;
  batch(
    queries: CassandraStatementLike[],
    options?: CassandraQueryOptionsLike
  ): Promise<unknown>;
}

export interface CassandraTableDdlOptions {
  /** Keyspace to put the table in. Defaults to the client's keyspace. */
  keyspace?: string;
}

export interface CassandraErrorOptions extends CassandraTableDdlOptions {
  /** Table to write to. Defaults to `error_log`. Letters, digits and `_`, starting with a letter. */
  tableName?: string;
  /** Create the table on first use. Defaults to `true`. */
  createTable?: boolean;
  /** Partition size: one partition per `hour`, `day` or `month` (UTC). Defaults to `day`. */
  bucket?: CassandraBucket;
  /** Delete rows this many seconds after they are written. Keeps rows forever by default. */
  ttlSeconds?: number;
  /** Consistency level for every write, such as `types.consistencies.localQuorum`. Defaults to the client's. */
  consistency?: number;
  /** Most rows in one batch statement, in `logBatch`. Defaults to 20. */
  maxBatchSize?: number;
  /** Text printed before failure messages. Defaults to `[error-log-adapter]`. */
  prefix?: string;
  /**
   * How long `log` waits for each Cassandra request, in milliseconds. Defaults
   * to 10000. Pass `Infinity` to wait without limit. The request cannot be
   * cancelled, so it may still finish after `log` has returned a failure.
   */
  timeoutMs?: number;
}

const DEFAULT_BUCKET: CassandraBucket = 'day';
const DEFAULT_MAX_BATCH_SIZE = 20;

/** Cassandra identifiers start with a letter. */
function assertCassandraIdentifier(
  value: string,
  label: string,
  owner: string
): void {
  assertIdentifier(value, label, owner);
  if (!/^[A-Za-z]/.test(value)) {
    throw new RangeError(
      `${owner}: invalid ${label} "${value}". Cassandra names must start with a letter.`
    );
  }
}

function qualified(keyspace: string | undefined, table: string): string {
  return keyspace === undefined ? table : `${keyspace}.${table}`;
}

/**
 * The partition key for a time: `2026-10-19` for a day, `2026-10-19T05` for an
 * hour, `2026-10` for a month, all in UTC.
 */
export function bucketFor(date: Date, bucket: CassandraBucket): string {
  const iso: string = date.toISOString();
  return bucket === 'hour'
    ? iso.slice(0, 13)
    : bucket === 'day'
      ? iso.slice(0, 10)
      : iso.slice(0, 7);
}

/**
 * Returns the statement that creates the error log table. Use it to run your
 * own migration when `createTable` is off.
 *
 * Rows are grouped into partitions by time bucket (`bucket`), newest first
 * inside a partition, so "the latest errors" is a read of one partition and no
 * partition grows without bound.
 */
export function buildCassandraTableDdl(
  tableName: string = DEFAULT_TABLE_NAME,
  options: CassandraTableDdlOptions = {}
): string {
  assertCassandraIdentifier(tableName, 'table name', 'buildCassandraTableDdl');
  if (options.keyspace !== undefined) {
    assertCassandraIdentifier(
      options.keyspace,
      'keyspace name',
      'buildCassandraTableDdl'
    );
  }
  return (
    `CREATE TABLE IF NOT EXISTS ${qualified(options.keyspace, tableName)} (` +
    'bucket text, ' +
    'occurred_at timestamp, ' +
    'id uuid, ' +
    'code text, ' +
    'message text, ' +
    'cause text, ' +
    'source text, ' +
    'created_at timestamp, ' +
    'PRIMARY KEY ((bucket), occurred_at, id)' +
    ') WITH CLUSTERING ORDER BY (occurred_at DESC, id ASC)'
  );
}

interface PreparedRow {
  bucket: string;
  statement: CassandraStatementLike;
}

/**
 * Writes each entry as a row of an `error_log` table (`bucket`, `occurred_at`,
 * `id`, `code`, `message`, `cause`, `source`, `created_at`), created on first
 * use. `cause` is stored as a JSON string. `cause` and `source` are left out of
 * the statement when the entry has none, so no tombstones are written.
 *
 * The primary key is `((bucket), occurred_at, id)`. A Cassandra insert is an
 * upsert, so logging the same entry again (same `id` and `timestamp`) rewrites
 * the same row with the same data, and a retry never duplicates. Only
 * `created_at` changes. A retry without a fixed `timestamp` gets a new time and
 * is a second row.
 *
 * `log` resolves once the write meets the consistency level (the client's
 * default, or `consistency`). `logBatch` groups rows by partition, sends each
 * group as unlogged batches of up to `maxBatchSize` rows, and runs the groups
 * together, which `BatchingErrorAdapter` uses when it wraps this adapter.
 */
export class CassandraErrorAdapter<
  TCode extends string = string,
> implements ErrorLogAdapter<TCode> {
  private readonly tableName: string;
  private readonly keyspace: string | undefined;
  private readonly createTable: boolean;
  private readonly bucket: CassandraBucket;
  private readonly ttlSeconds: number | undefined;
  private readonly queryOptions: CassandraQueryOptionsLike;
  private readonly maxBatchSize: number;
  private readonly logPrefix: string;
  private readonly timeoutMs: number;
  private tableReady: Promise<void> | null = null;

  /** @throws {RangeError} if a name is not a plain identifier, `bucket` is not `hour`, `day` or `month`, `ttlSeconds` or `maxBatchSize` is not a positive whole number, or `timeoutMs` is invalid. */
  constructor(
    private readonly client: CassandraClientLike,
    options: CassandraErrorOptions = {}
  ) {
    const owner = 'CassandraErrorAdapter';
    this.tableName = options.tableName ?? DEFAULT_TABLE_NAME;
    this.keyspace = options.keyspace;
    this.createTable = options.createTable ?? true;
    this.bucket = options.bucket ?? DEFAULT_BUCKET;
    this.ttlSeconds = options.ttlSeconds;
    this.maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    this.logPrefix = options.prefix ?? DEFAULT_PREFIX;
    this.timeoutMs = resolveTimeoutMs(options.timeoutMs, owner);
    assertCassandraIdentifier(this.tableName, 'table name', owner);
    if (this.keyspace !== undefined) {
      assertCassandraIdentifier(this.keyspace, 'keyspace name', owner);
    }
    if (!['hour', 'day', 'month'].includes(this.bucket)) {
      throw new RangeError(
        `${owner}: bucket must be hour, day or month, received ${JSON.stringify(this.bucket)}.`
      );
    }
    if (
      this.ttlSeconds !== undefined &&
      (!Number.isInteger(this.ttlSeconds) || this.ttlSeconds < 1)
    ) {
      throw new RangeError(
        `${owner}: ttlSeconds must be a whole number of seconds, at least 1, received ${String(this.ttlSeconds)}.`
      );
    }
    if (!Number.isInteger(this.maxBatchSize) || this.maxBatchSize < 1) {
      throw new RangeError(
        `${owner}: maxBatchSize must be a whole number, at least 1, received ${String(this.maxBatchSize)}.`
      );
    }
    this.queryOptions = {
      prepare: true,
      ...(options.consistency !== undefined && {
        consistency: options.consistency,
      }),
    };
  }

  async log(entry: ErrorLogEntry<TCode>): Promise<ErrorLogResult> {
    try {
      const row: PreparedRow = this.toRow(entry);
      await this.ensureTable();
      await withTimeout(
        (): Promise<unknown> =>
          this.client.execute(
            row.statement.query,
            row.statement.params,
            this.queryOptions
          ),
        this.timeoutMs,
        timeoutMessage('Cassandra', this.timeoutMs)
      );
      return { ok: true };
    } catch (error: unknown) {
      return reportFailure({
        adapterName: 'CassandraErrorAdapter',
        prefix: this.logPrefix,
        action: `to write to table ${qualified(this.keyspace, this.tableName)}`,
        error,
      });
    }
  }

  /**
   * Writes several entries. Every entry is checked first, so one that cannot be
   * stored (an invalid `id` or `timestamp`) fails the whole call and nothing is
   * written. Rows are then grouped by partition and sent as unlogged batches of
   * up to `maxBatchSize` rows, all at once. If some batches fail, the error
   * says how many rows were stored; trying the whole batch again is safe,
   * because a repeated row is rewritten with the same data.
   */
  async logBatch(entries: ErrorLogEntry<TCode>[]): Promise<ErrorLogResult> {
    if (entries.length === 0) {
      return { ok: true };
    }
    const count: number = entries.length;
    const target: string = qualified(this.keyspace, this.tableName);
    try {
      const rows: PreparedRow[] = [];
      for (const [index, entry] of entries.entries()) {
        try {
          rows.push(this.toRow(entry));
        } catch (error: unknown) {
          throw new Error(
            `${describeError(error)} (entry ${index} could not be prepared, so nothing was written)`
          );
        }
      }
      await this.ensureTable();
      const chunks: PreparedRow[][] = this.chunk(rows);
      const outcomes: PromiseSettledResult<unknown>[] =
        await Promise.allSettled(
          chunks.map((chunk: PreparedRow[]): Promise<unknown> =>
            this.send(chunk.map((row: PreparedRow) => row.statement))
          )
        );
      let stored = 0;
      let firstFailure: unknown;
      let failed = 0;
      outcomes.forEach(
        (outcome: PromiseSettledResult<unknown>, index: number): void => {
          if (outcome.status === 'fulfilled') {
            stored += (chunks[index] as PreparedRow[]).length;
          } else {
            failed += 1;
            firstFailure ??= outcome.reason;
          }
        }
      );
      if (failed > 0) {
        throw new Error(
          `${describeError(firstFailure)} (${stored} of ${count} entries were stored; ${failed} of ${chunks.length} batches failed)`
        );
      }
      return { ok: true };
    } catch (error: unknown) {
      return reportFailure({
        adapterName: 'CassandraErrorAdapter',
        prefix: this.logPrefix,
        action: `to write ${count} entr${count === 1 ? 'y' : 'ies'} to table ${target}`,
        error,
      });
    }
  }

  /** Groups rows by partition, then splits each group into batches of at most `maxBatchSize`. */
  private chunk(rows: PreparedRow[]): PreparedRow[][] {
    const byBucket = new Map<string, PreparedRow[]>();
    for (const row of rows) {
      const group: PreparedRow[] = byBucket.get(row.bucket) ?? [];
      group.push(row);
      byBucket.set(row.bucket, group);
    }
    const chunks: PreparedRow[][] = [];
    for (const group of byBucket.values()) {
      for (let start = 0; start < group.length; start += this.maxBatchSize) {
        chunks.push(group.slice(start, start + this.maxBatchSize));
      }
    }
    return chunks;
  }

  /** Sends one chunk: a single row as a plain statement, several as an unlogged batch. */
  private send(statements: CassandraStatementLike[]): Promise<unknown> {
    return withTimeout(
      (): Promise<unknown> =>
        statements.length === 1
          ? this.client.execute(
              (statements[0] as CassandraStatementLike).query,
              (statements[0] as CassandraStatementLike).params,
              this.queryOptions
            )
          : this.client.batch(statements, {
              ...this.queryOptions,
              logged: false,
            }),
      this.timeoutMs,
      timeoutMessage('Cassandra', this.timeoutMs)
    );
  }

  private toRow(entry: ErrorLogEntry<TCode>): PreparedRow {
    const serialized = serializeEntry(entry);
    const occurredAt: Date = new Date(serialized.timestamp);
    if (Number.isNaN(occurredAt.getTime())) {
      throw new RangeError(
        `timestamp "${serialized.timestamp}" is not a valid ISO 8601 date`
      );
    }
    const bucket: string = bucketFor(occurredAt, this.bucket);
    const columns: string[] = [
      'bucket',
      'occurred_at',
      'id',
      'code',
      'message',
    ];
    const params: unknown[] = [
      bucket,
      occurredAt,
      resolveEntryId(entry),
      serialized.code,
      serialized.message,
    ];
    if (serialized.cause !== undefined) {
      columns.push('cause');
      params.push(JSON.stringify(serialized.cause));
    }
    if (serialized.source !== undefined) {
      columns.push('source');
      params.push(serialized.source);
    }
    columns.push('created_at');
    params.push(new Date());
    const ttl: string =
      this.ttlSeconds === undefined ? '' : ` USING TTL ${this.ttlSeconds}`;
    const query: string =
      `INSERT INTO ${qualified(this.keyspace, this.tableName)} (${columns.join(', ')}) ` +
      `VALUES (${columns.map((): string => '?').join(', ')})${ttl}`;
    return { bucket, statement: { query, params } };
  }

  /** Creates the table once. A failed attempt is retried on the next call. */
  private ensureTable(): Promise<void> {
    if (!this.createTable) {
      return Promise.resolve();
    }
    if (this.tableReady === null) {
      const query: string = buildCassandraTableDdl(this.tableName, {
        ...(this.keyspace !== undefined && { keyspace: this.keyspace }),
      });
      this.tableReady = withTimeout(
        (): Promise<unknown> => this.client.execute(query),
        this.timeoutMs,
        timeoutMessage('Cassandra', this.timeoutMs)
      ).then(
        (): void => undefined,
        (error: unknown): never => {
          this.tableReady = null;
          throw error;
        }
      );
    }
    return this.tableReady;
  }
}
