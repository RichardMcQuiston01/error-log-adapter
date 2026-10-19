/** A single error to be routed to a sink. */
export interface ErrorLogEntry<TCode extends string = string> {
  /** Machine-readable error code, e.g. `ADAPTER_ERROR`. */
  code: TCode;
  /** Human-readable description of what went wrong. */
  message: string;
  /** The underlying error or value that caused this entry. */
  cause?: unknown;
  /** Name of the application or module that raised the error. */
  source?: string;
  /** ISO 8601 timestamp. Adapters fill this in when it is omitted. */
  timestamp?: string;
  /**
   * Optional UUID that identifies this entry. Adapters generate a new one for
   * every `log` call when it is omitted, so logging the same entry twice stores
   * it twice. Supply the same `id` (and, for S3, the same `timestamp`) to make
   * a retry safe: sinks that can detect a repeat overwrite or skip the existing
   * record instead of adding another. It must be a UUID, for example from
   * `crypto.randomUUID()`; anything else makes `log` return `ok: false`.
   * Redis, the flat file and NDJSON file adapters, and the console cannot
   * detect a repeat.
   */
  id?: string;
}

/** Outcome of a `log` call. Callers should check `ok`. */
export interface ErrorLogResult {
  ok: boolean;
  /** Description of the failure when `ok` is false. */
  error?: string;
}

/**
 * A sink for runtime errors. Implementations must never throw or reject:
 * any failure is reported through the returned `ErrorLogResult`.
 */
export interface ErrorLogAdapter<TCode extends string = string> {
  log(entry: ErrorLogEntry<TCode>): Promise<ErrorLogResult>;
}
