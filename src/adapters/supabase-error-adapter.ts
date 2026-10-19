import { DEFAULT_PREFIX, reportFailure } from '../fail.js';
import { DEFAULT_TABLE_NAME, assertIdentifier } from '../sql-ident.js';
import { hasCallerId, resolveEntryId } from '../entry-id.js';
import { resolveTimeoutMs, timeoutMessage, withTimeout } from '../timeout.js';
import { describeError, serializeEntry } from '../serialize.js';
import type {
  ErrorLogAdapter,
  ErrorLogEntry,
  ErrorLogResult,
} from '../types.js';
import { buildErrorLogTableDdl } from './sql-error-adapter.js';

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
  /** Table to write to. Defaults to `error_log`. Letters, digits and `_` only. */
  tableName?: string;
  /** Text printed before failure messages. Defaults to `[error-log-adapter]`. */
  prefix?: string;
  /**
   * How long `log` waits for Supabase to answer before giving up, in milliseconds. Defaults
   * to 10000. Pass `Infinity` to wait without limit. The call cannot be
   * cancelled, so it may still finish after `log` has returned a failure.
   */
  timeoutMs?: number;
}

/** Longest `code` or `source` an insert policy accepts, in characters. */
export const POLICY_MAX_CODE_LENGTH = 255;
/** Longest `message` an insert policy accepts, in characters. */
export const POLICY_MAX_MESSAGE_LENGTH = 4096;
/** Largest `cause` an insert policy accepts, in bytes of stored JSON. */
export const POLICY_MAX_CAUSE_BYTES = 8192;

export interface SupabaseSetupOptions {
  /**
   * Postgres roles allowed to insert through the API, for example
   * `['authenticated']`. Leave empty when only a server using the service role
   * key logs: that role bypasses row level security, so it needs no policy, and
   * its key must never be shipped to a browser.
   *
   * The generated policy only checks the size of each field. It does not tie a
   * row to a user, so any holder of an allowed role's key can still add entries
   * of their own making: forged entries can hide real incidents, and a flood of
   * them uses up your database quota. Prefer `authenticated` over `anon`.
   */
  insertRoles?: string[];
  /**
   * Required to allow `anon` (or `public`) to insert. The `anon` key is part of
   * your frontend, so this lets anyone who loads the page write to the log.
   * Defaults to `false`.
   */
  allowPublicInsert?: boolean;
}

/** The `WITH CHECK` condition of the insert policy: every field must be a reasonable size. */
const INSERT_POLICY_CHECK: string =
  `char_length(code) <= ${POLICY_MAX_CODE_LENGTH} ` +
  `AND char_length(message) <= ${POLICY_MAX_MESSAGE_LENGTH} ` +
  `AND (source IS NULL OR char_length(source) <= ${POLICY_MAX_CODE_LENGTH}) ` +
  `AND (cause IS NULL OR pg_column_size(cause) <= ${POLICY_MAX_CAUSE_BYTES})`;

/**
 * Returns the SQL to run once in the Supabase SQL editor: the error log table,
 * with row level security turned on (as Supabase recommends for every table in
 * an exposed schema) and, optionally, an insert-only policy for the given roles.
 * The policy limits the size of each field. Nobody but the service role can read
 * the log through the API.
 *
 * @throws {RangeError} if the table name or a role is not a plain identifier, or
 * `anon` / `public` is listed without `allowPublicInsert: true`.
 */
export function buildSupabaseSetupSql(
  tableName: string = DEFAULT_TABLE_NAME,
  options: SupabaseSetupOptions = {}
): string[] {
  const insertRoles: string[] = options.insertRoles ?? [];
  for (const role of insertRoles) {
    assertIdentifier(role, 'role name', 'buildSupabaseSetupSql');
    if (
      (role.toLowerCase() === 'anon' || role.toLowerCase() === 'public') &&
      options.allowPublicInsert !== true
    ) {
      throw new RangeError(
        `buildSupabaseSetupSql: role "${role}" would let anyone who loads your page write to the log, because the anon key is public. Use "authenticated" instead, or pass allowPublicInsert: true to accept the risk of forged entries and quota use.`
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
      `CREATE POLICY "${policy}" ON "${tableName}" FOR INSERT TO ${insertRoles.map((role: string): string => `"${role}"`).join(', ')} WITH CHECK (${INSERT_POLICY_CHECK})`
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
  private readonly timeoutMs: number;

  /** @throws {RangeError} if `options.tableName` is not a plain identifier or `options.timeoutMs` is invalid. */
  constructor(
    private readonly client: SupabaseClientLike,
    options: SupabaseErrorOptions = {}
  ) {
    this.tableName = options.tableName ?? DEFAULT_TABLE_NAME;
    assertIdentifier(this.tableName, 'table name', 'SupabaseErrorAdapter');
    this.prefix = options.prefix ?? DEFAULT_PREFIX;
    this.timeoutMs = resolveTimeoutMs(
      options.timeoutMs,
      'SupabaseErrorAdapter'
    );
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
      const result: SupabaseInsertResult = await withTimeout(
        (): PromiseLike<SupabaseInsertResult> =>
          this.client.from(this.tableName).insert(row),
        this.timeoutMs,
        timeoutMessage('Supabase', this.timeoutMs)
      );
      if (result.error) {
        if (hasCallerId(entry) && result.error.code === '23505') {
          // Unique violation on the id: this entry was stored by an earlier call.
          return { ok: true };
        }
        return this.fail(result, describeSupabaseError(result));
      }
      return { ok: true };
    } catch (error: unknown) {
      return this.fail(error, describeError(error));
    }
  }

  private fail(logged: unknown, reason: string): ErrorLogResult {
    return reportFailure({
      adapterName: 'SupabaseErrorAdapter',
      prefix: this.prefix,
      action: `to insert into table "${this.tableName}"`,
      error: logged,
      reason,
    });
  }
}
