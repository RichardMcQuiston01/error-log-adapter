import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ErrorLogEntry } from '../types.js';
import {
  MAX_MESSAGE_BYTES,
  MAX_SUBJECT_LENGTH,
  SnsErrorAdapter,
} from './sns-error-adapter.js';
import type {
  SnsClientLike,
  SnsPublishBatchInput,
  SnsPublishInput,
} from './sns-error-adapter.js';
import { BatchingErrorAdapter } from './batching-error-adapter.js';

const TOPIC = 'arn:aws:sns:us-east-1:123456789012:app-errors';
const FIFO_TOPIC = 'arn:aws:sns:us-east-1:123456789012:app-errors.fifo';
const ID = '3f2b8c1e-5d4a-4e7b-9a10-2c6d8e0f1a2b';
const ENTRY: ErrorLogEntry = {
  code: 'PAYMENT_FAILED',
  message: 'card declined',
  source: 'checkout',
  cause: new Error('insufficient funds'),
  timestamp: '2026-01-02T03:04:05.678Z',
};

afterEach(() => {
  vi.restoreAllMocks();
});

function quiet() {
  return vi.spyOn(console, 'error').mockImplementation(() => {});
}

function makeClient(): SnsClientLike & {
  publish: ReturnType<typeof vi.fn>;
  publishBatch: ReturnType<typeof vi.fn>;
} {
  return {
    publish: vi.fn().mockResolvedValue({ MessageId: 'm-1' }),
    publishBatch: vi.fn().mockResolvedValue({ Successful: [], Failed: [] }),
  };
}

function entries(count: number, message = 'm'): ErrorLogEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    code: `E${index}`,
    message: `${message} ${index}`,
    timestamp: '2026-01-02T03:04:05.678Z',
  }));
}

function batchCall(
  client: { publishBatch: ReturnType<typeof vi.fn> },
  call = 0
): SnsPublishBatchInput {
  return client.publishBatch.mock.calls[call][0] as SnsPublishBatchInput;
}

function published(client: { publish: ReturnType<typeof vi.fn> }) {
  return client.publish.mock.calls[0][0] as SnsPublishInput;
}

