import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BatchingErrorAdapter } from '@richardmcquiston01/error-log-adapter';
import type { ErrorLogEntry } from '@richardmcquiston01/error-log-adapter';
import {
  NatsErrorAdapter,
  NatsJetStreamErrorAdapter,
} from './nats-error-adapter.js';
import type {
  JetStreamClientLike,
  JetStreamPublishOptionsLike,
  NatsConnectionLike,
  NatsHeadersLike,
  NatsPublishOptionsLike,
} from './nats-error-adapter.js';

class FakeHeaders implements NatsHeadersLike {
  readonly values: Record<string, string> = {};
  set(key: string, value: string): void {
    this.values[key] = value;
  }
}

const createHeaders = (): NatsHeadersLike => new FakeHeaders();

interface Sent {
  subject: string;
  body: Record<string, unknown>;
  headers: Record<string, string> | undefined;
  msgID?: string;
  timeout?: number;
}

function decode(payload: Uint8Array | undefined): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(payload)) as Record<
    string,
    unknown
  >;
}

function headerValues(
  headers: NatsHeadersLike | undefined
): Record<string, string> | undefined {
  return (headers as FakeHeaders | undefined)?.values;
}

const entry: ErrorLogEntry = {
  code: 'DB_DOWN',
  message: 'cannot reach the database',
  source: 'checkout',
  timestamp: '2026-10-19T05:00:00.000Z',
  id: '3f2b8c1e-5a7d-4e21-9c0a-1b2c3d4e5f60',
};

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('NatsErrorAdapter', () => {
  function fakeConnection(flush?: () => Promise<void>): {
    connection: NatsConnectionLike;
    sent: Sent[];
  } {
    const sent: Sent[] = [];
    const connection: NatsConnectionLike = {
      publish(subject, payload, options?: NatsPublishOptionsLike): void {
        sent.push({
          subject,
          body: decode(payload),
          headers: headerValues(options?.headers),
        });
      },
    };
    if (flush !== undefined) {
      connection.flush = flush;
    }
    return { connection, sent };
  }

  it('publishes the serialized entry to the subject', async () => {
    const { connection, sent } = fakeConnection();
    const result = await new NatsErrorAdapter(connection, 'app.errors').log(
      entry
    );
    expect(result).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.subject).toBe('app.errors');
    expect(sent[0]?.body).toMatchObject({
      id: entry.id,
      code: 'DB_DOWN',
      message: 'cannot reach the database',
      source: 'checkout',
      timestamp: entry.timestamp,
    });
    expect(sent[0]?.headers).toBeUndefined();
  });

  it('sends code and source as headers when createHeaders is given', async () => {
    const { connection, sent } = fakeConnection();
    await new NatsErrorAdapter(connection, 'app.errors', {
      createHeaders,
    }).log(entry);
    expect(sent[0]?.headers).toEqual({ code: 'DB_DOWN', source: 'checkout' });
  });

  it('generates an id and does not mutate the entry', async () => {
    const { connection, sent } = fakeConnection();
    const bare: ErrorLogEntry = { code: 'X', message: 'y' };
    await new NatsErrorAdapter(connection, 'a').log(bare);
    expect(bare).toEqual({ code: 'X', message: 'y' });
    expect(sent[0]?.body['id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('flushes when asked and reports a flush failure', async () => {
    const flush = vi.fn(async () => undefined);
    const ok = fakeConnection(flush);
    expect(
      await new NatsErrorAdapter(ok.connection, 'a', { flush: true }).log(entry)
    ).toEqual({ ok: true });
    expect(flush).toHaveBeenCalledTimes(1);

    const bad = fakeConnection(() =>
      Promise.reject(new Error('CONNECTION_CLOSED'))
    );
    const result = await new NatsErrorAdapter(bad.connection, 'a', {
      flush: true,
    }).log(entry);
    expect(result).toEqual({
      ok: false,
      error:
        'NatsErrorAdapter failed to publish to subject "a": CONNECTION_CLOSED',
    });
  });

  it('times out a flush that never completes', async () => {
    const { connection } = fakeConnection(
      () => new Promise<void>(() => undefined)
    );
    const result = await new NatsErrorAdapter(connection, 'a', {
      flush: true,
      timeoutMs: 20,
    }).log(entry);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('did not flush within 20 ms');
  });

  it('turns a throwing connection into a failed result', async () => {
    const connection: NatsConnectionLike = {
      publish(): void {
        throw new Error('CONNECTION_DRAINING');
      },
    };
    const result = await new NatsErrorAdapter(connection, 'a').log(entry);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('CONNECTION_DRAINING');
  });

  it('rejects an invalid entry id without publishing', async () => {
    const { connection, sent } = fakeConnection();
    const result = await new NatsErrorAdapter(connection, 'a').log({
      ...entry,
      id: 'nope',
    });
    expect(result.ok).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('rejects options that can never work', () => {
    const { connection } = fakeConnection();
    for (const subject of ['', 'a..b', 'a b', 'a.*', 'a.>', '.a', 'a.']) {
      expect(() => new NatsErrorAdapter(connection, subject)).toThrow(
        RangeError
      );
    }
    expect(
      () => new NatsErrorAdapter(connection, 'a', { flush: true })
    ).toThrow('no flush() method');
    expect(
      () => new NatsErrorAdapter(connection, 'a', { timeoutMs: -1 })
    ).toThrow(RangeError);
    expect(
      () => new NatsErrorAdapter(connection, 'app.errors.v1')
    ).not.toThrow();
  });

  describe('logBatch', () => {
    it('publishes every entry in order and flushes once', async () => {
      const flush = vi.fn(async () => undefined);
      const { connection, sent } = fakeConnection(flush);
      const result = await new NatsErrorAdapter(connection, 'a', {
        flush: true,
      }).logBatch([
        { code: 'A', message: '1' },
        { code: 'B', message: '2' },
      ]);
      expect(result).toEqual({ ok: true });
      expect(sent.map((s) => s.body['code'])).toEqual(['A', 'B']);
      expect(flush).toHaveBeenCalledTimes(1);
    });

    it('publishes nothing when one entry is invalid', async () => {
      const { connection, sent } = fakeConnection();
      const result = await new NatsErrorAdapter(connection, 'a').logBatch([
        { code: 'A', message: '1' },
        { code: 'B', message: '2', id: 'nope' },
      ]);
      expect(result.ok).toBe(false);
      expect(result.error).toContain(
        'entry 1 could not be prepared, so nothing was published'
      );
      expect(sent).toHaveLength(0);
    });

    it('says how many were handed over when publishing fails midway', async () => {
      let calls = 0;
      const connection: NatsConnectionLike = {
        publish(): void {
          calls += 1;
          if (calls === 2) {
            throw new Error('CONNECTION_CLOSED');
          }
        },
      };
      const result = await new NatsErrorAdapter(connection, 'a').logBatch([
        { code: 'A', message: '1' },
        { code: 'B', message: '2' },
        { code: 'C', message: '3' },
      ]);
      expect(result.ok).toBe(false);
      expect(result.error).toContain(
        '1 of 3 entries were handed to the client before this'
      );
    });

    it('is used by BatchingErrorAdapter', async () => {
      const { connection, sent } = fakeConnection();
      const batching = new BatchingErrorAdapter(
        new NatsErrorAdapter(connection, 'a'),
        { batchSize: 2, maxWaitMs: Infinity }
      );
      await batching.log({ code: 'A', message: '1' });
      await batching.log({ code: 'B', message: '2' });
      await batching.flush();
      expect(sent).toHaveLength(2);
    });
  });
});

describe('NatsJetStreamErrorAdapter', () => {
  function fakeJetStream(
    behavior: (sent: Sent) => Promise<unknown> = async () => ({ seq: 1 })
  ): { jetstream: JetStreamClientLike; sent: Sent[] } {
    const sent: Sent[] = [];
    const jetstream: JetStreamClientLike = {
      publish(
        subject,
        payload,
        options?: JetStreamPublishOptionsLike
      ): Promise<unknown> {
        const record: Sent = {
          subject,
          body: decode(payload),
          headers: headerValues(options?.headers),
          ...(options?.msgID !== undefined && { msgID: options.msgID }),
          ...(options?.timeout !== undefined && { timeout: options.timeout }),
        };
        sent.push(record);
        return behavior(record);
      },
    };
    return { jetstream, sent };
  }

  it('publishes with the entry id as Nats-Msg-Id and waits for the ack', async () => {
    const { jetstream, sent } = fakeJetStream();
    const result = await new NatsJetStreamErrorAdapter(
      jetstream,
      'app.errors',
      { createHeaders }
    ).log(entry);
    expect(result).toEqual({ ok: true });
    expect(sent[0]).toMatchObject({
      subject: 'app.errors',
      msgID: entry.id,
      timeout: 10_000,
      headers: { code: 'DB_DOWN', source: 'checkout' },
    });
    expect(sent[0]?.body['id']).toBe(entry.id);
  });

  it('lower-cases the id so the same UUID always dedupes', async () => {
    const { jetstream, sent } = fakeJetStream();
    await new NatsJetStreamErrorAdapter(jetstream, 'a').log({
      ...entry,
      id: entry.id?.toUpperCase(),
    });
    expect(sent[0]?.msgID).toBe(entry.id);
  });

  it('does not send a client timeout when timeoutMs is Infinity', async () => {
    const { jetstream, sent } = fakeJetStream();
    await new NatsJetStreamErrorAdapter(jetstream, 'a', {
      timeoutMs: Infinity,
    }).log(entry);
    expect(sent[0]?.timeout).toBeUndefined();
  });

  it('reports a rejected publish, such as no responders', async () => {
    const { jetstream } = fakeJetStream(() =>
      Promise.reject(new Error('503 no responders available'))
    );
    const result = await new NatsJetStreamErrorAdapter(jetstream, 'a').log(
      entry
    );
    expect(result).toEqual({
      ok: false,
      error:
        'NatsJetStreamErrorAdapter failed to publish to subject "a": 503 no responders available',
    });
  });

  it('times out when the stream never acknowledges', async () => {
    const { jetstream } = fakeJetStream(() => new Promise(() => undefined));
    const result = await new NatsJetStreamErrorAdapter(jetstream, 'a', {
      timeoutMs: 20,
    }).log(entry);
    expect(result.ok).toBe(false);
    expect(result.error).toContain(
      'did not acknowledge the message within 20 ms'
    );
  });

  it('rejects a bad subject or timeout', () => {
    const { jetstream } = fakeJetStream();
    expect(() => new NatsJetStreamErrorAdapter(jetstream, 'a.*')).toThrow(
      RangeError
    );
    expect(
      () => new NatsJetStreamErrorAdapter(jetstream, 'a', { timeoutMs: 0 })
    ).toThrow(RangeError);
  });

  describe('logBatch', () => {
    it('publishes every entry and waits for all acks', async () => {
      const { jetstream, sent } = fakeJetStream();
      const result = await new NatsJetStreamErrorAdapter(
        jetstream,
        'a'
      ).logBatch([
        { code: 'A', message: '1' },
        { code: 'B', message: '2' },
      ]);
      expect(result).toEqual({ ok: true });
      expect(sent.map((s) => s.body['code'])).toEqual(['A', 'B']);
    });

    it('publishes nothing when one entry is invalid', async () => {
      const { jetstream, sent } = fakeJetStream();
      const result = await new NatsJetStreamErrorAdapter(
        jetstream,
        'a'
      ).logBatch([
        { code: 'A', message: '1' },
        { code: 'B', message: '2', id: 'nope' },
      ]);
      expect(result.ok).toBe(false);
      expect(sent).toHaveLength(0);
    });

    it('reports how many were stored when some publishes fail', async () => {
      const { jetstream } = fakeJetStream((sent) =>
        sent.body['code'] === 'B'
          ? Promise.reject(new Error('503 no responders available'))
          : Promise.resolve({})
      );
      const result = await new NatsJetStreamErrorAdapter(
        jetstream,
        'a'
      ).logBatch([
        { code: 'A', message: '1' },
        { code: 'B', message: '2' },
        { code: 'C', message: '3' },
      ]);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('503 no responders available');
      expect(result.error).toContain('2 of 3 entries were stored; 1 failed');
    });

    it('is used by BatchingErrorAdapter', async () => {
      const { jetstream, sent } = fakeJetStream();
      const batching = new BatchingErrorAdapter(
        new NatsJetStreamErrorAdapter(jetstream, 'a'),
        { batchSize: 2, maxWaitMs: Infinity }
      );
      await batching.log({ code: 'A', message: '1' });
      await batching.log({ code: 'B', message: '2' });
      await batching.flush();
      expect(sent).toHaveLength(2);
    });
  });
});
