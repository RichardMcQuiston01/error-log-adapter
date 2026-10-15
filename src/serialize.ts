import type { ErrorLogEntry } from './types.js';

/** A JSON-safe copy of an `ErrorLogEntry`. */
export interface SerializedErrorLogEntry {
  code: string;
  message: string;
  cause?: unknown;
  source?: string;
  timestamp: string;
}

/** How many levels of nested causes and objects are kept before the rest is replaced by a marker. */
export const MAX_CAUSE_DEPTH = 6;

function isErrorLike(value: object): value is {
  name: string;
  message: string;
  stack?: unknown;
  cause?: unknown;
  errors?: unknown;
} {
  if (value instanceof Error) {
    return true;
  }
  // An error from another realm (vm, iframe) fails `instanceof Error`.
  const candidate = value as { name?: unknown; message?: unknown };
  return (
    typeof candidate.name === 'string' &&
    typeof candidate.message === 'string' &&
    typeof (value as { stack?: unknown }).stack === 'string'
  );
}

function readProperty(source: object, key: string): unknown {
  try {
    return (source as Record<string, unknown>)[key];
  } catch (error: unknown) {
    return `[Unreadable: ${error instanceof Error ? error.message : String(error)}]`;
  }
}

function toJsonSafe(
  value: unknown,
  depth: number,
  ancestors: WeakSet<object>
): unknown {
  switch (typeof value) {
    case 'string':
    case 'boolean':
    case 'undefined':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'bigint':
      return `${value}n`;
    case 'symbol':
      return value.toString();
    case 'function':
      return `[Function ${value.name || 'anonymous'}]`;
    default:
      break;
  }
  if (value === null) {
    return null;
  }
  const objectValue: object = value as object;
  if (ancestors.has(objectValue)) {
    return '[Circular]';
  }
  if (depth >= MAX_CAUSE_DEPTH) {
    return '[Truncated]';
  }
  ancestors.add(objectValue);
  try {
    if (isErrorLike(objectValue)) {
      const result: Record<string, unknown> = {
        name: objectValue.name,
        message: objectValue.message,
        stack: objectValue.stack,
      };
      const nested: unknown = readProperty(objectValue, 'cause');
      if (nested !== undefined) {
        result['cause'] = toJsonSafe(nested, depth + 1, ancestors);
      }
      const errors: unknown = readProperty(objectValue, 'errors');
      if (Array.isArray(errors)) {
        result['errors'] = errors.map((item: unknown): unknown =>
          toJsonSafe(item, depth + 1, ancestors)
        );
      }
      return result;
    }
    if (Array.isArray(value)) {
      return value.map((item: unknown): unknown =>
        toJsonSafe(item, depth + 1, ancestors)
      );
    }
    const toJson: unknown = readProperty(objectValue, 'toJSON');
    if (typeof toJson === 'function') {
      try {
        return toJsonSafe(
          (toJson as () => unknown).call(objectValue),
          depth + 1,
          ancestors
        );
      } catch (error: unknown) {
        return `[toJSON failed: ${error instanceof Error ? error.message : String(error)}]`;
      }
    }
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(objectValue)) {
      result[key] = toJsonSafe(
        readProperty(objectValue, key),
        depth + 1,
        ancestors
      );
    }
    return result;
  } finally {
    ancestors.delete(objectValue);
  }
}

/**
 * Returns a copy of `cause` that `JSON.stringify` can always handle, so a
 * strange cause can never stop an entry from being stored.
 *
 * - `Error` objects (including ones from another realm) become
 *   `{ name, message, stack }`, plus `cause` and, for an `AggregateError`,
 *   `errors`, which are converted the same way.
 * - Circular references become `"[Circular]"`, and anything nested deeper than
 *   `MAX_CAUSE_DEPTH` levels becomes `"[Truncated]"`.
 * - `BigInt`, `Symbol` and function values, and non-finite numbers, become strings.
 * - A property or `toJSON` that throws is replaced by a short description.
 */
export function serializeCause(cause: unknown): unknown {
  return toJsonSafe(cause, 0, new WeakSet<object>());
}

/** Returns a JSON-safe copy of the entry, adding a timestamp if missing. */
export function serializeEntry(entry: ErrorLogEntry): SerializedErrorLogEntry {
  const serialized: SerializedErrorLogEntry = {
    code: entry.code,
    message: entry.message,
    timestamp: entry.timestamp ?? new Date().toISOString(),
  };
  if (entry.cause !== undefined) {
    serialized.cause = serializeCause(entry.cause);
  }
  if (entry.source !== undefined) {
    serialized.source = entry.source;
  }
  return serialized;
}

/** Turns an unknown thrown value into a descriptive message. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
