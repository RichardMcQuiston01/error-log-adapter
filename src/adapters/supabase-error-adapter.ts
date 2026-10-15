import { hasCallerId, resolveEntryId } from '../entry-id.js';
import { describeError, serializeEntry } from '../serialize.js';
import type {
  ErrorLogAdapter,
  ErrorLogEntry,
  ErrorLogResult,
} from '../types.js';
import {
  DEFAULT_TABLE_NAME,
  buildErrorLogTableDdl,
} from './sql-error-adapter.js';

/** The row inserted for each entry. The columns match the Postgres adapter's table. */
export interface SupabaseErrorRow {
  /** UUID primary key. */
  id: string;
  code: string;
  message: string;
  /** The cause as JSON, or `null` when the entry has none. */
  cause: unknown;
  source: string | null;
  /** ISO 8601 timestamp of the entry. */
  occurred_at: string;
}

/** The error object `supabase-js` returns (a `PostgrestError`) instead of throwing. */
export interface SupabaseErrorLike {
  message: string;
  code?: string;
  details?: string | null;
  hint?: string | null;
}

/** What `insert` resolves to. The status fields are used when the error has no message. */
export interface SupabaseInsertResult {
  error: SupabaseErrorLike | null;
  status?: number;
  statusText?: string;
}

/**
 * The only thing the Supabase adapter needs from a client: `from(table).insert(row)`.
 * A `supabase-js` client (`createClient(url, key)`) fits as it is.
 */
export interface SupabaseClientLike {
  from(table: string): {
    insert(row: SupabaseErrorRow): PromiseLike<SupabaseInsertResult>;
  };
}

export interface SupabaseErrorOptions {
  /** Table to write to. Defaults to `error_log`. */
  tableName?: string;
  /** Text printed before failure messages. Defaults to `[error-log-adapter]`. */
  prefix?: string;
}

export interface SupabaseSetupOptions {
  /**
   * Postgres roles allowed to insert, for example `['anon', 'authenticated']`
   * when the browser logs with the public key. Leave empty when only a server
   * using the service role key logs: that role bypasses row level security.
   */
  insertRoles?: string[];
}

const IDENTIFIER_PATTERN: RegExp = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Returns the SQL to run once in the Supabase SQL editor: the error log table,
 * with row level security turned on (as Supabase recommends for every table in
 * an exposed schema) and, optionally, an insert-only policy for the given roles.
 * Nobody but the service role can read the log through the API.
 *
 * @throws {RangeError} if the table name or a role is not a plain identifier.
 */
export function buildSupabaseSetupSql(
  tableName: string = DEFAULT_TABLE_NAME,
  options: SupabaseSetupOptions = {}
): string[] {
  const insertRoles: string[] = options.insertRoles ?? [];
  for (const role of insertRoles) {
    if (!IDENTIFIER_PATTERN.test(role)) {
      throw new RangeError(
        `buildSupabaseSetupSql: invalid role name "${role}". Use only letters, digits and underscores, and do not start with a digit.`
      );
    }
  }
  const statements: string[] = [
    ...buildErrorLogTableDdl('postgres', tableName),
    `ALTER TABLE "${tableName}" ENABLE ROW LEVEL SECURITY`,
  ];
  if (insertRoles.length > 0) {
    const policy: string = `${tableName}_insert_only`;
    statements.push(
      `DROP POLICY IF EXISTS "${policy}" ON "${tableName}"`,
      `CREATE POLICY "${policy}" ON "${tableName}" FOR INSERT TO ${insertRoles.map((role: string): string => `"${role}"`).join(', ')} WITH CHECK (true)`
    );
  }
  return statements;
}

/**
 * Joins the parts of a Supabase error that are present into one message.
 * `supabase-js` can return an error with no message at all (an empty-bodied
 * 404 for a table the API cannot see, for example), so the HTTP status stands
 * in for it. Only the first line of `details` is kept, since network failures
 * put a full stack trace there.
 */
function describeSupabaseError(result: SupabaseInsertResult): string {
  const error: SupabaseErrorLike = result.error ?? { message: '' };
  const parts: string[] = [];
  if (error.message) {
    parts.push(error.message);
  } else if (result.status) {
    parts.push(
      `HTTP ${result.status}${result.statusText ? ` ${result.statusText}` : ''} with no error message (a 404 usually means the table does not exist or is not exposed by the API)`
    );
  } else {
    parts.push('unknown error with no message');
  }
  if (error.code) {
    parts.push(`code ${error.code}`);
  }
  const detailsLine: string = (error.details ?? '').split('\n')[0].trim();
  if (detailsLine && detailsLine !== error.message) {
    parts.push(`details: ${detailsLine}`);
  }
  if (error.hint) {
    parts.push(`hint: ${error.hint}`);
  }
  return parts.join('; ');
}

/**
 * Writes entries to a Supabase table through `supabase-js`. Create the table
 * first with `buildSupabaseSetupSql` (or `buildErrorLogTableDdl('postgres')`).
 *
 * ```ts
 * const adapter = new SupabaseErrorAdapter(createClient(url, serviceRoleKey));
 * ```
 *
 * `supabase-js` reports failures in a returned `error` field rather than
 * throwing; the adapter turns both that and a thrown error into `{ ok: false }`.
 */
export class SupabaseErrorAdapter<
  TCode extends string = string,
> implements ErrorLogAdapter<TCode> {
  private readonly tableName: string;
  private readonly prefix: string;

  /** @throws {RangeError} if `options.tableName` is empty. */
  constructor(
    private readonly client: SupabaseClientLike,
    options: SupabaseErrorOptions = {}
  ) {
    this.tableName = options.tableName ?? DEFAULT_TABLE_NAME;
    if (this.tableName.trim() === '') {
      throw new RangeError(
        'SupabaseErrorAdapter: tableName must not be empty.'
      );
    }
    this.prefix = options.prefix ?? '[error-log-adapter]';
  }

  async log(entry: ErrorLogEntry<TCode>): Promise<ErrorLogResult> {
    try {
      const serialized = serializeEntry(entry);
      const row: SupabaseErrorRow = {
        id: resolveEntryId(entry),
        code: serialized.code,
        message: serialized.message,
        cause: serialized.cause === undefined ? null : serialized.cause,
        source: serialized.source ?? null,
        occurred_at: serialized.timestamp,
      };
      const result: SupabaseInsertResult = await this.client
        .from(this.tableName)
        .insert(row);
      if (result.error) {
        if (hasCallerId(entry) && result.error.code === '23505') {
          // Unique violation on the id: this entry was stored by an earlier call.
          return { ok: true };
        }
        console.error(`${this.prefix} SupabaseErrorAdapter:`, result);
        return this.fail(describeSupabaseError(result));
      }
      return { ok: true };
    } catch (error: unknown) {
      console.error(`${this.prefix} SupabaseErrorAdapter:`, error);
      return this.fail(describeError(error));
    }
  }

  private fail(reason: string): ErrorLogResult {
    return {
      ok: false,
      error: `SupabaseErrorAdapter failed to insert into table "${this.tableName}": ${reason}`,
    };
  }
}
