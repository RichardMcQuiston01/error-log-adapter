import type { ErrorLogEntry } from './types.js';

/** A JSON-safe copy of an `ErrorLogEntry`. */
export interface SerializedErrorLogEntry {
  code: string;
  message: string;
  cause?: unknown;
  source?: string;
  timestamp: string;
}

/**
 * Converts `Error` instances into plain objects, since `JSON.stringify`
 * renders them as `{}`. Other values are returned unchanged.
 */
export function serializeCause(cause: unknown): unknown {
  if (cause instanceof Error) {
    return { name: cause.name, message: cause.message, stack: cause.stack };
  }
  return cause;
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