describe('SnsErrorAdapter', () => {
  it('publishes the entry as a JSON message with its id', async () => {
    const client = makeClient();

    const result = await new SnsErrorAdapter(client, TOPIC).log({
      ...ENTRY,
      id: ID.toUpperCase(),
    });

    expect(result).toEqual({ ok: true });
    expect(client.publish).toHaveBeenCalledTimes(1);
    const input = published(client);
    expect(input.TopicArn).toBe(TOPIC);
    expect(JSON.parse(input.Message)).toMatchObject({
      id: ID,
      code: 'PAYMENT_FAILED',
      message: 'card declined',
      source: 'checkout',
      timestamp: '2026-01-02T03:04:05.678Z',
      cause: { name: 'Error', message: 'insufficient funds' },
    });
  });

  it('generates a UUID id when the entry has none', async () => {
    const client = makeClient();

    await new SnsErrorAdapter(client, TOPIC).log(ENTRY);

    expect(JSON.parse(published(client).Message).id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it('sends code and source as string message attributes', async () => {
    const client = makeClient();

    await new SnsErrorAdapter(client, TOPIC).log(ENTRY);

    expect(published(client).MessageAttributes).toEqual({
      code: { DataType: 'String', StringValue: 'PAYMENT_FAILED' },
      source: { DataType: 'String', StringValue: 'checkout' },
    });
  });

  it('leaves out source and empty values', async () => {
    const client = makeClient();

    await new SnsErrorAdapter(client, TOPIC).log({ code: 'E', message: 'm' });
    await new SnsErrorAdapter(client, TOPIC).log({ code: '', message: 'm' });

    expect(client.publish.mock.calls[0][0].MessageAttributes).toEqual({
      code: { DataType: 'String', StringValue: 'E' },
    });
    expect(client.publish.mock.calls[1][0]).not.toHaveProperty(
      'MessageAttributes'
    );
  });

  it('sends no attributes when attributes is false', async () => {
    const client = makeClient();

    await new SnsErrorAdapter(client, TOPIC, { attributes: false }).log(ENTRY);

    expect(published(client)).not.toHaveProperty('MessageAttributes');
  });

  describe('subject', () => {
    it('is "<code>: <message>"', async () => {
      const client = makeClient();

      await new SnsErrorAdapter(client, TOPIC).log(ENTRY);

      expect(published(client).Subject).toBe('PAYMENT_FAILED: card declined');
    });

    it('is cut to what SNS accepts and stripped of unsupported characters', async () => {
      const client = makeClient();

      await new SnsErrorAdapter(client, TOPIC).log({
        code: 'E',
        message: `line one\nline two é ${'x'.repeat(200)}`,
      });

      const subject = published(client).Subject as string;
      expect(subject.length).toBeLessThanOrEqual(MAX_SUBJECT_LENGTH);
      expect(subject).toMatch(/^E: line one\?line two \? x+$/);
      expect(subject).toMatch(/^[\x20-\x7e]+$/);
    });

    it('is left out when subject is false', async () => {
      const client = makeClient();

      await new SnsErrorAdapter(client, TOPIC, { subject: false }).log(ENTRY);

      expect(published(client)).not.toHaveProperty('Subject');
    });
  });

  describe('FIFO topics', () => {
    it('sends the group id and uses the entry id for deduplication', async () => {
      const client = makeClient();

      await new SnsErrorAdapter(client, FIFO_TOPIC, {
        messageGroupId: 'web',
      }).log({ ...ENTRY, id: ID });

      const input = published(client);
      expect(input.MessageGroupId).toBe('web');
      expect(input.MessageDeduplicationId).toBe(ID);
    });

    it('does not send FIFO fields to a standard topic', async () => {
      const client = makeClient();

      await new SnsErrorAdapter(client, TOPIC).log(ENTRY);

      const input = published(client);
      expect(input).not.toHaveProperty('MessageGroupId');
      expect(input).not.toHaveProperty('MessageDeduplicationId');
    });

    it('requires messageGroupId', () => {
      expect(() => new SnsErrorAdapter(makeClient(), FIFO_TOPIC)).toThrow(
        /FIFO topic, so messageGroupId is required/
      );
    });

    it('rejects messageGroupId on a standard topic', () => {
      expect(
        () =>
          new SnsErrorAdapter(makeClient(), TOPIC, { messageGroupId: 'web' })
      ).toThrow(/messageGroupId only applies to FIFO topics/);
    });

    it('rejects a messageGroupId over 128 characters', () => {
      expect(
        () =>
          new SnsErrorAdapter(makeClient(), FIFO_TOPIC, {
            messageGroupId: 'g'.repeat(129),
          })
      ).toThrow(/at most 128 characters/);
    });
  });

  describe('topicArn', () => {
    it.each([
      '',
      'app-errors',
      'arn:aws:sqs:us-east-1:123456789012:app-errors',
      'arn:aws:sns:us-east-1:123:app-errors',
      'arn:aws:sns:us-east-1:123456789012:',
      'arn:aws:sns:us-east-1:123456789012:bad name',
    ])('rejects %j', (arn) => {
      expect(() => new SnsErrorAdapter(makeClient(), arn)).toThrow(
        /SnsErrorAdapter: topicArn must be an SNS topic ARN/
      );
    });

    it('accepts other partitions', () => {
      expect(
        () =>
          new SnsErrorAdapter(
            makeClient(),
            'arn:aws-cn:sns:cn-north-1:123456789012:app-errors'
          )
      ).not.toThrow();
    });
  });

  describe('failures', () => {
    it('returns the SDK error with the topic named, and never throws', async () => {
      const spy = quiet();
      const client = makeClient();
      const denied = new Error('not authorized to perform sns:Publish');
      denied.name = 'AuthorizationErrorException';
      client.publish.mockRejectedValue(denied);

      const result = await new SnsErrorAdapter(client, TOPIC).log(ENTRY);

      expect(result.ok).toBe(false);
      expect(result.error).toContain('SnsErrorAdapter failed');
      expect(result.error).toContain(`topic "${TOPIC}"`);
      expect(result.error).toContain('not authorized to perform sns:Publish');
      expect(spy).toHaveBeenCalled();
    });

    it('returns ok: false when publish throws synchronously', async () => {
      quiet();
      const client = {
        publish: (): never => {
          throw new Error('client is closed');
        },
      };

      const result = await new SnsErrorAdapter(client, TOPIC).log(ENTRY);

      expect(result.ok).toBe(false);
      expect(result.error).toContain('client is closed');
    });

    it('rejects an invalid entry id without publishing', async () => {
      quiet();
      const client = makeClient();

      const result = await new SnsErrorAdapter(client, TOPIC).log({
        ...ENTRY,
        id: 'not-a-uuid',
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain('entry.id must be a UUID');
      expect(client.publish).not.toHaveBeenCalled();
    });

    it('refuses a message over 256 KiB without publishing', async () => {
      quiet();
      const client = makeClient();

      const result = await new SnsErrorAdapter(client, TOPIC).log({
        code: 'E',
        message: 'x'.repeat(MAX_MESSAGE_BYTES),
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain(
        `over the ${MAX_MESSAGE_BYTES} byte limit`
      );
      expect(client.publish).not.toHaveBeenCalled();
    });

    it('counts message attributes toward the 256 KiB limit', async () => {
      quiet();
      const client = makeClient();
      const entry = {
        id: ID,
        code: 'cccccccccc',
        timestamp: ENTRY.timestamp,
      };
      const options = { subject: false };
      await new SnsErrorAdapter(client, TOPIC, options).log({
        ...entry,
        message: '',
      });
      const emptyBytes = Buffer.byteLength(published(client).Message);
      // "code" + "String" + the 10 character value.
      const attributeBytes = 4 + 6 + 10;
      const fits = MAX_MESSAGE_BYTES - attributeBytes - emptyBytes;

      const exact = await new SnsErrorAdapter(client, TOPIC, options).log({
        ...entry,
        message: 'x'.repeat(fits),
      });
      const over = await new SnsErrorAdapter(client, TOPIC, options).log({
        ...entry,
        message: 'x'.repeat(fits + 1),
      });

      expect(exact).toEqual({ ok: true });
      expect(over.ok).toBe(false);
      expect(over.error).toContain(`over the ${MAX_MESSAGE_BYTES} byte limit`);
      expect(client.publish).toHaveBeenCalledTimes(2);
    });
  });
});

describe('SnsErrorAdapter.logBatch', () => {
  it('does nothing for an empty batch', async () => {
    const client = makeClient();

    expect(await new SnsErrorAdapter(client, TOPIC).logBatch([])).toEqual({
      ok: true,
    });
    expect(client.publishBatch).not.toHaveBeenCalled();
    expect(client.publish).not.toHaveBeenCalled();
  });

  it('publishes the entries in one PublishBatch request', async () => {
    const client = makeClient();

    const result = await new SnsErrorAdapter(client, TOPIC).logBatch([
      { ...ENTRY, id: ID },
      { code: 'E', message: 'second' },
    ]);

    expect(result).toEqual({ ok: true });
    expect(client.publish).not.toHaveBeenCalled();
    expect(client.publishBatch).toHaveBeenCalledTimes(1);
    const input = batchCall(client);
    expect(input.TopicArn).toBe(TOPIC);
    const [first, second] = input.PublishBatchRequestEntries;
    expect(input.PublishBatchRequestEntries).toHaveLength(2);
    expect(first).not.toHaveProperty('TopicArn');
    expect(first?.Id).toBe('0');
    expect(second?.Id).toBe('1');
    expect(JSON.parse(first?.Message ?? '{}')).toMatchObject({
      id: ID,
      code: 'PAYMENT_FAILED',
      message: 'card declined',
    });
    expect(first?.Subject).toBe('PAYMENT_FAILED: card declined');
    expect(first?.MessageAttributes).toEqual({
      code: { DataType: 'String', StringValue: 'PAYMENT_FAILED' },
      source: { DataType: 'String', StringValue: 'checkout' },
    });
    expect(second?.Subject).toBe('E: second');
  });

  it('gives entries with the same id different request ids', async () => {
    const client = makeClient();

    await new SnsErrorAdapter(client, TOPIC).logBatch([
      { ...ENTRY, id: ID },
      { ...ENTRY, id: ID },
    ]);

    expect(
      batchCall(client).PublishBatchRequestEntries.map((entry) => entry.Id)
    ).toEqual(['0', '1']);
  });

  it('sends FIFO fields on each entry', async () => {
    const client = makeClient();

    await new SnsErrorAdapter(client, FIFO_TOPIC, {
      messageGroupId: 'web',
    }).logBatch([{ ...ENTRY, id: ID }]);

    const [entry] = batchCall(client).PublishBatchRequestEntries;
    expect(entry?.MessageGroupId).toBe('web');
    expect(entry?.MessageDeduplicationId).toBe(ID);
  });

  it('splits more than 10 entries into requests of 10, in order', async () => {
    const client = makeClient();

    const result = await new SnsErrorAdapter(client, TOPIC).logBatch(
      entries(25)
    );

    expect(result).toEqual({ ok: true });
    expect(client.publishBatch).toHaveBeenCalledTimes(3);
    const sizes = [0, 1, 2].map(
      (call) => batchCall(client, call).PublishBatchRequestEntries.length
    );
    expect(sizes).toEqual([10, 10, 5]);
    const messages = [0, 1, 2].flatMap((call) =>
      batchCall(client, call).PublishBatchRequestEntries.map(
        (entry) => JSON.parse(entry.Message).message
      )
    );
    expect(messages).toEqual(entries(25).map((entry) => entry.message));
  });

  it('keeps each request under 256 KiB', async () => {
    const client = makeClient();
    const big = 'x'.repeat(100_000);

    const result = await new SnsErrorAdapter(client, TOPIC).logBatch(
      entries(5, big)
    );

    expect(result).toEqual({ ok: true });
    const sizes = client.publishBatch.mock.calls.map(
      ([input]) =>
        (input as SnsPublishBatchInput).PublishBatchRequestEntries.length
    );
    expect(sizes).toEqual([2, 2, 1]);
  });

  it('publishes one by one when the client has no publishBatch', async () => {
    const client = { publish: vi.fn().mockResolvedValue({}) };

    const result = await new SnsErrorAdapter(client, TOPIC).logBatch(
      entries(3)
    );

    expect(result).toEqual({ ok: true });
    expect(client.publish).toHaveBeenCalledTimes(3);
    expect(client.publish.mock.calls[2][0].TopicArn).toBe(TOPIC);
  });

  it('stops at the first failing publish when falling back', async () => {
    quiet();
    const client = {
      publish: vi
        .fn()
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error('throttled'))
        .mockResolvedValue({}),
    };

    const result = await new SnsErrorAdapter(client, TOPIC).logBatch(
      entries(3)
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('throttled');
    expect(result.error).toContain('1 of 3 entries were published before this');
    expect(client.publish).toHaveBeenCalledTimes(2);
  });

  it('publishes nothing when one entry cannot be sent', async () => {
    quiet();
    const client = makeClient();

    const result = await new SnsErrorAdapter(client, TOPIC).logBatch([
      { code: 'E', message: 'fine' },
      { code: 'E', message: 'bad id', id: 'not-a-uuid' },
    ]);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('entry.id must be a UUID');
    expect(result.error).toContain(
      'entry 1 could not be prepared, so nothing was published'
    );
    expect(client.publishBatch).not.toHaveBeenCalled();
  });

  it('publishes nothing when one message is over 256 KiB', async () => {
    quiet();
    const client = makeClient();

    const result = await new SnsErrorAdapter(client, TOPIC).logBatch([
      { code: 'E', message: 'fine' },
      { code: 'E', message: 'x'.repeat(MAX_MESSAGE_BYTES) },
    ]);

    expect(result.ok).toBe(false);
    expect(result.error).toContain(`over the ${MAX_MESSAGE_BYTES} byte limit`);
    expect(client.publishBatch).not.toHaveBeenCalled();
  });

  it('reports messages SNS refuses inside an accepted request, and stops', async () => {
    quiet();
    const client = makeClient();
    client.publishBatch.mockResolvedValueOnce({
      Successful: Array.from({ length: 8 }, (_, id) => ({ Id: String(id) })),
      Failed: [
        {
          Id: '3',
          Code: 'InvalidParameter',
          Message: 'bad subject',
          SenderFault: true,
        },
        { Id: '7', Code: 'InternalError', SenderFault: false },
      ],
    });

    const result = await new SnsErrorAdapter(client, TOPIC).logBatch(
      entries(25)
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('refused 2 of its 10 messages');
    expect(result.error).toContain(
      'entry 3 of the request: InvalidParameter (bad subject), not worth retrying'
    );
    expect(result.error).toContain('entry 7 of the request: InternalError');
    expect(result.error).toContain(
      '8 of 25 entries were published before this'
    );
    expect(client.publishBatch).toHaveBeenCalledTimes(1);
  });

  it('says how many entries were published when a later request throws', async () => {
    quiet();
    const client = makeClient();
    client.publishBatch
      .mockResolvedValueOnce({ Failed: [] })
      .mockRejectedValueOnce(new Error('connection reset'));

    const result = await new SnsErrorAdapter(client, TOPIC).logBatch(
      entries(25)
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('topic "' + TOPIC + '"');
    expect(result.error).toContain('connection reset');
    expect(result.error).toContain(
      '10 of 25 entries were published before this'
    );
    expect(client.publishBatch).toHaveBeenCalledTimes(2);
  });

  it('gives up waiting after timeoutMs', async () => {
    vi.useFakeTimers();
    quiet();
    const client = {
      publish: vi.fn(),
      publishBatch: vi.fn(() => new Promise<never>(() => {})),
    };

    const pending = new SnsErrorAdapter(client, TOPIC, {
      timeoutMs: 250,
    }).logBatch(entries(2));
    await vi.advanceTimersByTimeAsync(250);
    const result = await pending;
    vi.useRealTimers();

    expect(result.ok).toBe(false);
    expect(result.error).toContain('SNS did not respond within 250 ms');
  });

  it('is used by BatchingErrorAdapter, one request for the batch', async () => {
    const client = makeClient();
    const batching = new BatchingErrorAdapter(
      new SnsErrorAdapter(client, TOPIC),
      { batchSize: 100, maxWaitMs: Infinity }
    );

    for (const entry of entries(3)) {
      await batching.log(entry);
    }
    const result = await batching.flush();

    expect(result).toEqual({ ok: true });
    expect(client.publish).not.toHaveBeenCalled();
    expect(client.publishBatch).toHaveBeenCalledTimes(1);
    expect(batchCall(client).PublishBatchRequestEntries).toHaveLength(3);
  });
});
