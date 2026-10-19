import { describeError } from './serialize.js';
import type { ErrorLogResult } from './types.js';

/** Text printed before failure messages unless an adapter's `prefix` option says otherwise. */
export const DEFAULT_PREFIX = '[error-log-adapter]';

export interface FailureReport {
  /** Class name of the adapter, such as `PostgresErrorAdapter`. */
  adapterName: string;
  /** The adapter's `prefix` option. */
  prefix: string;
  /** What was being done, completing "<adapter> failed ...", such as `to write to table "error_log"`. */
  action: string;
  /** What went wrong. It is printed with `console.error`, and its message is returned. */
  error: unknown;
  /** Replaces the message taken from `error`, for sinks that describe failures in their own way. */
  reason?: string;
}

/**
 * Reports a failed `log` call the same way for every adapter: the problem goes
 * to `console.error` under the adapter's prefix, and the caller gets
 * `{ ok: false, error: "<adapter> failed <action>: <reason>" }`.
 */
export function reportFailure(report: FailureReport): ErrorLogResult {
  console.error(`${report.prefix} ${report.adapterName}:`, report.error);
  return {
    ok: false,
    error: `${report.adapterName} failed ${report.action}: ${report.reason ?? describeError(report.error)}`,
  };
}
