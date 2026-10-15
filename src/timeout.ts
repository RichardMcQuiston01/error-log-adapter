/** Default time to wait for a sink to answer, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** Thrown (as a rejection) by `withTimeout` when the deadline passes first. */
export class SinkTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SinkTimeoutError';
  }
}

/**
 * Validates a `timeoutMs` option and applies the default.
 *
 * @throws {RangeError} unless the value is a positive number or `Infinity`.
 */
export function resolveTimeoutMs(
  value: number | undefined,
  adapterName: string
): number {
  const timeoutMs: number = value ?? DEFAULT_TIMEOUT_MS;
  if (Number.isNaN(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(
      `${adapterName}: timeoutMs must be a positive number or Infinity, received ${String(value)}.`
    );
  }
  return timeoutMs;
}

/** What a caller should know when a sink did not answer in time. */
export function timeoutMessage(
  sink: string,
  timeoutMs: number,
  action: string = 'respond'
): string {
  return `${sink} did not ${action} within ${timeoutMs} ms, so the entry may or may not have been stored (the operation can still finish later, so retrying could store it twice)`;
}

/**
 * Runs `start()` and waits for its result, but rejects with `message` if it takes
 * longer than `timeoutMs`. Drivers cannot generally cancel a call, so the call may
 * still complete after the deadline; `log()` just stops waiting for it. A `start`
 * that throws synchronously rejects too. `Infinity` waits without limit.
 */
export function withTimeout<T>(
  start: () => PromiseLike<T> | T,
  timeoutMs: number,
  message: string
): Promise<T> {
  if (timeoutMs === Infinity) {
    return new Promise<T>((resolve, reject): void => {
      try {
        resolve(start() as T | PromiseLike<T>);
      } catch (error: unknown) {
        reject(error);
      }
    });
  }
  return new Promise<T>(
    (resolve: (value: T) => void, reject: (reason: unknown) => void): void => {
      const timer = setTimeout((): void => {
        reject(new SinkTimeoutError(message));
      }, timeoutMs);
      const settle =
        <A extends unknown[]>(
          done: (...args: A) => void
        ): ((...args: A) => void) =>
        (...args: A): void => {
          clearTimeout(timer);
          done(...args);
        };
      try {
        Promise.resolve(start()).then(settle(resolve), settle(reject));
      } catch (error: unknown) {
        settle(reject)(error);
      }
    }
  );
}
