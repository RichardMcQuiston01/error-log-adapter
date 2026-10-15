import {
  DEFAULT_TIMEOUT_MS,
  SinkTimeoutError,
  resolveTimeoutMs,
  withTimeout,
} from '../timeout.js';
import type {
  ErrorLogAdapter,
  ErrorLogEntry,
  ErrorLogResult,
} from '../types.js';

export interface CompositeErrorOptions {
  /**
   * How long to wait for each adapter before reporting it as failed, in
   * milliseconds. Defaults to 30000, longer than the 10000 default of the built-in
   * adapters so their own, more specific timeout messages come first. This only
   * matters for a custom adapter that can hang: one stuck adapter then cannot
   * hold back the result of the others. Pass `Infinity` to wait without limit.
   */
  timeoutMs?: number;
}

/** Default wait for each adapter of a composite. */
export const DEFAULT_COMPOSITE_TIMEOUT_MS: number = DEFAULT_TIMEOUT_MS * 3;

/** Sends every entry to several adapters. Succeeds only if all of them do. */
export class CompositeErrorAdapter<
  TCode extends string = string,
> implements ErrorLogAdapter<TCode> {
  private readonly timeoutMs: number;

  /** @throws {RangeError} if `options.timeoutMs` is not a positive number or Infinity. */
  constructor(
    private readonly adapters: ReadonlyArray<ErrorLogAdapter<TCode>>,
    options: CompositeErrorOptions = {}
  ) {
    this.timeoutMs = resolveTimeoutMs(
      options.timeoutMs ?? DEFAULT_COMPOSITE_TIMEOUT_MS,
      'CompositeErrorAdapter'
    );
  }

  async log(entry: ErrorLogEntry<TCode>): Promise<ErrorLogResult> {
    const results: ErrorLogResult[] = await Promise.all(
      this.adapters.map(
        async (
          adapter: ErrorLogAdapter<TCode>,
          index: number
        ): Promise<ErrorLogResult> => {
          try {
            return await withTimeout(
              (): Promise<ErrorLogResult> => adapter.log(entry),
              this.timeoutMs,
              `adapter ${index} (${adapter.constructor.name}) did not return within ${this.timeoutMs} ms, so the entry may or may not have been stored there`
            );
          } catch (error: unknown) {
            if (error instanceof SinkTimeoutError) {
              return { ok: false, error: error.message };
            }
            // Adapters should not throw, but a faulty custom one must not break the others.
            return {
              ok: false,
              error: `adapter threw instead of returning a result: ${String(error)}`,
            };
          }
        }
      )
    );
    const failures: string[] = results.flatMap(
      (result: ErrorLogResult): string[] =>
        result.ok ? [] : [result.error ?? 'unknown failure']
    );
    if (failures.length === 0) {
      return { ok: true };
    }
    return {
      ok: false,
      error: `${failures.length} of ${results.length} adapters failed: ${failures.join('; ')}`,
    };
  }
}
