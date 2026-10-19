import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ErrorLogEntry } from '../types.js';
import {
  CloudWatchLogsErrorAdapter,
  MAX_BATCH_EVENTS,
  MAX_EVENT_BYTES,
  splitIntoRequests,
} from './cloudwatch-logs-error-adapter.js';
import type {
  CloudWatchLogsClientLike,
  CloudWatchPutLogEventsInput,
} from './cloudwatch-logs-error-adapter.js';

const ID = '3f2b8c1e-5d4a-4e7b-9a10-2c6d8e0f1a2b';
const ENTRY: ErrorLogEntry = {
  code: 'PAYMENT_FAILED',
  message: 'card declined',
  source: 'checkout',
  cause: new Error('insufficient funds'),
  timestamp: '2026-01-02T03:04:05.678Z',
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function quiet() {
  return vi.spyOn(console, 'error').mockImplementation(() => {});
}

function awsError(name: string, message = name): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function makeClient(
  overrides: Partial<CloudWatchLogsClientLike> = {}
): CloudWatchLogsClientLike & {
  putLogEvents: ReturnType<typeof vi.fn>;
  createLogStream: ReturnType<typeof vi.fn>;
  createLogGroup: ReturnType<typeof vi.fn>;
} {
  return {
    putLogEvents: vi.fn().mockResolvedValue({}),
    createLogStream: vi.fn().mockResolvedValue({}),
    createLogGroup: vi.fn().mockResolvedValue({}),
    ...overrides,
  } as never;
}

function adapter(client: CloudWatchLogsClientLike, options = {}) {
  return new CloudWatchLogsErrorAdapter(client, 'app-logs', 'web-1', options);
}

describe('CloudWatchLogsErrorAdapter', () => {
  it('sends the entry as one JSON event stamped with its time', async () => {
    const client = makeClient();

    const result = await adapter(client).log(ENTRY);

    expect(result).toEqual({ ok: true });
    expect(client.putLogEvents).toHaveBeenCalledTimes(1);
    const input = client.putLogEvents.mock
      .calls[0][0] as CloudWatchPutLogEventsInput;
    expect(input.logGroupName).toBe('app-logs');
    expect(input.logStreamName).toBe('web-1');
    expect(input.logEvents).toHaveLength(1);
    const [event] = input.logEvents;
    expect(event.timestamp).toBe(Date.parse('2026-01-02T03:04:05.678Z'));
    const message = JSON.parse(event.message);
    expect(message.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(message).toMatchObject({
      code: 'PAYMENT_FAILED',
      message: 'card declined',
      source: 'checkout',
      cause: { name: 'Error', message: 'insufficient funds' },
    });
  });

  it('uses a caller-supplied id and reports an invalid one without sending', async () => {
    quiet();
    const client = makeClient();
    await adapter(client).log({ ...ENTRY, id: ID.toUpperCase() });
    const sent = JSON.parse(
      client.putLogEvents.mock.calls[0][0].logEvents[0].message
    );
    expect(sent.id).toBe(ID);

    const bad = await adapter(client).log({ ...ENTRY, id: 'nope' });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('entry.id must be a UUID');
    expect(client.putLogEvents).toHaveBeenCalledTimes(1);
  });

  it('reports a failing request with the stream and group named', async () => {
    const spy = quiet();
    const client = makeClient({
      putLogEvents: vi
        .fn()
        .mockRejectedValue(awsError('AccessDeniedException', 'not allowed')),
    });

    const result = await adapter(client).log(ENTRY);

    expect(result).toEqual({
      ok: false,
      error:
        'CloudWatchLogsErrorAdapter failed to send to log stream "web-1" in log group "app-logs": not allowed',
    });
    expect(client.createLogStream).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalled();
  });

  it('refuses an event over the 256 KiB limit without sending', async () => {
    quiet();
    const client = makeClient();
    const result = await adapter(client).log({
      ...ENTRY,
      message: 'x'.repeat(MAX_EVENT_BYTES),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain(
      'byte limit CloudWatch Logs puts on one event'
    );
    expect(client.putLogEvents).not.toHaveBeenCalled();
  });

  it('reports a timestamp that is not a date', async () => {
    quiet();
    const client = makeClient();
    const result = await adapter(client).log({ ...ENTRY, timestamp: 'soon' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not a valid ISO 8601 date');
    expect(client.putLogEvents).not.toHaveBeenCalled();
  });

  describe('rejected events', () => {
    it.each([
      [{ tooOldLogEventEndIndex: 1 }, 'older than the 14 days'],
      [{ expiredLogEventEndIndex: 1 }, 'older than the log group'],
      [{ tooNewLogEventStartIndex: 0 }, 'more than 2 hours ahead'],
    ])(
      'treats %j as a failure even though the request succeeded',
      async (info, words: string) => {
        quiet();
        const client = makeClient({
          putLogEvents: vi
            .fn()
            .mockResolvedValue({ rejectedLogEventsInfo: info }),
        });
        const result = await adapter(client).log(ENTRY);
        expect(result.ok).toBe(false);
        expect(result.error).toContain('accepted the request but rejected');
        expect(result.error).toContain(words);
      }
    );

    it('ignores an empty rejection object from some SDK versions', async () => {
      const client = makeClient({
        putLogEvents: vi.fn().mockResolvedValue({ rejectedLogEventsInfo: {} }),
      });
      const result = await adapter(client).log(ENTRY);
      expect(result).toEqual({ ok: true });
    });
  });

  describe('createMissing', () => {
    it('creates the stream when it is missing and tries again', async () => {
      const client = makeClient({
        putLogEvents: vi
          .fn()
          .mockRejectedValueOnce(awsError('ResourceNotFoundException'))
          .mockResolvedValueOnce({}),
      });

      const result = await adapter(client).log(ENTRY);

      expect(result).toEqual({ ok: true });
      expect(client.createLogStream).toHaveBeenCalledWith({
        logGroupName: 'app-logs',
        logStreamName: 'web-1',
      });
      expect(client.createLogGroup).not.toHaveBeenCalled();
      expect(client.putLogEvents).toHaveBeenCalledTimes(2);
    });

    it('creates the group too when that is missing', async () => {
      const client = makeClient({
        putLogEvents: vi
          .fn()
          .mockRejectedValueOnce(awsError('ResourceNotFoundException'))
          .mockResolvedValueOnce({}),
        createLogStream: vi
          .fn()
          .mockRejectedValueOnce(awsError('ResourceNotFoundException'))
          .mockResolvedValueOnce({}),
      });

      const result = await adapter(client).log(ENTRY);

      expect(result).toEqual({ ok: true });
      expect(client.createLogGroup).toHaveBeenCalledWith({
        logGroupName: 'app-logs',
      });
      expect(client.createLogStream).toHaveBeenCalledTimes(2);
    });

    it('accepts a group or stream another process created in the meantime', async () => {
      const client = makeClient({
        putLogEvents: vi
          .fn()
          .mockRejectedValueOnce(awsError('ResourceNotFoundException'))
          .mockResolvedValueOnce({}),
        createLogStream: vi
          .fn()
          .mockRejectedValueOnce(awsError('ResourceAlreadyExistsException')),
      });
      expect(await adapter(client).log(ENTRY)).toEqual({ ok: true });
    });

    it('fails when creating is not allowed', async () => {
      quiet();
      const client = makeClient({
        putLogEvents: vi
          .fn()
          .mockRejectedValue(awsError('ResourceNotFoundException')),
        createLogStream: vi
          .fn()
          .mockRejectedValue(
            awsError('AccessDeniedException', 'no CreateLogStream')
          ),
      });
      const result = await adapter(client).log(ENTRY);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('no CreateLogStream');
      expect(client.putLogEvents).toHaveBeenCalledTimes(1);
    });

    it('does not create anything when createMissing is false', async () => {
      quiet();
      const client = makeClient({
        putLogEvents: vi
          .fn()
          .mockRejectedValue(
            awsError('ResourceNotFoundException', 'no such stream')
          ),
      });
      const result = await adapter(client, { createMissing: false }).log(ENTRY);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('no such stream');
      expect(client.createLogStream).not.toHaveBeenCalled();
    });

    it('needs a client that can create streams unless turned off', () => {
      const thin = { putLogEvents: vi.fn() };
      expect(() => adapter(thin)).toThrow(/no createLogStream method/);
      expect(() => adapter(thin, { createMissing: false })).not.toThrow();
    });
  });

  describe('batching', () => {
    it('buffers until the batch is full, then sends oldest first in one request', async () => {
      const client = makeClient();
      const batched = adapter(client, { batch: { batchSize: 3 } });

      expect(
        await batched.log({
          ...ENTRY,
          message: 'b',
          timestamp: '2026-01-02T00:00:02.000Z',
        })
      ).toEqual({ ok: true });
      expect(
        await batched.log({
          ...ENTRY,
          message: 'a',
          timestamp: '2026-01-02T00:00:01.000Z',
        })
      ).toEqual({ ok: true });
      expect(client.putLogEvents).not.toHaveBeenCalled();
      expect(
        await batched.log({
          ...ENTRY,
          message: 'c',
          timestamp: '2026-01-02T00:00:03.000Z',
        })
      ).toEqual({ ok: true });

      expect(client.putLogEvents).toHaveBeenCalledTimes(1);
      const events = client.putLogEvents.mock.calls[0][0].logEvents;
      expect(
        events.map((e: { message: string }) => JSON.parse(e.message).message)
      ).toEqual(['a', 'b', 'c']);
    });

    it('flush() sends what is buffered and is ok when nothing is', async () => {
      const client = makeClient();
      const batched = adapter(client, { batch: { batchSize: 10 } });
      expect(await batched.flush()).toEqual({ ok: true });
      expect(client.putLogEvents).not.toHaveBeenCalled();
      await batched.log(ENTRY);
      expect(await batched.flush()).toEqual({ ok: true });
      expect(client.putLogEvents).toHaveBeenCalledTimes(1);
      await batched.flush();
      expect(client.putLogEvents).toHaveBeenCalledTimes(1);
    });

    it('sends after maxWaitMs', async () => {
      vi.useFakeTimers();
      const client = makeClient();
      const batched = adapter(client, {
        batch: { batchSize: 10, maxWaitMs: 500 },
      });
      await batched.log(ENTRY);
      await vi.advanceTimersByTimeAsync(499);
      expect(client.putLogEvents).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(client.putLogEvents).toHaveBeenCalledTimes(1);
    });

    it('keeps events after a failed send and retries them on the next flush', async () => {
      quiet();
      const client = makeClient({
        putLogEvents: vi
          .fn()
          .mockRejectedValueOnce(awsError('ThrottlingException', 'slow down'))
          .mockResolvedValueOnce({}),
      });
      const batched = adapter(client, { batch: { batchSize: 2 } });
      await batched.log(ENTRY);
      const failed = await batched.log(ENTRY);
      expect(failed.ok).toBe(false);
      expect(failed.error).toContain('2 events affected');

      expect(await batched.flush()).toEqual({ ok: true });
      expect(client.putLogEvents.mock.calls[1][0].logEvents).toHaveLength(2);
    });

    it('drops rejected events for good rather than retrying them forever', async () => {
      quiet();
      const client = makeClient({
        putLogEvents: vi
          .fn()
          .mockResolvedValueOnce({
            rejectedLogEventsInfo: { tooOldLogEventEndIndex: 1 },
          })
          .mockResolvedValue({}),
      });
      const batched = adapter(client, { batch: { batchSize: 1 } });
      expect((await batched.log(ENTRY)).ok).toBe(false);
      expect(await batched.flush()).toEqual({ ok: true });
      expect(client.putLogEvents).toHaveBeenCalledTimes(1);
    });

    it('drops the oldest events when sends keep failing', async () => {
      const spy = quiet();
      const client = makeClient({
        putLogEvents: vi.fn().mockRejectedValue(new Error('down')),
      });
      const batched = adapter(client, { batch: { batchSize: 2 } });
      for (let i = 0; i < 25; i += 1) {
        await batched.log({ ...ENTRY, message: `m${i}` });
      }
      await batched.flush();
      const last = client.putLogEvents.mock.calls.at(-1)?.[0].logEvents;
      expect(last).toHaveLength(20);
      expect(JSON.parse(last[0].message).message).toBe('m5');
      expect(
        spy.mock.calls.some((c) => String(c[1] ?? c[0]).includes('dropped'))
      ).toBe(true);
    });
  });

  describe('splitIntoRequests', () => {
    const at = (ms: number, message = 'm') => ({ timestamp: ms, message });

    it('keeps a small batch together', () => {
      expect(splitIntoRequests([at(1), at(2)])).toHaveLength(1);
      expect(splitIntoRequests([])).toEqual([]);
    });

    it('starts a new request after 10,000 events', () => {
      const events = Array.from({ length: MAX_BATCH_EVENTS + 1 }, (_, i) =>
        at(i)
      );
      const requests = splitIntoRequests(events);
      expect(requests.map((r) => r.length)).toEqual([MAX_BATCH_EVENTS, 1]);
    });

    it('starts a new request before passing 1 MiB', () => {
      const big = 'x'.repeat(200_000);
      const events = Array.from({ length: 6 }, (_, i) => at(i, big));
      expect(splitIntoRequests(events).map((r) => r.length)).toEqual([5, 1]);
    });

    it('starts a new request when events are more than 24 hours apart', () => {
      const day = 24 * 60 * 60 * 1000;
      const requests = splitIntoRequests([at(0), at(day), at(day + 1)]);
      expect(requests.map((r) => r.length)).toEqual([2, 1]);
    });
  });

  it('gives up when the request takes too long', async () => {
    vi.useFakeTimers();
    quiet();
    const client = makeClient({
      putLogEvents: vi.fn(() => new Promise(() => {})),
    });
    const pending = adapter(client, { timeoutMs: 250 }).log(ENTRY);
    await vi.advanceTimersByTimeAsync(250);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.error).toContain(
      'CloudWatch Logs did not respond within 250 ms'
    );
  });

  it('rejects invalid options', () => {
    const client = makeClient();
    const make = (g: string, s: string, o = {}) =>
      new CloudWatchLogsErrorAdapter(client, g, s, o);
    expect(() => make('', 's')).toThrow(/logGroupName must not be empty/);
    expect(() => make('g', '')).toThrow(/logStreamName must not be empty/);
    expect(() => make('g', 's', { batch: { batchSize: 0 } })).toThrow(
      /batchSize/
    );
    expect(() =>
      make('g', 's', { batch: { batchSize: 1, maxWaitMs: 0 } })
    ).toThrow(/maxWaitMs/);
    expect(() => make('g', 's', { timeoutMs: 0 })).toThrow(/timeoutMs/);
  });

  it('uses a custom prefix in console output', async () => {
    const spy = quiet();
    const client = makeClient({
      putLogEvents: vi.fn().mockRejectedValue(new Error('x')),
    });
    await adapter(client, { prefix: '[app]' }).log(ENTRY);
    expect(spy.mock.calls[0][0]).toBe('[app] CloudWatchLogsErrorAdapter:');
  });
});
