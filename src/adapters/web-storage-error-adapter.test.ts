import { describe, expect, it, vi } from 'vitest';
import type { ErrorLogEntry } from '../types.js';
import { WebStorageErrorAdapter } from './web-storage-error-adapter.js';
import type {
  LockManagerLike,
  StorageLike,
  WebStorageErrorRecord,
} from './web-storage-error-adapter.js';

function entry(message: string): ErrorLogEntry {
  return { code: 'E', message, timestamp: '2026-01-02T03:04:05.000Z' };
}

/** In-memory storage that, like a browser, throws once the total size passes a limit. */
class FakeStorage implements StorageLike {
  readonly data = new Map<string, string>();

  constructor(private readonly maxLength: number = Infinity) {}

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (value.length > this.maxLength) {
      const error = new Error('The quota has been exceeded.');
      error.name = 'QuotaExceededError';
      throw error;
    }
    this.data.set(key, value);
  }

  records(key: string = 'error_log'): WebStorageErrorRecord[] {
    return JSON.parse(this.data.get(key) ?? '[]') as WebStorageErrorRecord[];
  }
}

function silenceConsole() {
  return vi.spyOn(console, 'error').mockImplementation(() => {});
}

describe('WebStorageErrorAdapter', () => {
  it('stores a serialized record with a UUID id under the default key', async () => {
    const storage = new FakeStorage();

    const result = await new WebStorageErrorAdapter(storage).log({
      ...entry('boom'),
      source: 'app',
      cause: new Error('x'),
    });

    expect(result).toEqual({ ok: true });
    const [record] = storage.records();
    expect(record?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(record).toMatchObject({
      code: 'E',
      message: 'boom',
      source: 'app',
      timestamp: '2026-01-02T03:04:05.000Z',
      cause: { name: 'Error', message: 'x' },
    });
  });

  it('appends entries in order and honors a custom key', async () => {
    const storage = new FakeStorage();
    const adapter = new WebStorageErrorAdapter(storage, { key: 'app_errors' });

    await adapter.log(entry('one'));
    await adapter.log(entry('two'));

    expect(storage.records('app_errors').map((r) => r.message)).toEqual([
      'one',
      'two',
    ]);
    expect(storage.data.has('error_log')).toBe(false);
  });

  it('keeps only the newest maxEntries records', async () => {
    const storage = new FakeStorage();
    const adapter = new WebStorageErrorAdapter(storage, { maxEntries: 2 });

    for (const message of ['one', 'two', 'three']) {
      await adapter.log(entry(message));
    }

    expect(storage.records().map((r) => r.message)).toEqual(['two', 'three']);
  });

  it('drops the oldest entries when the store is full', async () => {
    const first = new FakeStorage();
    await new WebStorageErrorAdapter(first).log(entry('a'));
    const oneRecordLength = first.data.get('error_log')?.length ?? 0;
    // Room for roughly two records, so a third forces the oldest out.
    const storage = new FakeStorage(oneRecordLength * 2 + 5);
    const adapter = new WebStorageErrorAdapter(storage);

    for (const message of ['a', 'b', 'c', 'd']) {
      expect(await adapter.log(entry(message))).toEqual({ ok: true });
    }

    const messages = storage.records().map((r) => r.message);
    expect(messages.length).toBeLessThanOrEqual(2);
    expect(messages.at(-1)).toBe('d');
  });

  it('fails with a descriptive error if even one entry does not fit', async () => {
    const storage = new FakeStorage(5);
    const spy = silenceConsole();

    const result = await new WebStorageErrorAdapter(storage).log(entry('x'));

    expect(result.ok).toBe(false);
    expect(result.error).toContain('quota');
    expect(result.error).toContain('"error_log"');
    spy.mockRestore();
  });

  it('does not retry on errors that are not quota errors', async () => {
    const setItem = vi.fn(() => {
      throw new Error('SecurityError: storage is disabled');
    });
    const storage: StorageLike = { getItem: () => null, setItem };
    const spy = silenceConsole();

    const result = await new WebStorageErrorAdapter(storage, {
      prefix: '[my-app]',
    }).log(entry('x'));

    expect(result.ok).toBe(false);
    expect(result.error).toContain('storage is disabled');
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      '[my-app] WebStorageErrorAdapter:',
      expect.any(Error)
    );
    spy.mockRestore();
  });

  it.each(['not json', '{"a":1}'])(
    'replaces an unreadable stored value (%s) and keeps logging',
    async (stored: string) => {
      const storage = new FakeStorage();
      storage.data.set('error_log', stored);
      const spy = silenceConsole();

      const result = await new WebStorageErrorAdapter(storage).log(
        entry('fresh')
      );

      expect(result).toEqual({ ok: true });
      expect(storage.records().map((r) => r.message)).toEqual(['fresh']);
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining('so it was replaced')
      );
      spy.mockRestore();
    }
  );

  it.each(['not json', '{"a":1}'])(
    'copies an unreadable stored value (%s) to a .corrupt key before replacing it',
    async (stored: string) => {
      const storage = new FakeStorage();
      storage.data.set('error_log', stored);
      const spy = silenceConsole();

      await new WebStorageErrorAdapter(storage).log(entry('fresh'));

      expect(storage.data.get('error_log.corrupt')).toBe(stored);
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining('a copy was kept under "error_log.corrupt"')
      );
      spy.mockRestore();
    }
  );

  it('does not overwrite an earlier .corrupt copy', async () => {
    const storage = new FakeStorage();
    storage.data.set('error_log', 'second bad value');
    storage.data.set('error_log.corrupt', 'first bad value');
    const spy = silenceConsole();

    await new WebStorageErrorAdapter(storage).log(entry('fresh'));

    expect(storage.data.get('error_log.corrupt')).toBe('first bad value');
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('already holds an earlier copy')
    );
    spy.mockRestore();
  });

  it('still replaces the value when the copy cannot be saved', async () => {
    const storage = new FakeStorage(5);
    storage.data.set('error_log', 'not json!!');
    const spy = silenceConsole();

    const result = await new WebStorageErrorAdapter(storage, {
      maxEntries: 1,
    }).log({ code: 'E', message: 'm' });

    // The record itself does not fit in 5 characters either, so the write
    // fails, but the failure to keep a copy must not be what stops it.
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('could not be copied aside')
    );
    expect(result.ok).toBe(false);
    spy.mockRestore();
  });

  it('does not touch a missing key', async () => {
    const storage = new FakeStorage();
    await new WebStorageErrorAdapter(storage).log(entry('first'));
    expect(storage.data.has('error_log.corrupt')).toBe(false);
  });

  describe('cross-tab locking', () => {
    function fakeLocks(): {
      locks: LockManagerLike;
      names: string[];
      running: { count: number; max: number };
    } {
      const names: string[] = [];
      const running = { count: 0, max: 0 };
      let queue: Promise<unknown> = Promise.resolve();
      const locks: LockManagerLike = {
        request<T>(name: string, callback: () => T | Promise<T>): Promise<T> {
          names.push(name);
          const result: Promise<T> = queue.then(async (): Promise<T> => {
            running.count += 1;
            running.max = Math.max(running.max, running.count);
            try {
              return await callback();
            } finally {
              running.count -= 1;
            }
          });
          queue = result.catch(() => undefined);
          return result;
        },
      };
      return { locks, names, running };
    }

    it('writes inside a lock named after the storage key', async () => {
      const storage = new FakeStorage();
      const { locks, names } = fakeLocks();

      const result = await new WebStorageErrorAdapter(storage, {
        locks,
        key: 'app_errors',
      }).log(entry('one'));

      expect(result).toEqual({ ok: true });
      expect(names).toEqual(['error-log-adapter:app_errors']);
      expect(storage.records('app_errors')).toHaveLength(1);
    });

    it('keeps both entries when two adapters (tabs) log at once', async () => {
      const storage = new FakeStorage();
      const { locks, running } = fakeLocks();
      const tabA = new WebStorageErrorAdapter(storage, { locks });
      const tabB = new WebStorageErrorAdapter(storage, { locks });

      await Promise.all([tabA.log(entry('a')), tabB.log(entry('b'))]);

      expect(
        storage
          .records()
          .map((r) => r.message)
          .sort()
      ).toEqual(['a', 'b']);
      expect(running.max).toBe(1);
    });

    it('still writes when the lock cannot be taken', async () => {
      const storage = new FakeStorage();
      const locks: LockManagerLike = {
        request: () => Promise.reject(new Error('SecurityError')),
      };

      const result = await new WebStorageErrorAdapter(storage, { locks }).log(
        entry('x')
      );

      expect(result).toEqual({ ok: true });
      expect(storage.records()).toHaveLength(1);
    });

    it('never throws synchronously from the lock callback, so a failed write cannot leave the lock held', async () => {
      const storage = new FakeStorage(1);
      let threwSynchronously = false;
      const locks: LockManagerLike = {
        request<T>(_name: string, callback: () => T | Promise<T>): Promise<T> {
          try {
            return Promise.resolve(callback());
          } catch (error: unknown) {
            threwSynchronously = true;
            return Promise.reject(error);
          }
        },
      };
      const spy = silenceConsole();

      const result = await new WebStorageErrorAdapter(storage, { locks }).log(
        entry('too big')
      );

      expect(result.ok).toBe(false);
      expect(threwSynchronously).toBe(false);
      spy.mockRestore();
    });

    it('reports a write failure that happens inside the lock once, without retrying', async () => {
      const storage = new FakeStorage(1);
      const { locks, names } = fakeLocks();
      const spy = silenceConsole();

      const result = await new WebStorageErrorAdapter(storage, { locks }).log(
        entry('too big')
      );

      expect(result.ok).toBe(false);
      expect(names).toHaveLength(1);
      spy.mockRestore();
    });

    it('works without locks when null is passed', async () => {
      const storage = new FakeStorage();
      const result = await new WebStorageErrorAdapter(storage, {
        locks: null,
      }).log(entry('x'));
      expect(result).toEqual({ ok: true });
    });

    it('uses navigator.locks by default when the browser provides it', async () => {
      const storage = new FakeStorage();
      const { locks, names } = fakeLocks();
      vi.stubGlobal('navigator', { locks });

      await new WebStorageErrorAdapter(storage).log(entry('x'));

      expect(names).toEqual(['error-log-adapter:error_log']);
      vi.unstubAllGlobals();
    });
  });

  it('stores an entry whose cause is circular, marking the loop', async () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const storage = new FakeStorage();

    const result = await new WebStorageErrorAdapter(storage).log({
      ...entry('x'),
      cause: circular,
    });

    expect(result).toEqual({ ok: true });
    expect(storage.getItem('error_log')).toContain('[Circular]');
  });

  it.each([0, -1, 1.5, Number.NaN])(
    'rejects maxEntries of %s',
    (maxEntries: number) => {
      expect(
        () => new WebStorageErrorAdapter(new FakeStorage(), { maxEntries })
      ).toThrowError(/maxEntries must be a positive integer/);
    }
  );
});
