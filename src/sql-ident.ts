/** Default table name for the SQL, SQLite and Supabase adapters. */
export const DEFAULT_TABLE_NAME = 'error_log';

const IDENTIFIER_PATTERN: RegExp = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Throws a descriptive `RangeError` unless `value` is a plain SQL identifier:
 * letters, digits and underscores, not starting with a digit. Quoting is then
 * never needed, and nothing in the name can alter a statement.
 *
 * @param label What the value is, for the message, such as `table name`.
 * @param owner Who is asking, such as `PostgresErrorAdapter`.
 * @param maxLength Longest allowed length, when the caller needs a limit.
 */
export function assertIdentifier(
  value: string,
  label: string,
  owner: string,
  maxLength?: number
): void {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new RangeError(
      `${owner}: invalid ${label} "${value}". Use only letters, digits and underscores, and do not start with a digit.`
    );
  }
  if (maxLength !== undefined && value.length > maxLength) {
    throw new RangeError(
      `${owner}: ${label} "${value}" is ${value.length} characters long, but the limit is ${maxLength}.`
    );
  }
}
