import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BatchingErrorAdapter } from '@richardmcquiston01/error-log-adapter';
import type { ErrorLogEntry } from '@richardmcquiston01/error-log-adapter';
import {
  DEFAULT_ROUTING_KEY,
  RabbitMqErrorAdapter,
} from './rabbitmq-error-adapter.js';
import type {
  AmqpChannelLike,
  AmqpPublishOptions,
} from './rabbitmq-error-adapter.js';

interface Published {
  exchange: string;
  routingKey: string;
  body: Record<string, unknown>;
  options: AmqpPublishOptions | undefined;
}

interface FakeChannel extends AmqpChannelLike {
  published: Published[];
}

type Behavior = (callback?: (error: unknown, ok?: unknown) => void) => void;

/** A channel that records what it was given and lets each test decide how the broker answers. */
function fakeChannel(behavior: Behavior = (cb) => cb?.(null)): FakeChannel {
  const published: Published[] = [];
  return {
    published,
    publish(exchange, routingKey, content, options, callback): boolean {
      published.push({
        exchange,
        routingKey,
        body: JSON.parse(content.toString('utf8')) as Record<string, unknown>,
        options,
      });
      behavior(callback);
      return true;
    },
  };
}

const entry: ErrorLogEntry = {
  code: 'DB_DOWN',
  message: 'cannot reach the database',
  source: 'checkout',
  timestamp: '2026-10-19T05:00:00.000Z',
  id: '3f2b8c1e-5a7d-4e21-9c0a-1b2c3d4e5f60',
};

