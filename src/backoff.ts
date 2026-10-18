/**
 * Milliseconds to wait before retry number `retryNumber` (1 for the first):
 * `baseMs` doubling each time, never more than `maxMs`. Half of it is fixed and
 * half random, so many callers that failed together do not retry in lockstep.
 */
export function backoffDelayMs(
  retryNumber: number,
  baseMs: number,
  maxMs: number
): number {
  const ceiling: number = Math.min(maxMs, baseMs * 2 ** (retryNumber - 1));
  return ceiling / 2 + (Math.random() * ceiling) / 2;
}
