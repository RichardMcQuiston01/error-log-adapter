import { generateId } from '../uuid.js';
import { describeError, serializeEntry } from '../serialize.js';
import type {
  ErrorLogAdapter,
  ErrorLogEntry,
  ErrorLogResult,
} from '../types.js';

/** Default table name. */
export const DEFAULT_TABLE_NAME = 'error_log';

/**
 * Longest allowed table name. The index name adds `_occurred_at_idx` (16
 * characters) and Postgres limits identifiers to 63.
 */
export const MAX_TABLE_NAME_LENGTH = 47;

const IDENTIFIER_PATTERN: RegExp = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type SqlDialect = 'postgres' | 'mysql';

/**
 * The only thing these adapters need from a database driver: run one
 * parameterized statement. `pg` (`Pool` / `Client`) and `mysql2/promise`
 * (`Pool` / `Connection`) both fit as they are.
 */
export interface SqlClientLike {
  query(sql: string, params: unknown[]): Promise<unknown>;
}

export interface SqlErrorOptions {
  /** Table to write to. Defaults to `error_log`. Letters, digits and `_` only, up to 47 characters. */
  tableName?: string;
  /** Create the table (and index) on first use. Defaults to `true`. */
  createTable?: boolean;
  /** Text printed before failure messages. Defaults to `[error-log-adapter]`. */
  prefix?: string;
}

/** Throws a descriptive error unless `tableName` is a short, plain SQL identifier. */
function assertValidTableName(tableName: string, adapterName: string): void {
  if (!IDENTIFIER_PATTERN.test(tableName)) {
    throw new RangeError(
      `${adapterName}: invalid table name "${tableName}". Use only letters, digits and underscores, and do not start with a digit.`
    );
  }
  if (tableName.length > MAX_TABLE_NAME_LENGTH) {
    throw new RangeError(
      `${adapterName}: table name "${tableName}" is ${tableName.length} characters long, but the limit is ${MAX_TABLE_NAME_LENGTH}.`
    );
  }
}

function quoteIdentifier(dialect: SqlDialect, identifier: string): string {
  return dialect === 'postgres' ? `"${identifier}"` : `\`${identifier}\``;
}

/**
 * Returns the statements that create the error log table and its index for a
 * dialect. Use this to run your own migration when `createTable` is disabled.
 *
 * Postgres gets a native `UUID` key, `JSONB` for the cause, and `TIMESTAMPTZ`
 * columns. MySQL gets a `CHAR(36)` UUID key (it has no UUID type), a `JSON`
 * cause, and `DATETIME(3)` columns holding UTC times.
 */
export function buildErrorLogTableDdl(
  dialect: SqlDialect,
  tableName: string = DEFAULT_TABLE_NAME
): string[] {
  assertValidTableName(tableName, 'buildErrorLogTableDdl');
  const table: string = quoteIdentifier(dialect, tableName);
  const index: string = quoteIdentifier(
    dialect,
    `${tableName}_occurred_at_idx`
  );
  if (dialect === 'postgres') {
    return [
      `CREATE TABLE IF NOT EXISTS ${table} (` +
        'id UUID PRIMARY KEY, ' +
        'code TEXT NOT NULL, ' +
        'message TEXT NOT NULL, ' +
        'cause JSONB, ' +
        'source TEXT, ' +
        'occurred_at TIMESTAMPTZ NOT NULL, ' +
        'created_at TIMESTAMPTZ NOT NULL DEFAULT now()' +
        ')',
      `CREATE INDEX IF NOT EXISTS ${index} ON ${table} (occurred_at)`,
    ];
  }
  // MySQL has no CREATE INDEX IF NOT EXISTS, so the index is part of the table.
  return [
    `CREATE TABLE IF NOT EXISTS ${table} (` +
      'id CHAR(36) NOT NULL PRIMARY KEY, ' +
      'code VARCHAR(255) NOT NULL, ' +
      'message TEXT NOT NULL, ' +
      'cause JSON NULL, ' +
      'source VARCHAR(255) NULL, ' +
      'occurred_at DATETIME(3) NOT NULL, ' +
      'created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ' +
      `INDEX ${index} (occurred_at)` +
      ')',
  ];
}