describe('RabbitMqErrorAdapter', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('publishes the serialized entry to the default exchange and queue', async () => {
    const channel = fakeChannel();
    const result = await new RabbitMqErrorAdapter(channel).log(entry);
    expect(result).toEqual({ ok: true });
    expect(channel.published).toHaveLength(1);
    const [message] = channel.published as [Published];
    expect(message.exchange).toBe('');
    expect(message.routingKey).toBe(DEFAULT_ROUTING_KEY);
    expect(message.body).toMatchObject({
      id: entry.id,
      code: 'DB_DOWN',
      message: 'cannot reach the database',
      source: 'checkout',
      timestamp: entry.timestamp,
    });
  });

  it('sets message properties and headers consumers can route on', async () => {
    const channel = fakeChannel();
    await new RabbitMqErrorAdapter(channel).log(entry);
    expect(channel.published[0]?.options).toEqual({
      persistent: true,
      contentType: 'application/json',
      messageId: entry.id,
      timestamp: Date.parse(entry.timestamp as string) / 1000,
      type: 'DB_DOWN',
      headers: { code: 'DB_DOWN', source: 'checkout' },
    });
  });

  it('honors exchange, routingKey, persistent and headers options', async () => {
    const channel = fakeChannel();
    await new RabbitMqErrorAdapter(channel, {
      exchange: 'errors',
      routingKey: 'checkout.db',
      persistent: false,
      headers: false,
    }).log(entry);
    const [message] = channel.published as [Published];
    expect(message.exchange).toBe('errors');
    expect(message.routingKey).toBe('checkout.db');
    expect(message.options?.persistent).toBe(false);
    expect(message.options?.headers).toBeUndefined();
  });

  it('generates an id when the entry has none and does not mutate the entry', async () => {
    const channel = fakeChannel();
    const bare: ErrorLogEntry = { code: 'X', message: 'y' };
    await new RabbitMqErrorAdapter(channel).log(bare);
    expect(bare).toEqual({ code: 'X', message: 'y' });
    expect(channel.published[0]?.body['id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(channel.published[0]?.options?.headers).toEqual({ code: 'X' });
  });

  it('does not wait for the broker unless confirm is on', async () => {
    const channel = fakeChannel(() => undefined); // never calls back
    const result = await new RabbitMqErrorAdapter(channel).log(entry);
    expect(result.ok).toBe(true);
  });

  it('waits for the broker confirmation when confirm is on', async () => {
    const channel = fakeChannel((cb) => cb?.(null, {}));
    const result = await new RabbitMqErrorAdapter(channel, {
      confirm: true,
    }).log(entry);
    expect(result).toEqual({ ok: true });
  });

  it('reports a nack from the broker', async () => {
    const channel = fakeChannel((cb) => cb?.(new Error('nacked')));
    const result = await new RabbitMqErrorAdapter(channel, {
      confirm: true,
    }).log(entry);
    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      'RabbitMqErrorAdapter failed to publish to queue "error_log" on the default exchange: nacked'
    );
  });

  it('times out when the broker never confirms', async () => {
    const channel = fakeChannel(() => undefined);
    const result = await new RabbitMqErrorAdapter(channel, {
      confirm: true,
      timeoutMs: 20,
    }).log(entry);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('did not confirm the message within 20 ms');
  });

  it('turns a throwing channel into a failed result', async () => {
    const channel: AmqpChannelLike = {
      publish(): boolean {
        throw new Error('Channel closed');
      },
    };
    const result = await new RabbitMqErrorAdapter(channel, {
      exchange: 'errors',
      routingKey: 'a',
    }).log(entry);
    expect(result).toEqual({
      ok: false,
      error:
        'RabbitMqErrorAdapter failed to publish to exchange "errors" with routing key "a": Channel closed',
    });
  });

  it('rejects an invalid entry id without publishing', async () => {
    const channel = fakeChannel();
    const result = await new RabbitMqErrorAdapter(channel).log({
      ...entry,
      id: 'not-a-uuid',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('entry.id must be a UUID');
    expect(channel.published).toHaveLength(0);
  });

  it('uses the configured prefix for the console report', async () => {
    const channel: AmqpChannelLike = {
      publish(): boolean {
        throw new Error('boom');
      },
    };
    await new RabbitMqErrorAdapter(channel, { prefix: '[app]' }).log(entry);
    expect(console.error).toHaveBeenCalledWith(
      '[app] RabbitMqErrorAdapter:',
      expect.any(Error)
    );
  });

  it('rejects options that can never work', () => {
    const channel = fakeChannel();
    expect(() => new RabbitMqErrorAdapter(channel, { routingKey: '' })).toThrow(
      RangeError
    );
    expect(() => new RabbitMqErrorAdapter(channel, { timeoutMs: 0 })).toThrow(
      RangeError
    );
    expect(
      () => new RabbitMqErrorAdapter(channel, { exchange: 'e', routingKey: '' })
    ).not.toThrow();
  });

  describe('logBatch', () => {
    it('publishes every entry in order', async () => {
      const channel = fakeChannel();
      const result = await new RabbitMqErrorAdapter(channel).logBatch([
        { code: 'A', message: 'one' },
        { code: 'B', message: 'two' },
      ]);
      expect(result).toEqual({ ok: true });
      expect(channel.published.map((p) => p.body['code'])).toEqual(['A', 'B']);
    });

    it('succeeds on an empty batch without publishing', async () => {
      const channel = fakeChannel();
      expect(await new RabbitMqErrorAdapter(channel).logBatch([])).toEqual({
        ok: true,
      });
      expect(channel.published).toHaveLength(0);
    });

    it('publishes nothing when one entry is invalid', async () => {
      const channel = fakeChannel();
      const result = await new RabbitMqErrorAdapter(channel).logBatch([
        { code: 'A', message: 'one' },
        { code: 'B', message: 'two', id: 'nope' },
      ]);
      expect(result.ok).toBe(false);
      expect(result.error).toContain(
        'entry 1 could not be prepared, so nothing was published'
      );
      expect(channel.published).toHaveLength(0);
    });

    it('stops at the first failure and says how many went out', async () => {
      let calls = 0;
      const channel = fakeChannel((cb) => {
        calls += 1;
        cb?.(calls === 2 ? new Error('nacked') : null);
      });
      const result = await new RabbitMqErrorAdapter(channel, {
        confirm: true,
      }).logBatch([
        { code: 'A', message: '1' },
        { code: 'B', message: '2' },
        { code: 'C', message: '3' },
      ]);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('nacked');
      expect(result.error).toContain(
        '1 of 3 entries were published before this'
      );
      expect(channel.published).toHaveLength(2);
    });

    it('is used by BatchingErrorAdapter', async () => {
      const channel = fakeChannel();
      const batching = new BatchingErrorAdapter(
        new RabbitMqErrorAdapter(channel),
        { batchSize: 2, maxWaitMs: Infinity }
      );
      await batching.log({ code: 'A', message: '1' });
      await batching.log({ code: 'B', message: '2' });
      await batching.flush();
      expect(channel.published).toHaveLength(2);
    });
  });
});
