import { resolveEntryId } from '../entry-id.js';
import { describeError, serializeEntry } from '../serialize.js';
import type {
  ErrorLogAdapter,
  ErrorLogEntry,
  ErrorLogResult,
} from '../types.js';

/** Default table name. */
export const DEFAULT_TABLE_NAME = 'error_log';

const IDENTIFIER_PATTERN: RegExp = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The only thing this adapter needs from a SQLite driver: run one statement
 * with positional (`?`) parameters. `bun:sqlite` already matches this shape.
 * Other drivers need a one-line wrapper, for example:
 *
 * ```ts
 * // better-sqlite3 or node:sqlite
 * const client: SqliteClientLike = {
 *   run: (sql, params) => db.prepare(sql).run(...params),
 * };
 * ```
 */
export interface SqliteClientLike {
  run(sql: string, params: unknown[]): unknown;
}

export interface SqliteErrorOptions {
  /** Table to write to. Defaults to `error_log`. Letters, digits and `_` only. */
  tableName?: string;
  /** Create the table (and index) on first use. Defaults to `true`. */
  createTable?: boolean;
  /** Text printed before failure messages. Defaults to `[error-log-adapter]`. */
  prefix?: string;
}

/** Throws a descriptive error unless `tableName` is a plain SQL identifier. */
function assertValidTableName(tableName: string): void {
  if (!IDENTIFIER_PATTERN.test(tableName)) {
    throw new RangeError(
      `SqliteErrorAdapter: invalid table name "${tableName}". Use only letters, digits and underscores, and do not start with a digit.`
    );
  }
}

/**
 * Returns the statements that create the error log table and its index.
 * Use this to run your own migration when `createTable` is disabled.
 */
export function buildCreateErrorLogTableSql(
  tableName: string = DEFAULT_TABLE_NAME
): string[] {
  assertValidTableName(tableName);
  return [
    `CREATE TABLE IF NOT EXISTS ${tableName} (` +
      'id TEXT PRIMARY KEY NOT NULL, ' +
      'code TEXT NOT NULL, ' +
      'message TEXT NOT NULL, ' +
      'cause TEXT, ' +
      'source TEXT, ' +
      'occurred_at TEXT NOT NULL, ' +
      "created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))" +
      ')',
    `CREATE INDEX IF NOT EXISTS ${tableName}_occurred_at_idx ON ${tableName} (occurred_at)`,
  ];
}

export class SqliteErrorAdapter<
  TCode extends string = string,
> implements ErrorLogAdapter<TCode> {
  private readonly tableName: string;
  private readonly createTable: boolean;
  private readonly prefix: string;
  private tableReady: Promise<void> | null = null;

  /** @throws {RangeError} if `options.tableName` is not a plain identifier. */
  constructor(
    private readonly client: SqliteClientLike,
    options: SqliteErrorOptions = {}
  ) {
    this.tableName = options.tableName ?? DEFAULT_TABLE_NAME;
    assertValidTableName(this.tableName);
    this.createTable = options.createTable ?? true;
    this.prefix = options.prefix ?? '[error-log-adapter]';
  }

  async log(entry: ErrorLogEntry<TCode>): Promise<ErrorLogResult> {
    try {
      await this.ensureTable();
      const serialized = serializeEntry(entry);
      await this.client.run(
        `INSERT INTO ${this.tableName} (id, code, message, cause, source, occurred_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
        [
          resolveEntryId(entry),
          serialized.code,
          serialized.message,
          serialized.cause === undefined
            ? null
            : JSON.stringify(serialized.cause),
          serialized.source ?? null,
          serialized.timestamp,
        ]
      );
      return { ok: true };
    } catch (error: unknown) {
      console.error(`${this.prefix} SqliteErrorAdapter:`, error);
      return {
        ok: false,
        error: `SqliteErrorAdapter failed to write to table "${this.tableName}": ${describeError(error)}`,
      };
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
    for (const sql of buildCreateErrorLogTableSql(this.tableName)) {
      await this.client.run(sql, []);
    }
  }
}
