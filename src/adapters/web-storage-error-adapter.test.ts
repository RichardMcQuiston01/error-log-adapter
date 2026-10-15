import { describe, expect, it, vi } from 'vitest';
import type { ErrorLogEntry } from '../types.js';
import { WebStorageErrorAdapter } from './web-storage-error-adapter.js';
import type {
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
    const storage = new FakeStorage(10);
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
