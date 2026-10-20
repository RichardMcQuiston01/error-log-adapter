import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BatchingErrorAdapter } from '@richardmcquiston01/error-log-adapter';
import type { ErrorLogEntry } from '@richardmcquiston01/error-log-adapter';
import {
  DEFAULT_KEY_PREFIX,
  MemcachedErrorAdapter,
  counterKey,
  entryKey,
  recentSlotKeys,
  slotKey,
} from './memcached-error-adapter.js';
import type {
  MemcachedClientLike,
  MemcachedStoredEntry,
} from './memcached-error-adapter.js';

interface Stored {
  value: string;
  expires: number | undefined;
}

interface FakeMemcached extends MemcachedClientLike {
  data: Map<string, Stored>;
  calls: string[];
  /** Makes the named method reject, once or always. */
  failOn: (method: string, error: Error, times?: number) => void;
}

function fakeClient(): FakeMemcached {
  const data = new Map<string, Stored>();
  const calls: string[] = [];
  const failures = new Map<string, { error: Error; times: number }>();
  function check(method: string): void {
    calls.push(method);
    const failure = failures.get(method);
    if (failure !== undefined && failure.times > 0) {
      failure.times -= 1;
      throw failure.error;
    }
  }
  return {
    data,
    calls,
    failOn(method, error, times = Infinity): void {
      failures.set(method, { error, times });
    },
    async add(key, value, options): Promise<boolean> {
      check('add');
      if (data.has(key)) {
        return false;
      }
      data.set(key, { value, expires: options?.expires });
      return true;
    },
    async set(key, value, options): Promise<boolean> {
      check('set');
      data.set(key, { value, expires: options?.expires });
      return true;
    },
    async delete(key): Promise<boolean> {
      check('delete');
      return data.delete(key);
    },
    async increment(key, amount, options) {
      check('increment');
      const existing = data.get(key);
      if (existing === undefined) {
        const initial: number = options?.initial ?? 0;
        data.set(key, { value: String(initial), expires: options?.expires });
        return { success: true, value: initial };
      }
      const next: number = Number(existing.value) + amount;
      data.set(key, { value: String(next), expires: existing.expires });
      return { success: true, value: next };
    },
  };
}

function ids(client: FakeMemcached): string[] {
  return [...client.data.keys()].filter(
    (key) => !key.includes('recent:') && !key.endsWith('count')
  );
}

