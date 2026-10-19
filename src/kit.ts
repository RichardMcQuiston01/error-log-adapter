/**
 * Building blocks for adapter packages that live outside this one, such as
 * `@richardmcquiston01/error-log-adapter-rabbitmq`. Import them from
 * `@richardmcquiston01/error-log-adapter/kit`. They are the same helpers the
 * built-in adapters use, so a separate package behaves the same way: one
 * failure format, one timeout rule, one entry-id rule.
 *
 * @experimental Not covered by the semver rules in docs/versioning-policy.md
 * yet. It may change in a minor release until the first adapter packages have
 * shipped against it.
 */
export { DEFAULT_PREFIX, reportFailure } from './fail.js';
export type { FailureReport } from './fail.js';
export {
  DEFAULT_TIMEOUT_MS,
  SinkTimeoutError,
  resolveTimeoutMs,
  timeoutMessage,
  withTimeout,
} from './timeout.js';
export { hasCallerId, resolveEntryId } from './entry-id.js';
export { generateId } from './uuid.js';
export { describeError } from './serialize.js';
export { backoffDelayMs } from './backoff.js';
export { SerialQueue } from './queue.js';
export { DEFAULT_TABLE_NAME, assertIdentifier } from './sql-ident.js';
