import { DEFAULT_PREFIX, reportFailure } from './fail.js';
import { resolveEntryId } from './entry-id.js';
import { DEFAULT_TABLE_NAME, assertIdentifier } from './sql-ident.js';
import { serializeEntry } from './serialize.js';
import type { SerializedErrorLogEntry } from './serialize.js';
import { resolveTimeoutMs, timeoutMessage, withTimeout } from './timeout.js';
import type {
  ErrorLogAdapter,
  ErrorLogEntry,
  ErrorLogResult,
} from './types.js';

/** The options every table-based SQL adapter shares. */
export interface SqlTableOptions {
  /** Table to write to. Defaults to `error_log`. Letters, digits and `_` only. */
  tableName?: string;
  /** Create the table (and index) on first use. Defaults to `true`. */
  createTable?: boolean;
  /** Text printed before failure messages. Defaults to `[error-log-adapter]`. */
  prefix?: string;
  /**
   * How long `log` waits for each database statement before giving up, in
   * milliseconds. Defaults to 10000. Pass `Infinity` to wait without limit. The
   * call cannot be cancelled, so it may still finish after `log` has returned a
   * failure.
   */
  timeoutMs?: number;
}

/**
 * What the Postgres, MySQL and SQLite adapters have in common: one `error_log`
 * table with the same six columns, created on first use, written with a single
 * `INSERT` per entry that keeps the stored row when an entry id repeats, and
 * every driver call limited by `timeoutMs`.
 *
 * A subclass supplies only what differs by database: the table DDL, the
 * `INSERT` text, how the entry time is written, and the driver call.
 */
export abstract class SqlTableAdapter<
  TCode extends string = string,
> implements ErrorLogAdapter<TCode> {
  /** Validated table name, for subclasses to put in their SQL. */
  protected readonly tableName: string;
  private readonly createTable: boolean;
  private readonly prefix: string;
  private readonly timeoutMs: number;
  private tableReady: Promise<void> | null = null;

  /**
   * @param adapterName Class name, for messages, such as `PostgresErrorAdapter`.
   * @param databaseName Name used in timeout messages, such as `Postgres`.
   * @param maxTableNameLength Longest table name the database allows for this adapter, if limited.
   * @throws {RangeError} if the table name or `timeoutMs` is invalid.
   */
  protected constructor(
    private readonly adapterName: string,
    private readonly databaseName: string,
    options: SqlTableOptions,
    maxTableNameLength?: number
  ) {
    this.tableName = options.tableName ?? DEFAULT_TABLE_NAME;
    assertIdentifier(
      this.tableName,
      'table name',
      adapterName,
      maxTableNameLength
    );
    this.createTable = options.createTable ?? true;
    this.prefix = options.prefix ?? DEFAULT_PREFIX;
    this.timeoutMs = resolveTimeoutMs(options.timeoutMs, adapterName);
  }

  /** The statements that create the table and its index. */
  protected abstract createStatements(): string[];

  /** The `INSERT` for one entry, with six parameters in the order of `log`'s row. */
  protected abstract insertSql(): string;

  /** The entry time as this database wants it. May throw for a time it cannot store. */
  protected abstract occurredAtParam(entry: SerializedErrorLogEntry): string;

  /** Hands one statement to the driver. May return a promise or a plain value. */
  protected abstract callDriver(sql: string, params: unknown[]): unknown;

  async log(entry: ErrorLogEntry<TCode>): Promise<ErrorLogResult> {
    try {
      const serialized: SerializedErrorLogEntry = serializeEntry(entry);
      const params: unknown[] = [
        resolveEntryId(entry),
        serialized.code,
        serialized.message,
        serialized.cause === undefined
          ? null
          : JSON.stringify(serialized.cause),
        serialized.source ?? null,
        this.occurredAtParam(serialized),
      ];
      await this.ensureTable();
      await this.execute(this.insertSql(), params);
      return { ok: true };
    } catch (error: unknown) {
      return reportFailure({
        adapterName: this.adapterName,
        prefix: this.prefix,
        action: `to write to table "${this.tableName}"`,
        error,
      });
    }
  }

  /** Creates the table once. A failed attempt is retried on the next log call. */
  private ensureTable(): Promise<void> {
    if (!this.createTable) {
      return Promise.resolve();
    }
    if (this.tableReady === null) {
      this.tableReady = this.runCreateStatements().catch(
        (error: unknown): never => {
          this.tableReady = null;
          throw error;
        }
      );
    }
    return this.tableReady;
  }

  private async runCreateStatements(): Promise<void> {
    for (const sql of this.createStatements()) {
      await this.execute(sql, []);
    }
  }

  /** Runs one statement, giving up waiting after `timeoutMs`. */
  private execute(sql: string, params: unknown[]): Promise<unknown> {
    return withTimeout(
      (): unknown => this.callDriver(sql, params),
      this.timeoutMs,
      timeoutMessage(this.databaseName, this.timeoutMs)
    );
  }
}