/** `2026-01-02T03:04:05.678Z` becomes `2026-01-02 03:04:05.678`, which MySQL accepts. */
function toMysqlDateTime(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

/** Shared by the Postgres and MySQL adapters: only the SQL text and time format differ. */
abstract class SqlErrorAdapter<
  TCode extends string = string,
> implements ErrorLogAdapter<TCode> {
  private readonly tableName: string;
  private readonly createTable: boolean;
  private readonly prefix: string;
  private tableReady: Promise<void> | null = null;

  protected constructor(
    private readonly client: SqlClientLike,
    private readonly dialect: SqlDialect,
    private readonly adapterName: string,
    options: SqlErrorOptions
  ) {
    this.tableName = options.tableName ?? DEFAULT_TABLE_NAME;
    assertValidTableName(this.tableName, adapterName);
    this.createTable = options.createTable ?? true;
    this.prefix = options.prefix ?? '[error-log-adapter]';
  }

  async log(entry: ErrorLogEntry<TCode>): Promise<ErrorLogResult> {
    try {
      const serialized = serializeEntry(entry);
      const occurredAt: Date = new Date(serialized.timestamp);
      if (Number.isNaN(occurredAt.getTime())) {
        throw new RangeError(
          `timestamp "${serialized.timestamp}" is not a valid ISO 8601 date`
        );
      }
      const params: unknown[] = [
        generateId(),
        serialized.code,
        serialized.message,
        serialized.cause === undefined
          ? null
          : JSON.stringify(serialized.cause),
        serialized.source ?? null,
        this.dialect === 'postgres'
          ? occurredAt.toISOString()
          : toMysqlDateTime(occurredAt),
      ];
      await this.ensureTable();
      await this.client.query(this.insertSql(), params);
      return { ok: true };
    } catch (error: unknown) {
      console.error(`${this.prefix} ${this.adapterName}:`, error);
      return {
        ok: false,
        error: `${this.adapterName} failed to write to table "${this.tableName}": ${describeError(error)}`,
      };
    }
  }

  private insertSql(): string {
    const placeholders: string =
      this.dialect === 'postgres'
        ? '$1, $2, $3, $4, $5, $6'
        : '?, ?, ?, ?, ?, ?';
    return `INSERT INTO ${quoteIdentifier(this.dialect, this.tableName)} (id, code, message, cause, source, occurred_at) VALUES (${placeholders})`;
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
    for (const sql of buildErrorLogTableDdl(this.dialect, this.tableName)) {
      await this.client.query(sql, []);
    }
  }
}

/**
 * Writes entries to Postgres. Pass a `pg` `Pool` or `Client`.
 *
 * ```ts
 * const adapter = new PostgresErrorAdapter(new Pool({ connectionString }));
 * ```
 */
export class PostgresErrorAdapter<
  TCode extends string = string,
> extends SqlErrorAdapter<TCode> {
  /** @throws {RangeError} if `options.tableName` is not a plain identifier of 47 characters or fewer. */
  constructor(client: SqlClientLike, options: SqlErrorOptions = {}) {
    super(client, 'postgres', 'PostgresErrorAdapter', options);
  }
}

/**
 * Writes entries to MySQL or MariaDB. Pass a `mysql2/promise` `Pool` or `Connection`.
 *
 * ```ts
 * const adapter = new MySqlErrorAdapter(mysql.createPool(connectionUri));
 * ```
 */
export class MySqlErrorAdapter<
  TCode extends string = string,
> extends SqlErrorAdapter<TCode> {
  /** @throws {RangeError} if `options.tableName` is not a plain identifier of 47 characters or fewer. */
  constructor(client: SqlClientLike, options: SqlErrorOptions = {}) {
    super(client, 'mysql', 'MySqlErrorAdapter', options);
  }
}
