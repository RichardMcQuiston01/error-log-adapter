import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ErrorLogAdapter,
  ErrorLogEntry,
  ErrorLogResult,
} from '../types.js';
import { BatchingErrorAdapter } from './batching-error-adapter.js';
import type { BatchCapableAdapter } from './batching-error-adapter.js';

const entry = (message: string): ErrorLogEntry => ({ code: 'E', message });
const messages = (entries: ErrorLogEntry[]): string[] =>
  entries.map((e) => e.message);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function quiet() {
  return vi.spyOn(console, 'error').mockImplementation(() => {});
}

/** An adapter that records what it was asked to log and answers from a script. */
function fakeInner(
  answer: (entry: ErrorLogEntry) => ErrorLogResult = () => ({ ok: true })
) {
  const logged: string[] = [];
  const inner: ErrorLogAdapter = {
    log: vi.fn(async (e: ErrorLogEntry) => {
      logged.push(e.message);
      return answer(e);
    }),
  };
  return { inner, logged };
}

function fakeBatchInner(
  answer: (entries: ErrorLogEntry[]) => ErrorLogResult = () => ({ ok: true })
) {
  const batches: string[][] = [];
  const inner: BatchCapableAdapter = {
    log: vi.fn(async () => ({ ok: true })),
    logBatch: vi.fn(async (entries: ErrorLogEntry[]) => {
      batches.push(messages(entries));
      return answer(entries);
    }),
  };
  return { inner, batches };
}