describe('MemcachedErrorAdapter', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stores an entry as JSON under its id with the default seven day expiry', async () => {
    const client = fakeClient();
    const adapter = new MemcachedErrorAdapter(client);
    const id = '3f2b8c1e-5a7d-4e21-9c0a-1b2c3d4e5f60';
    const result = await adapter.log({
      id,
      code: 'DB_DOWN',
      message: 'cannot reach the database',
      source: 'checkout',
      cause: new Error('ECONNREFUSED'),
      timestamp: '2026-01-02T03:04:05.678Z',
    });
    expect(result).toEqual({ ok: true });
    const stored = client.data.get(`${DEFAULT_KEY_PREFIX}${id}`);
    expect(stored?.expires).toBe(7 * 24 * 60 * 60);
    const entry = JSON.parse(stored?.value ?? '{}') as MemcachedStoredEntry;
    expect(entry).toMatchObject({
      id,
      code: 'DB_DOWN',
      message: 'cannot reach the database',
      source: 'checkout',
      occurred_at: '2026-01-02T03:04:05.678Z',
    });
    expect(JSON.stringify(entry.cause)).toContain('ECONNREFUSED');
    expect(typeof entry.created_at).toBe('string');
  });

  it('leaves out an absent cause and source', async () => {
    const client = fakeClient();
    const adapter = new MemcachedErrorAdapter(client);
    const id = '4a2b8c1e-5a7d-4e21-9c0a-1b2c3d4e5f61';
    await adapter.log({ id, code: 'X', message: 'plain' });
    const entry = JSON.parse(
      client.data.get(entryKey(id))?.value ?? '{}'
    ) as Record<string, unknown>;
    expect('cause' in entry).toBe(false);
    expect('source' in entry).toBe(false);
  });

  it('numbers new entries and points the recent list at them', async () => {
    const client = fakeClient();
    const adapter = new MemcachedErrorAdapter(client, { ringSize: 3 });
    const entries: ErrorLogEntry[] = [0, 1, 2, 3, 4].map((n) => ({
      id: `00000000-0000-4000-8000-00000000000${n}`,
      code: 'X',
      message: `entry ${n}`,
    }));
    for (const entry of entries) {
      expect(await adapter.log(entry)).toEqual({ ok: true });
    }
    const counter = Number(client.data.get(counterKey())?.value);
    expect(counter).toBe(4);
    const newestFirst = recentSlotKeys(counter, { ringSize: 3 }).map(
      (key) => client.data.get(key)?.value
    );
    expect(newestFirst).toEqual([
      '00000000-0000-4000-8000-000000000004',
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000002',
    ]);
  });

  it('treats a repeat of the same id as success and does not list it twice', async () => {
    const client = fakeClient();
    const adapter = new MemcachedErrorAdapter(client);
    const entry: ErrorLogEntry = {
      id: '11111111-2222-4333-8444-555555555555',
      code: 'X',
      message: 'first',
    };
    expect(await adapter.log(entry)).toEqual({ ok: true });
    expect(await adapter.log({ ...entry, message: 'second' })).toEqual({
      ok: true,
    });
    expect(ids(client)).toHaveLength(1);
    expect(
      (
        JSON.parse(
          client.data.get(entryKey(entry.id ?? ''))?.value ?? '{}'
        ) as {
          message: string;
        }
      ).message
    ).toBe('first');
    expect(Number(client.data.get(counterKey())?.value)).toBe(0);
    expect(client.calls.filter((call) => call === 'increment')).toHaveLength(1);
  });

  it('skips the counter and slots when ringSize is 0', async () => {
    const client = fakeClient();
    const adapter = new MemcachedErrorAdapter(client, { ringSize: 0 });
    await adapter.log({ code: 'X', message: 'no list' });
    expect(client.calls).toEqual(['add']);
  });

  it('uses keyPrefix and ttlSeconds', async () => {
    const client = fakeClient();
    const adapter = new MemcachedErrorAdapter(client, {
      keyPrefix: 'app1:err:',
      ttlSeconds: 60,
      ringSize: 5,
    });
    const id = '5b2b8c1e-5a7d-4e21-9c0a-1b2c3d4e5f62';
    await adapter.log({ id, code: 'X', message: 'prefixed' });
    expect(client.data.get(`app1:err:${id}`)?.expires).toBe(60);
    expect(client.data.get(slotKey(0, 'app1:err:'))?.value).toBe(id);
    expect(client.data.has(counterKey('app1:err:'))).toBe(true);
  });

  it('takes the entry back when the recent list cannot be updated, so a retry lists it', async () => {
    const client = fakeClient();
    const adapter = new MemcachedErrorAdapter(client);
    client.failOn('increment', new Error('server went away'), 1);
    const entry: ErrorLogEntry = {
      id: '66666666-2222-4333-8444-555555555555',
      code: 'X',
      message: 'retry me',
    };
    const first = await adapter.log(entry);
    expect(first.ok).toBe(false);
    expect(first.error).toContain('server went away');
    expect(client.data.has(entryKey(entry.id ?? ''))).toBe(false);
    expect(await adapter.log(entry)).toEqual({ ok: true });
    expect(client.data.get(slotKey(0))?.value).toBe(entry.id);
  });

  it('returns ok: false with the reason when add fails', async () => {
    const client = fakeClient();
    client.failOn('add', new Error('connection refused'));
    const adapter = new MemcachedErrorAdapter(client);
    const result = await adapter.log({ code: 'X', message: 'no' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('connection refused');
    expect(result.error).toContain('to store an entry');
  });

  it('times out a request that never answers', async () => {
    const client = fakeClient();
    client.add = (): Promise<boolean> => new Promise(() => undefined);
    const adapter = new MemcachedErrorAdapter(client, { timeoutMs: 20 });
    const result = await adapter.log({ code: 'X', message: 'slow' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Memcached/);
    expect(result.error).toContain('20');
  });

  it('refuses a value larger than maxValueBytes without calling the server', async () => {
    const client = fakeClient();
    const adapter = new MemcachedErrorAdapter(client, { maxValueBytes: 200 });
    const result = await adapter.log({ code: 'X', message: 'm'.repeat(500) });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('maxValueBytes');
    expect(client.calls).toEqual([]);
  });

  it('refuses an id that makes an invalid key, without calling the server', async () => {
    const client = fakeClient();
    const adapter = new MemcachedErrorAdapter(client);
    const result = await adapter.log({
      id: 'has a space',
      code: 'X',
      message: 'bad id',
    });
    expect(result.ok).toBe(false);
    expect(client.calls).toEqual([]);
  });

  it('refuses an invalid timestamp', async () => {
    const client = fakeClient();
    const adapter = new MemcachedErrorAdapter(client);
    const result = await adapter.log({
      code: 'X',
      message: 'bad time',
      timestamp: 'yesterday',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not a valid ISO 8601 date');
  });

  describe('options', () => {
    it.each([
      [{ ttlSeconds: 0 }, /ttlSeconds/],
      [{ ttlSeconds: 1.5 }, /ttlSeconds/],
      [{ ttlSeconds: 31 * 24 * 60 * 60 }, /30 days/],
      [{ ringSize: -1 }, /ringSize/],
      [{ ringSize: 1.5 }, /ringSize/],
      [{ keyPrefix: 'has space' }, /keyPrefix/],
      [{ keyPrefix: 'x'.repeat(101) }, /keyPrefix/],
      [{ maxValueBytes: 0 }, /maxValueBytes/],
      [{ timeoutMs: -5 }, /timeoutMs/],
    ])('rejects %j', (options, message) => {
      expect(() => new MemcachedErrorAdapter(fakeClient(), options)).toThrow(
        message
      );
    });
  });

  describe('logBatch', () => {
    it('stores every entry in order', async () => {
      const client = fakeClient();
      const adapter = new MemcachedErrorAdapter(client);
      const entries: ErrorLogEntry[] = [1, 2, 3].map((n) => ({
        code: 'X',
        message: `entry ${n}`,
      }));
      expect(await adapter.logBatch(entries)).toEqual({ ok: true });
      expect(ids(client)).toHaveLength(3);
      expect(Number(client.data.get(counterKey())?.value)).toBe(2);
    });

    it('does nothing for an empty batch', async () => {
      const client = fakeClient();
      const adapter = new MemcachedErrorAdapter(client);
      expect(await adapter.logBatch([])).toEqual({ ok: true });
      expect(client.calls).toEqual([]);
    });

    it('checks every entry first and stores nothing if one is invalid', async () => {
      const client = fakeClient();
      const adapter = new MemcachedErrorAdapter(client);
      const result = await adapter.logBatch([
        { code: 'X', message: 'fine' },
        { code: 'X', message: 'bad', timestamp: 'nope' },
      ]);
      expect(result.ok).toBe(false);
      expect(result.error).toContain(
        'entry 1 could not be prepared, so nothing was stored'
      );
      expect(client.calls).toEqual([]);
    });

    it('stops at the first failure and says how many were stored', async () => {
      const client = fakeClient();
      const adapter = new MemcachedErrorAdapter(client, { ringSize: 0 });
      let adds = 0;
      const realAdd = client.add.bind(client);
      client.add = async (key, value, options): Promise<boolean> => {
        adds += 1;
        if (adds === 3) {
          throw new Error('server went away');
        }
        return realAdd(key, value, options);
      };
      const result = await adapter.logBatch(
        [1, 2, 3, 4].map((n) => ({ code: 'X', message: `entry ${n}` }))
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain('2 of 4 entries were stored before this');
      expect(adds).toBe(3);
    });

    it('is used by BatchingErrorAdapter', async () => {
      const client = fakeClient();
      const batching = new BatchingErrorAdapter(
        new MemcachedErrorAdapter(client),
        { batchSize: 2, maxWaitMs: 5 }
      );
      await batching.log({ code: 'X', message: 'one' });
      await batching.log({ code: 'X', message: 'two' });
      expect(await batching.flush()).toEqual({ ok: true });
      expect(ids(client)).toHaveLength(2);
    });
  });

  describe('recentSlotKeys', () => {
    it('lists the newest slots first and wraps around the ring', () => {
      expect(recentSlotKeys(0, { ringSize: 3 })).toEqual([slotKey(0)]);
      expect(recentSlotKeys(4, { ringSize: 3 })).toEqual([
        slotKey(1),
        slotKey(0),
        slotKey(2),
      ]);
    });

    it('lists only what has been written before the ring is full', () => {
      expect(recentSlotKeys(1, { ringSize: 5 })).toEqual([
        slotKey(1),
        slotKey(0),
      ]);
    });

    it('returns nothing for a ring of 0', () => {
      expect(recentSlotKeys(10, { ringSize: 0 })).toEqual([]);
    });

    it('rejects a counter that is not a whole number', () => {
      expect(() => recentSlotKeys(-1)).toThrow(/counter/);
      expect(() => recentSlotKeys(1.5)).toThrow(/counter/);
    });
  });
});
