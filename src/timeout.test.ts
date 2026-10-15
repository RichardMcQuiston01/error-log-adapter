import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TIMEOUT_MS,
  resolveTimeoutMs,
  timeoutMessage,
  withTimeout,
} from './timeout.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('resolveTimeoutMs', () => {
  it('defaults to 10 seconds and accepts a positive number or Infinity', () => {
    expect(resolveTimeoutMs(undefined, 'X')).toBe(DEFAULT_TIMEOUT_MS);
    expect(resolveTimeoutMs(250, 'X')).toBe(250);
    expect(resolveTimeoutMs(Infinity, 'X')).toBe(Infinity);
  });

  it.each([0, -1, NaN])('rejects %s with a descriptive error', (value) => {
    expect(() => resolveTimeoutMs(value, 'MyAdapter')).toThrow(
      /MyAdapter: timeoutMs must be a positive number or Infinity/
    );
  });
});

describe('withTimeout', () => {
  it('resolves with the value and clears the timer', async () => {
    vi.useFakeTimers();
    const result = await withTimeout(() => Promise.resolve(7), 1000, 'late');
    expect(result).toBe(7);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('passes through a plain (non-promise) return value', async () => {
    expect(await withTimeout(() => 'sync', 1000, 'late')).toBe('sync');
  });

  it('rejects with the original error and clears the timer', async () => {
    vi.useFakeTimers();
    await expect(
      withTimeout(() => Promise.reject(new Error('driver said no')), 1000, 'x')
    ).rejects.toThrow('driver said no');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects when start throws synchronously', async () => {
    await expect(
      withTimeout(
        () => {
          throw new Error('threw at once');
        },
        1000,
        'x'
      )
    ).rejects.toThrow('threw at once');
  });

  it('rejects with the message when the work never settles', async () => {
    vi.useFakeTimers();
    const pending = withTimeout(
      () => new Promise<void>(() => {}),
      500,
      'too slow'
    );
    const assertion = expect(pending).rejects.toThrow('too slow');
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
  });

  it('ignores a result that arrives after the deadline', async () => {
    vi.useFakeTimers();
    let finish: (value: string) => void = () => {};
    const pending = withTimeout(
      () => new Promise<string>((resolve) => (finish = resolve)),
      100,
      'too slow'
    );
    const assertion = expect(pending).rejects.toThrow('too slow');
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(() => finish('late')).not.toThrow();
  });

  it('waits without a timer for Infinity', async () => {
    vi.useFakeTimers();
    const result = withTimeout(() => Promise.resolve('ok'), Infinity, 'x');
    expect(vi.getTimerCount()).toBe(0);
    expect(await result).toBe('ok');
  });
});

describe('timeoutMessage', () => {
  it('says what happened and warns about retrying', () => {
    const message = timeoutMessage('the Redis server', 2500);
    expect(message).toContain(
      'the Redis server did not respond within 2500 ms'
    );
    expect(message).toContain('retrying could store it twice');
  });
});
