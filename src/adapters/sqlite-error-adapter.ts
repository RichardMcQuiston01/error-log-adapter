import { DEFAULT_TABLE_NAME, assertIdentifier } from '../sql-ident.js';
import { SqlTableAdapter } from '../sql-table-adapter.js';
import type { SqlTableOptions } from '../sql-table-adapter.js';
import type { SerializedErrorLogEntry } from '../serialize.js';

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

export interface SqliteErrorOptions extends SqlTableOptions {
  /** Table to write to. Defaults to `error_log`. Letters, digits and `_` only. */
  tableName?: string;
}

/** Throws a descriptive error unless `tableName` is a plain SQL identifier. */
function assertValidTableName(tableName: string): void {
  assertIdentifier(tableName, 'table name', 'SqliteErrorAdapter');
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
> extends SqlTableAdapter<TCode> {
  /** @throws {RangeError} if `options.tableName` is not a plain identifier or `options.timeoutMs` is invalid. */
  constructor(
    private readonly client: SqliteClientLike,
    options: SqliteErrorOptions = {}
  ) {
    super('SqliteErrorAdapter', 'SQLite', options);
  }

  protected occurredAtParam(entry: SerializedErrorLogEntry): string {
    return entry.timestamp;
  }

  protected insertSql(): string {
    return `INSERT INTO ${this.tableName} (id, code, message, cause, source, occurred_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`;
  }

  protected createStatements(): string[] {
    return buildCreateErrorLogTableSql(this.tableName);
  }

  protected callDriver(sql: string, params: unknown[]): unknown {
    return this.client.run(sql, params);
  }
}
