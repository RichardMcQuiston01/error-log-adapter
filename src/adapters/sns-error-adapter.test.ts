import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ErrorLogEntry } from '../types.js';
import {
  MAX_MESSAGE_BYTES,
  MAX_SUBJECT_LENGTH,
  SnsErrorAdapter,
} from './sns-error-adapter.js';
import type { SnsClientLike, SnsPublishInput } from './sns-error-adapter.js';

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

function makeClient(): SnsClientLike & { publish: ReturnType<typeof vi.fn> } {
  return { publish: vi.fn().mockResolvedValue({ MessageId: 'm-1' }) };
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
