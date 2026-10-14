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
