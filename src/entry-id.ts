import type { ErrorLogEntry } from './types.js';
import { generateId } from './uuid.js';

const UUID_PATTERN: RegExp =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when the caller gave the entry its own `id`. */
export function hasCallerId(entry: ErrorLogEntry): boolean {
  return entry.id !== undefined;
}

/**
 * Returns the id to store an entry under: the caller's `id` (lower-cased, so the
 * same UUID always maps to the same record), or a new random UUID.
 *
 * @throws {RangeError} if the caller's `id` is not a UUID. Adapters call this
 * inside `log`'s try block, so the problem is reported as `ok: false`.
 */
export function resolveEntryId(entry: ErrorLogEntry): string {
  if (entry.id === undefined) {
    return generateId();
  }
  if (typeof entry.id !== 'string' || !UUID_PATTERN.test(entry.id)) {
    throw new RangeError(
      `entry.id must be a UUID such as one from crypto.randomUUID(), received ${JSON.stringify(entry.id)}`
    );
  }
  return entry.id.toLowerCase();
}
