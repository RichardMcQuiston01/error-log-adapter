import type {
  ErrorLogAdapter,
  ErrorLogEntry,
  ErrorLogResult,
} from '../types.js';

/** Sends every entry to several adapters. Succeeds only if all of them do. */
export class CompositeErrorAdapter<
  TCode extends string = string,
> implements ErrorLogAdapter<TCode> {
  constructor(
    private readonly adapters: ReadonlyArray<ErrorLogAdapter<TCode>>
  ) {}

  async log(entry: ErrorLogEntry<TCode>): Promise<ErrorLogResult> {
    const results: ErrorLogResult[] = await Promise.all(
      this.adapters.map(
        async (adapter: ErrorLogAdapter<TCode>): Promise<ErrorLogResult> => {
          try {
            return await adapter.log(entry);
          } catch (error: unknown) {
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
