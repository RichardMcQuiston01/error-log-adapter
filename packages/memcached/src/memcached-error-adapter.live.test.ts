/**
 * Live test for MemcachedErrorAdapter against a real Memcached server through
 * the real `memjs` client. It is skipped unless MEMCACHED_TEST_SERVER is set, so
 * `bun run test` and CI never touch a server.
 *
 * Start a server and run it:
 *
 *   docker run -d -p 11211:11211 memcached:1.6
 *   MEMCACHED_TEST_SERVER=127.0.0.1:11211 bun run test:live
 *
 * Every key the test writes starts with `error_log_live_test_<id>:` and the test
 * deletes them when it finishes.
 */
import { Client } from 'memjs';
import { afterAll, describe, expect, it } from 'vitest';
import type { ErrorLogEntry } from '@richardmcquiston01/error-log-adapter';
import {
  MemcachedErrorAdapter,
  counterKey,
  entryKey,
  recentSlotKeys,
  slotKey,
} from './memcached-error-adapter.js';
import type { MemcachedStoredEntry } from './memcached-error-adapter.js';

const server: string | undefined = process.env['MEMCACHED_TEST_SERVER'];
const isConfigured: boolean = server !== undefined;

const runId: string = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

describe.skipIf(!isConfigured)(
  'MemcachedErrorAdapter against a real server',
  () => {
    const client: Client = Client.create(server ?? '127.0.0.1:11211');
    const written: string[] = [];

    function newPrefix(name: string): string {
      return `error_log_live_test_${runId}_${name}:`;
    }

    async function read(key: string): Promise<string | null> {
      written.push(key);
      const { value } = await client.get(key);
      return value === null ? null : value.toString('utf8');
    }

    afterAll(async () => {
      for (const key of written) {
        await client.delete(key);
      }
      client.close();
    });

    it('stores an entry as JSON under its id', async () => {
      const keyPrefix = newPrefix('basic');
      const adapter = new MemcachedErrorAdapter(client, { keyPrefix });
      const id = '3f2b8c1e-5a7d-4e21-9c0a-1b2c3d4e5f60';
      const result = await adapter.log({
        id,
        code: 'LIVE_ONE',
        message: 'first live entry',
        source: 'live-test',
        cause: new Error('the cause'),
        timestamp: '2026-01-02T03:04:05.678Z',
      });
      expect(result).toEqual({ ok: true });

      const stored = JSON.parse(
        (await read(entryKey(id, keyPrefix))) ?? '{}'
      ) as MemcachedStoredEntry;
      expect(stored).toMatchObject({
        id,
        code: 'LIVE_ONE',
        message: 'first live entry',
        source: 'live-test',
        occurred_at: '2026-01-02T03:04:05.678Z',
      });
      expect(JSON.stringify(stored.cause)).toContain('the cause');
    });

    it('stores awkward text exactly as given', async () => {
      const keyPrefix = newPrefix('text');
      const adapter = new MemcachedErrorAdapter(client, { keyPrefix });
      const id = '4a2b8c1e-5a7d-4e21-9c0a-1b2c3d4e5f61';
      const message =
        'quote " backslash \\ new line \n tab \t é 日本 😀 \u0000 control';
      await adapter.log({ id, code: 'LIVE_TEXT', message });
      const stored = JSON.parse(
        (await read(entryKey(id, keyPrefix))) ?? '{}'
      ) as MemcachedStoredEntry;
      expect(stored.message).toBe(message);
    });

    it('keeps the first write when the same entry is logged again, and lists it once', async () => {
      const keyPrefix = newPrefix('repeat');
      const adapter = new MemcachedErrorAdapter(client, {
        keyPrefix,
        ringSize: 5,
      });
      const id = '11111111-2222-4333-8444-555555555555';
      expect(
        await adapter.log({ id, code: 'LIVE_REPEAT', message: 'first' })
      ).toEqual({ ok: true });
      expect(
        await adapter.log({ id, code: 'LIVE_REPEAT', message: 'second' })
      ).toEqual({ ok: true });
      const stored = JSON.parse(
        (await read(entryKey(id, keyPrefix))) ?? '{}'
      ) as MemcachedStoredEntry;
      expect(stored.message).toBe('first');
      expect(await read(counterKey(keyPrefix))).toBe('0');
      expect(await read(slotKey(0, keyPrefix))).toBe(id);
      expect(await read(slotKey(1, keyPrefix))).toBeNull();
    });

    it('keeps a recent list of the newest entries, wrapping around', async () => {
      const keyPrefix = newPrefix('ring');
      const adapter = new MemcachedErrorAdapter(client, {
        keyPrefix,
        ringSize: 3,
      });
      const entries: ErrorLogEntry[] = [0, 1, 2, 3, 4].map((n) => ({
        id: `00000000-0000-4000-8000-00000000000${n}`,
        code: 'LIVE_RING',
        message: `entry ${n}`,
      }));
      for (const entry of entries) {
        expect(await adapter.log(entry)).toEqual({ ok: true });
      }
      const counter = Number(await read(counterKey(keyPrefix)));
      expect(counter).toBe(4);
      const recent: (string | null)[] = [];
      for (const key of recentSlotKeys(counter, { keyPrefix, ringSize: 3 })) {
        recent.push(await read(key));
      }
      expect(recent).toEqual([
        '00000000-0000-4000-8000-000000000004',
        '00000000-0000-4000-8000-000000000003',
        '00000000-0000-4000-8000-000000000002',
      ]);
      // The entry that fell out of the list is still stored until it expires.
      expect(
        await read(entryKey('00000000-0000-4000-8000-000000000000', keyPrefix))
      ).not.toBeNull();
    });

    it('does not use the counter when ringSize is 0', async () => {
      const keyPrefix = newPrefix('noring');
      const adapter = new MemcachedErrorAdapter(client, {
        keyPrefix,
        ringSize: 0,
      });
      await adapter.log({ code: 'LIVE_NORING', message: 'no list' });
      expect(await read(counterKey(keyPrefix))).toBeNull();
    });

    it('lets an entry expire after ttlSeconds', async () => {
      const keyPrefix = newPrefix('ttl');
      const adapter = new MemcachedErrorAdapter(client, {
        keyPrefix,
        ttlSeconds: 1,
      });
      const id = '5b2b8c1e-5a7d-4e21-9c0a-1b2c3d4e5f62';
      await adapter.log({ id, code: 'LIVE_TTL', message: 'expires' });
      expect(await read(entryKey(id, keyPrefix))).not.toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 2500));
      expect(await read(entryKey(id, keyPrefix))).toBeNull();
    });

    it('stores a batch', async () => {
      const keyPrefix = newPrefix('batch');
      const adapter = new MemcachedErrorAdapter(client, {
        keyPrefix,
        ringSize: 10,
      });
      const entries: ErrorLogEntry[] = [1, 2, 3, 4].map((n) => ({
        id: `22222222-2222-4333-8444-00000000000${n}`,
        code: 'LIVE_BATCH',
        message: `batch entry ${n}`,
      }));
      expect(await adapter.logBatch(entries)).toEqual({ ok: true });
      for (const entry of entries) {
        expect(await read(entryKey(entry.id ?? '', keyPrefix))).not.toBeNull();
      }
      expect(await read(counterKey(keyPrefix))).toBe('3');
    });

    it('refuses a value larger than the item limit instead of throwing', async () => {
      const keyPrefix = newPrefix('big');
      const adapter = new MemcachedErrorAdapter(client, {
        keyPrefix,
        maxValueBytes: 5_000_000,
      });
      const result = await adapter.log({
        code: 'LIVE_BIG',
        message: 'x'.repeat(2_000_000),
      });
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it('reports an unreachable server instead of throwing', async () => {
      const dead = Client.create('127.0.0.1:1', { retries: 1, timeout: 1 });
      const adapter = new MemcachedErrorAdapter(dead, {
        keyPrefix: newPrefix('dead'),
        timeoutMs: 15_000,
      });
      const result = await adapter.log({ code: 'LIVE_FAIL', message: 'no' });
      dead.close();
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    });
  }
);