describe('BatchingErrorAdapter', () => {
  it('returns ok at once and delivers only when the batch is full', async () => {
    const { inner, logged } = fakeInner();
    const batching = new BatchingErrorAdapter(inner, { batchSize: 3 });

    expect(await batching.log(entry('a'))).toEqual({ ok: true });
    expect(await batching.log(entry('b'))).toEqual({ ok: true });
    expect(inner.log).not.toHaveBeenCalled();
    expect(await batching.log(entry('c'))).toEqual({ ok: true });
    await batching.flush();

    expect(logged).toEqual(['a', 'b', 'c']);
  });

  it('delivers after maxWaitMs even if the batch is not full', async () => {
    vi.useFakeTimers();
    const { inner, logged } = fakeInner();
    const batching = new BatchingErrorAdapter(inner, {
      batchSize: 10,
      maxWaitMs: 500,
    });
    await batching.log(entry('a'));

    await vi.advanceTimersByTimeAsync(499);
    expect(logged).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(logged).toEqual(['a']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('with maxWaitMs Infinity waits for batchSize or flush', async () => {
    vi.useFakeTimers();
    const { inner, logged } = fakeInner();
    const batching = new BatchingErrorAdapter(inner, {
      batchSize: 10,
      maxWaitMs: Infinity,
    });
    await batching.log(entry('a'));
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(logged).toEqual([]);
    await batching.flush();
    expect(logged).toEqual(['a']);
  });

  it('flush() delivers right away and is ok when the queue is empty', async () => {
    const { inner, logged } = fakeInner();
    const batching = new BatchingErrorAdapter(inner);
    expect(await batching.flush()).toEqual({ ok: true });
    await batching.log(entry('a'));
    expect(await batching.flush()).toEqual({ ok: true });
    expect(logged).toEqual(['a']);
  });

  it('keeps entries in order across batches and later logs', async () => {
    const { inner, logged } = fakeInner();
    const batching = new BatchingErrorAdapter(inner, { batchSize: 2 });
    for (const m of ['a', 'b', 'c', 'd', 'e']) {
      await batching.log(entry(m));
    }
    await batching.flush();
    expect(logged).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  describe('wrapped adapter with logBatch', () => {
    it('sends each batch in one call', async () => {
      const { inner, batches } = fakeBatchInner();
      const batching = new BatchingErrorAdapter(inner, { batchSize: 2 });
      for (const m of ['a', 'b', 'c']) {
        await batching.log(entry(m));
      }
      await batching.flush();
      expect(batches).toEqual([['a', 'b'], ['c']]);
      expect(inner.log).not.toHaveBeenCalled();
    });

    it('uses log one at a time when useBatchMethod is false', async () => {
      const { inner } = fakeBatchInner();
      const batching = new BatchingErrorAdapter(inner, {
        batchSize: 2,
        useBatchMethod: false,
      });
      await batching.log(entry('a'));
      await batching.log(entry('b'));
      await batching.flush();
      expect(inner.log).toHaveBeenCalledTimes(2);
      expect(inner.logBatch).not.toHaveBeenCalled();
    });

    it('retries a failed batch as a whole', async () => {
      vi.useFakeTimers();
      quiet();
      let calls = 0;
      const { inner, batches } = fakeBatchInner(() =>
        ++calls === 1 ? { ok: false, error: 'HTTP 503' } : { ok: true }
      );
      const batching = new BatchingErrorAdapter(inner, { batchSize: 2 });
      await batching.log(entry('a'));
      await batching.log(entry('b'));
      const done = batching.flush();
      await vi.runAllTimersAsync();
      expect(await done).toEqual({ ok: true });
      expect(batches).toEqual([
        ['a', 'b'],
        ['a', 'b'],
      ]);
    });
  });

  describe('retries', () => {
    it('stops at the first failure, backs off, and then carries on in order', async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(1);
      let failB = 1;
      const { inner, logged } = fakeInner((e) =>
        e.message === 'b' && failB-- > 0
          ? { ok: false, error: 'down' }
          : { ok: true }
      );
      const batching = new BatchingErrorAdapter(inner, {
        batchSize: 3,
        retryDelayMs: 100,
      });
      for (const m of ['a', 'b', 'c']) {
        await batching.log(entry(m));
      }

      await vi.advanceTimersByTimeAsync(0);
      expect(logged).toEqual(['a', 'b']);
      await vi.advanceTimersByTimeAsync(99);
      expect(logged).toEqual(['a', 'b']);
      await vi.advanceTimersByTimeAsync(1);
      expect(logged).toEqual(['a', 'b', 'b', 'c']);
    });

    it('doubles the wait after each failed round', async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(1);
      quiet();
      const { inner } = fakeInner(() => ({ ok: false, error: 'down' }));
      const batching = new BatchingErrorAdapter(inner, {
        batchSize: 1,
        retryDelayMs: 100,
        retries: 3,
      });
      await batching.log(entry('a'));
      await vi.advanceTimersByTimeAsync(0);
      expect(inner.log).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(inner.log).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(199);
      expect(inner.log).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(inner.log).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(400);
      expect(inner.log).toHaveBeenCalledTimes(4);
    });

    it('gives up after the retries, tells onDrop and the console, and flush reports it once', async () => {
      vi.useFakeTimers();
      const spy = quiet();
      const dropped: Array<{ entries: string[]; reason: string }> = [];
      const { inner } = fakeInner(() => ({ ok: false, error: 'HTTP 500' }));
      const batching = new BatchingErrorAdapter(inner, {
        batchSize: 1,
        retries: 2,
        onDrop: (entries, reason) =>
          dropped.push({ entries: messages(entries), reason }),
      });
      await batching.log(entry('a'));

      const done = batching.flush();
      await vi.runAllTimersAsync();
      const result = await done;

      expect(inner.log).toHaveBeenCalledTimes(3);
      expect(dropped).toEqual([
        {
          entries: ['a'],
          reason: 'delivery failed 3 times; last error: HTTP 500',
        },
      ]);
      expect(spy).toHaveBeenCalled();
      expect(result.ok).toBe(false);
      expect(result.error).toContain('gave up on 1 entry');
      expect(await batching.flush()).toEqual({ ok: true });
    });

    it('lets entries behind a poisoned one through once it is dropped', async () => {
      vi.useFakeTimers();
      quiet();
      const { inner, logged } = fakeInner((e) =>
        e.message === 'bad' ? { ok: false, error: 'invalid' } : { ok: true }
      );
      const batching = new BatchingErrorAdapter(inner, {
        batchSize: 5,
        retries: 1,
      });
      for (const m of ['bad', 'x', 'y']) {
        await batching.log(entry(m));
      }
      const done = batching.flush();
      await vi.runAllTimersAsync();
      await done;
      expect(logged.filter((m) => m !== 'bad')).toEqual(['x', 'y']);
    });

    it('treats a wrapped adapter that throws as a failure', async () => {
      vi.useFakeTimers();
      quiet();
      const inner: ErrorLogAdapter = {
        log: vi.fn().mockRejectedValue(new Error('boom')),
      };
      const onDrop = vi.fn();
      const batching = new BatchingErrorAdapter(inner, {
        batchSize: 1,
        retries: 0,
        onDrop,
      });
      await batching.log(entry('a'));
      const done = batching.flush();
      await vi.runAllTimersAsync();
      await done;
      expect(onDrop.mock.calls[0][1]).toContain('boom');
    });

    it('ignores an onDrop that throws', async () => {
      vi.useFakeTimers();
      quiet();
      const { inner } = fakeInner(() => ({ ok: false, error: 'x' }));
      const batching = new BatchingErrorAdapter(inner, {
        batchSize: 1,
        retries: 0,
        onDrop: () => {
          throw new Error('callback bug');
        },
      });
      await batching.log(entry('a'));
      const done = batching.flush();
      await vi.runAllTimersAsync();
      expect((await done).ok).toBe(false);
    });
  });

  it('drops the oldest entries when the buffer is full', async () => {
    quiet();
    const dropped: string[][] = [];
    const inner: ErrorLogAdapter = {
      log: vi.fn(() => new Promise<ErrorLogResult>(() => {})),
    };
    const batching = new BatchingErrorAdapter(inner, {
      batchSize: 2,
      maxBuffered: 3,
      maxWaitMs: Infinity,
      onDrop: (entries) => dropped.push(messages(entries)),
    });
    for (const m of ['a', 'b', 'c', 'd', 'e']) {
      await batching.log(entry(m));
    }
    expect(dropped).toEqual([['a'], ['b']]);
  });

  it('keeps a backoff wait from holding the process open unless flush() is waiting', async () => {
    vi.useFakeTimers();
    quiet();
    const unref = vi.fn();
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
      ms?: number
    ) => {
      const timer = realSetTimeout(fn, ms) as unknown as {
        unref: () => void;
      };
      const original = timer.unref.bind(timer);
      timer.unref = () => {
        unref();
        return original();
      };
      return timer;
    }) as never);
    const { inner } = fakeInner(() => ({ ok: false, error: 'x' }));
    const batching = new BatchingErrorAdapter(inner, { batchSize: 1 });
    await batching.log(entry('a'));
    await vi.advanceTimersByTimeAsync(0);
    expect(unref).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('rejects invalid options', () => {
    const { inner } = fakeInner();
    const make = (o: object) => new BatchingErrorAdapter(inner, o);
    expect(() => make({ batchSize: 0 })).toThrow(/batchSize/);
    expect(() => make({ batchSize: 1.5 })).toThrow(/batchSize/);
    expect(() => make({ maxWaitMs: 0 })).toThrow(/maxWaitMs/);
    expect(() => make({ maxWaitMs: NaN })).toThrow(/maxWaitMs/);
    expect(() => make({ retries: -1 })).toThrow(/retries/);
    expect(() => make({ retryDelayMs: 0 })).toThrow(/retryDelayMs/);
    expect(() => make({ retryDelayMs: 1000, maxRetryDelayMs: 10 })).toThrow(
      /maxRetryDelayMs/
    );
    expect(() => make({ batchSize: 10, maxBuffered: 5 })).toThrow(
      /maxBuffered/
    );
  });
});
