/**
 * Live test for RedisErrorAdapter against a real Redis (or Valkey) server
 * through node-redis. It is skipped unless REDIS_TEST_URL is set, so
 * `bun run test` and CI never touch a server.
 *
 * Start a server and run it:
 *
 *   docker run -d -p 6379:6379 redis:7 redis-server --requirepass livetest123
 *   REDIS_TEST_URL=redis://:livetest123@127.0.0.1:6379 bun run test:live
 *
 * Every key the test writes starts with `error_log_live_test_<id>_` and the
 * test deletes them when it finishes.
 */
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisErrorAdapter } from './redis-error-adapter.js';
import type { RedisClientLike } from './redis-error-adapter.js';

const url: string | undefined = process.env['REDIS_TEST_URL'];
const isConfigured: boolean = url !== undefined;

const runId: string = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const keyPrefix = `error_log_live_test_${runId}_`;

interface Stored {
  id: string;
  code: string;
  message: string;
  cause?: unknown;
  source?: string;
  timestamp: string;
}

describe.skipIf(!isConfigured)(
  'RedisErrorAdapter against a real server',
  () => {
    const client = createClient({ url: url ?? 'redis://127.0.0.1:6379' });
    const keys: string[] = [];

    function newKey(name: string): string {
      const key = `${keyPrefix}${name}`;
      keys.push(key);
      return key;
    }

    /** node-redis' `sendCommand` already fits `RedisClientLike`. */
    const like: RedisClientLike = {
      sendCommand: (args) => client.sendCommand(args),
    };

    async function listItems(key: string): Promise<Stored[]> {
      const items = (await client.lRange(key, 0, -1)) as string[];
      return items.map((item) => JSON.parse(item) as Stored);
    }

    async function streamEntries(
      key: string
    ): Promise<{ message: Record<string, string> }[]> {
      const entries = await client.xRange(key, '-', '+');
      if (entries === null) {
        throw new Error(`stream "${key}" does not exist`);
      }
      return entries;
    }

    beforeAll(async () => {
      await client.connect();
    });

    afterAll(async () => {
      if (keys.length > 0) {
        await client.del(keys);
      }
      await client.quit();
    });

    it('pushes an entry onto a list as one JSON string', async () => {
      const key = newKey('basic');
      const adapter = new RedisErrorAdapter(like, { key });
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
      const [stored] = await listItems(key);
      expect(stored).toMatchObject({
        id,
        code: 'LIVE_ONE',
        message: 'first live entry',
        source: 'live-test',
        timestamp: '2026-01-02T03:04:05.678Z',
      });
      expect(JSON.stringify(stored?.cause)).toContain('the cause');
    });

    it('stores awkward text exactly as given', async () => {
      const key = newKey('text');
      const adapter = new RedisErrorAdapter(like, { key });
      const message =
        'quote " backslash \\ new line \n tab \t é 日本 😀 \u0000 control {"a":1}';
      await adapter.log({ code: 'LIVE_TEXT', message });
      expect((await listItems(key))[0]?.message).toBe(message);
    });

    it('keeps the newest entry last with side right and first with side left', async () => {
      const right = newKey('right');
      const left = newKey('left');
      const rightAdapter = new RedisErrorAdapter(like, { key: right });
      const leftAdapter = new RedisErrorAdapter(like, {
        key: left,
        side: 'left',
      });
      for (const n of [1, 2, 3]) {
        await rightAdapter.log({ code: 'LIVE_SIDE', message: `entry ${n}` });
        await leftAdapter.log({ code: 'LIVE_SIDE', message: `entry ${n}` });
      }
      expect((await listItems(right)).map((item) => item.message)).toEqual([
        'entry 1',
        'entry 2',
        'entry 3',
      ]);
      expect((await listItems(left)).map((item) => item.message)).toEqual([
        'entry 3',
        'entry 2',
        'entry 1',
      ]);
    });

    it('drops the oldest list entries past maxEntries, on either side', async () => {
      const right = newKey('cap_right');
      const left = newKey('cap_left');
      const rightAdapter = new RedisErrorAdapter(like, {
        key: right,
        maxEntries: 2,
      });
      const leftAdapter = new RedisErrorAdapter(like, {
        key: left,
        side: 'left',
        maxEntries: 2,
      });
      for (const n of [1, 2, 3, 4]) {
        await rightAdapter.log({ code: 'LIVE_CAP', message: `entry ${n}` });
        await leftAdapter.log({ code: 'LIVE_CAP', message: `entry ${n}` });
      }
      expect((await listItems(right)).map((item) => item.message)).toEqual([
        'entry 3',
        'entry 4',
      ]);
      expect((await listItems(left)).map((item) => item.message)).toEqual([
        'entry 4',
        'entry 3',
      ]);
    });

    it('appends an entry to a stream as separate fields', async () => {
      const key = newKey('stream');
      const adapter = new RedisErrorAdapter(like, { key, mode: 'stream' });
      const id = '4a2b8c1e-5a7d-4e21-9c0a-1b2c3d4e5f61';
      expect(
        await adapter.log({
          id,
          code: 'LIVE_STREAM',
          message: 'streamed',
          source: 'live-test',
          cause: new Error('the cause'),
          timestamp: '2026-02-03T00:00:00.000Z',
        })
      ).toEqual({ ok: true });
      await adapter.log({ code: 'LIVE_STREAM', message: 'no extras' });
      const entries = await streamEntries(key);
      expect(entries).toHaveLength(2);
      expect(entries[0]?.message).toMatchObject({
        id,
        code: 'LIVE_STREAM',
        message: 'streamed',
        source: 'live-test',
        timestamp: '2026-02-03T00:00:00.000Z',
      });
      expect(entries[0]?.message['cause']).toContain('the cause');
      expect('cause' in (entries[1]?.message ?? {})).toBe(false);
      expect('source' in (entries[1]?.message ?? {})).toBe(false);
    });

    it('caps a stream at exactly maxEntries', async () => {
      const key = newKey('stream_cap');
      const adapter = new RedisErrorAdapter(like, {
        key,
        mode: 'stream',
        maxEntries: 3,
      });
      for (const n of [1, 2, 3, 4, 5]) {
        await adapter.log({ code: 'LIVE_CAP', message: `entry ${n}` });
      }
      const entries = await streamEntries(key);
      expect(entries.map((entry) => entry.message['message'])).toEqual([
        'entry 3',
        'entry 4',
        'entry 5',
      ]);
    });

    it('stores a repeated entry twice, since Redis cannot detect a repeat', async () => {
      const key = newKey('repeat');
      const adapter = new RedisErrorAdapter(like, { key });
      const entry = {
        id: '11111111-2222-4333-8444-555555555555',
        code: 'LIVE_REPEAT',
        message: 'logged twice',
      };
      await adapter.log(entry);
      await adapter.log(entry);
      expect(await listItems(key)).toHaveLength(2);
    });

    it('reports a key of the wrong type instead of throwing', async () => {
      const key = newKey('wrongtype');
      await client.set(key, 'a string, not a list');
      const adapter = new RedisErrorAdapter(like, { key });
      const result = await adapter.log({ code: 'LIVE_FAIL', message: 'no' });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('WRONGTYPE');
    });

    it('reports a command the server refuses (no write permission) instead of throwing', async () => {
      const user = `${keyPrefix}readonly`;
      await client.sendCommand([
        'ACL',
        'SETUSER',
        user,
        'on',
        '>readonlypw',
        '+@read',
        '+auth',
        '~*',
      ]);
      const limitedUrl = new URL(url ?? 'redis://127.0.0.1:6379');
      limitedUrl.username = user;
      limitedUrl.password = 'readonlypw';
      const limited = createClient({ url: limitedUrl.toString() });
      limited.on('error', () => undefined);
      await limited.connect();
      try {
        const adapter = new RedisErrorAdapter(
          { sendCommand: (args) => limited.sendCommand(args) },
          { key: newKey('noperm'), timeoutMs: 15_000 }
        );
        const result = await adapter.log({ code: 'LIVE_FAIL', message: 'no' });
        expect(result.ok).toBe(false);
        expect(result.error).toContain('NOPERM');
      } finally {
        await limited.disconnect();
        await client.sendCommand(['ACL', 'DELUSER', user]);
      }
    });

    it('reports an unreachable server instead of throwing', async () => {
      const dead = createClient({
        url: 'redis://127.0.0.1:1',
        socket: { reconnectStrategy: false },
      });
      dead.on('error', () => undefined);
      const adapter = new RedisErrorAdapter(
        { sendCommand: (args) => dead.sendCommand(args) },
        { key: newKey('dead'), timeoutMs: 15_000 }
      );
      const result = await adapter.log({ code: 'LIVE_FAIL', message: 'no' });
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    });
  }
);
