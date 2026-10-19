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

/** A ClickHouse setting value: the plain kinds the client accepts. */
export type ClickHouseSettingValue = string | number | boolean | undefined;

/** One row as this adapter inserts it (`created_at` is filled in by the table). */
export interface ClickHouseRow {
  id: string;
  code: string;
  message: string;
  /** The cause as a JSON string, or `null`. */
  cause: string | null;
  source: string | null;
  /** UTC, as `YYYY-MM-DD HH:MM:SS.mmm`. */
  occurred_at: string;
  [column: string]: unknown;
}

export interface ClickHouseInsertParamsLike {
  table: string;
  values: ClickHouseRow[];
  format: 'JSONEachRow';
  clickhouse_settings?: Record<string, ClickHouseSettingValue>;
}

export interface ClickHouseCommandParamsLike {
  query: string;
}

/**
 * What this adapter needs from a ClickHouse client: `insert` and `command`
 * (used only to create the table). The official `@clickhouse/client` client
 * (`createClient(...)`) fits as it is.
 */
export interface ClickHouseClientLike {
  insert(params: ClickHouseInsertParamsLike): Promise<unknown>;
  command(params: ClickHouseCommandParamsLike): Promise<unknown>;
}

export interface ClickHouseTableDdlOptions {
  /** Database to put the table in. Defaults to the client's database. */
  database?: string;
  /** Delete rows this many days after `occurred_at`. Keeps rows forever by default. */
  ttlDays?: number;
}

export interface ClickHouseErrorOptions extends ClickHouseTableDdlOptions {
  /** Table to write to. Defaults to `error_log`. Letters, digits and `_` only. */
  tableName?: string;
  /** Create the table on first use. Defaults to `true`. */
  createTable?: boolean;
  /**
   * ClickHouse settings sent with every insert. Defaults to
   * `{ async_insert: 1, wait_for_async_insert: 1 }`, which lets the server group
   * many small inserts into one part (what ClickHouse recommends for logging)
   * while `log` still waits until the data is stored. Pass `{}` for plain
   * synchronous inserts.
   */
  clickhouseSettings?: Record<string, ClickHouseSettingValue>;
  /** Text printed before failure messages. Defaults to `[error-log-adapter]`. */
  prefix?: string;
  /**
   * How long `log` waits for each ClickHouse request, in milliseconds. Defaults
   * to 10000. Pass `Infinity` to wait without limit. The request cannot be
   * cancelled, so it may still finish after `log` has returned a failure.
   */
  timeoutMs?: number;
}

const DEFAULT_SETTINGS: Record<string, ClickHouseSettingValue> = {
  async_insert: 1,
  wait_for_async_insert: 1,
};

function qualifiedName(database: string | undefined, table: string): string {
  return database === undefined
    ? `\`${table}\``
    : `\`${database}\`.\`${table}\``;
}

/** `db.table` or `table`, unquoted: both parts are validated identifiers. */
function plainName(database: string | undefined, table: string): string {
  return database === undefined ? table : `${database}.${table}`;
}

function validate(
  tableName: string,
  options: ClickHouseTableDdlOptions,
  owner: string
): void {
  assertIdentifier(tableName, 'table name', owner);
  if (options.database !== undefined) {
    assertIdentifier(options.database, 'database name', owner);
  }
  if (
    options.ttlDays !== undefined &&
    (!Number.isInteger(options.ttlDays) || options.ttlDays < 1)
  ) {
    throw new RangeError(
      `${owner}: ttlDays must be a whole number of days, at least 1, received ${String(options.ttlDays)}.`
    );
  }
}

/**
 * Returns the statement that creates the error log table. Use it to run your
 * own migration when `createTable` is off.
 *
 * The table is a `ReplacingMergeTree` ordered by `(occurred_at, id)` and
 * partitioned by month, so a row with the same time and `id` is collapsed to
 * one when ClickHouse merges parts (query with `FINAL` to see that at once).
 */
export function buildClickHouseTableDdl(
  tableName: string = DEFAULT_TABLE_NAME,
  options: ClickHouseTableDdlOptions = {}
): string {
  validate(tableName, options, 'buildClickHouseTableDdl');
  const ttl: string =
    options.ttlDays === undefined
      ? ''
      : ` TTL toDateTime(occurred_at) + INTERVAL ${options.ttlDays} DAY`;
  return (
    `CREATE TABLE IF NOT EXISTS ${qualifiedName(options.database, tableName)} (` +
    'id UUID, ' +
    'code String, ' +
    'message String, ' +
    'cause Nullable(String), ' +
    'source Nullable(String), ' +
    "occurred_at DateTime64(3, 'UTC'), " +
    "created_at DateTime64(3, 'UTC') DEFAULT now64(3)" +
    ') ENGINE = ReplacingMergeTree(created_at) ' +
    'PARTITION BY toYYYYMM(occurred_at) ' +
    `ORDER BY (occurred_at, id)${ttl}`
  );
}

/** `2026-10-19T05:00:00.123Z` becomes `2026-10-19 05:00:00.123`, which ClickHouse reads without extra settings. */
function toClickHouseDateTime(timestamp: string): string {
  const date: Date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(
      `timestamp "${timestamp}" is not a valid ISO 8601 date`
    );
  }
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

/**
 * Inserts each entry as a row in a ClickHouse `error_log` table (`id`, `code`,
 * `message`, `cause`, `source`, `occurred_at`, `created_at`), created on first
 * use. `cause` is stored as a JSON string.
 *
 * ClickHouse prefers a few large inserts to many small ones, so by default each
 * insert is sent with asynchronous inserts on (the server batches them, and
 * `log` still waits until the rows are stored; see `clickhouseSettings`). For
 * heavy traffic, put a `BatchingErrorAdapter` in front: `logBatch` writes a
 * whole batch in one insert.
 *
 * ClickHouse has no unique keys. A repeated entry (same `id` and same
 * `timestamp`) is collapsed at merge time by the table engine, so pass a fixed
 * `timestamp` along with the `id` when retrying, and query with `FINAL` when
 * exact counts matter. A retry without a `timestamp` gets a new one and is
 * stored as a separate row.
 */
export class ClickHouseErrorAdapter<
  TCode extends string = string,
> implements ErrorLogAdapter<TCode> {
  private readonly tableName: string;
  private readonly database: string | undefined;
  private readonly ttlDays: number | undefined;
  private readonly createTable: boolean;
  private readonly settings: Record<string, ClickHouseSettingValue>;
  private readonly logPrefix: string;
  private readonly timeoutMs: number;
  private tableReady: Promise<void> | null = null;

  /** @throws {RangeError} if the table or database name is not a plain identifier, `ttlDays` is not a whole number of days, or `timeoutMs` is invalid. */
  constructor(
    private readonly client: ClickHouseClientLike,
    options: ClickHouseErrorOptions = {}
  ) {
    this.tableName = options.tableName ?? DEFAULT_TABLE_NAME;
    this.database = options.database;
    this.ttlDays = options.ttlDays;
    this.createTable = options.createTable ?? true;
    this.settings = options.clickhouseSettings ?? DEFAULT_SETTINGS;
    this.logPrefix = options.prefix ?? DEFAULT_PREFIX;
    this.timeoutMs = resolveTimeoutMs(
      options.timeoutMs,
      'ClickHouseErrorAdapter'
    );
    validate(this.tableName, options, 'ClickHouseErrorAdapter');
  }

  async log(entry: ErrorLogEntry<TCode>): Promise<ErrorLogResult> {
    try {
      const row: ClickHouseRow = this.toRow(entry);
      await this.ensureTable();
      await this.insert([row]);
      return { ok: true };
    } catch (error: unknown) {
      return reportFailure({
        adapterName: 'ClickHouseErrorAdapter',
        prefix: this.logPrefix,
        action: `to write to table ${qualifiedName(this.database, this.tableName)}`,
        error,
      });
    }
  }

  /**
   * Writes several entries in a single insert, which `BatchingErrorAdapter`
   * uses when it wraps this adapter. Every entry is checked first, so one that
   * cannot be stored (an invalid `id` or `timestamp`) fails the whole call and
   * nothing is written. The insert is one block: ClickHouse stores all of its
   * rows or none.
   */
  async logBatch(entries: ErrorLogEntry<TCode>[]): Promise<ErrorLogResult> {
    if (entries.length === 0) {
      return { ok: true };
    }
    const count: number = entries.length;
    try {
      const rows: ClickHouseRow[] = [];
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
      await this.insert(rows);
      return { ok: true };
    } catch (error: unknown) {
      return reportFailure({
        adapterName: 'ClickHouseErrorAdapter',
        prefix: this.logPrefix,
        action: `to write ${count} entr${count === 1 ? 'y' : 'ies'} to table ${qualifiedName(this.database, this.tableName)}`,
        error,
      });
    }
  }

  private toRow(entry: ErrorLogEntry<TCode>): ClickHouseRow {
    const serialized = serializeEntry(entry);
    return {
      id: resolveEntryId(entry),
      code: serialized.code,
      message: serialized.message,
      cause:
        serialized.cause === undefined
          ? null
          : JSON.stringify(serialized.cause),
      source: serialized.source ?? null,
      occurred_at: toClickHouseDateTime(serialized.timestamp),
    };
  }

  /** Creates the table once. A failed attempt is retried on the next call. */
  private ensureTable(): Promise<void> {
    if (!this.createTable) {
      return Promise.resolve();
    }
    if (this.tableReady === null) {
      const query: string = buildClickHouseTableDdl(this.tableName, {
        ...(this.database !== undefined && { database: this.database }),
        ...(this.ttlDays !== undefined && { ttlDays: this.ttlDays }),
      });
      this.tableReady = withTimeout(
        (): Promise<unknown> => this.client.command({ query }),
        this.timeoutMs,
        timeoutMessage('ClickHouse', this.timeoutMs)
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

  private async insert(rows: ClickHouseRow[]): Promise<void> {
    await withTimeout(
      (): Promise<unknown> =>
        this.client.insert({
          table: plainName(this.database, this.tableName),
          values: rows,
          format: 'JSONEachRow',
          clickhouse_settings: this.settings,
        }),
      this.timeoutMs,
      timeoutMessage('ClickHouse', this.timeoutMs)
    );
  }
}
