import { resolveEntryId } from '../entry-id.js';
import { DEFAULT_PREFIX, reportFailure } from '../fail.js';
import { serializeEntry } from '../serialize.js';
import { resolveTimeoutMs, timeoutMessage, withTimeout } from '../timeout.js';
import type {
  ErrorLogAdapter,
  ErrorLogEntry,
  ErrorLogResult,
} from '../types.js';

/** Largest message SNS accepts: 256 KiB, counting the message attributes. */
export const MAX_MESSAGE_BYTES = 262_144;
/** SNS rejects a subject of 100 characters or more. */
export const MAX_SUBJECT_LENGTH = 99;

/** One message attribute as `Publish` takes it. */
export interface SnsMessageAttribute {
  DataType: 'String';
  StringValue: string;
}

/** The parameters this adapter passes to `publish`. */
export interface SnsPublishInput {
  TopicArn: string;
  Message: string;
  /** Used as the subject line by email subscriptions. */
  Subject?: string;
  /** `code` and, when the entry has one, `source`, so subscription filter policies can match on them. */
  MessageAttributes?: Record<string, SnsMessageAttribute>;
  /** FIFO topics only. */
  MessageGroupId?: string;
  /** FIFO topics only: the entry's UUID, so SNS drops a repeat within five minutes. */
  MessageDeduplicationId?: string;
}

/**
 * The only thing this adapter needs from an SNS client: `publish`. The AWS SDK
 * v3 aggregated client (`new SNS({ ... })` from `@aws-sdk/client-sns`) fits as
 * it is.
 */
export interface SnsClientLike {
  publish(input: SnsPublishInput): Promise<unknown>;
}

export interface SnsErrorOptions {
  /**
   * Send the entry's `code` (and `source`, when set) as message attributes, so
   * a subscription filter policy can route on them, for example
   * `{ "code": ["PAYMENT_FAILED"] }`. Defaults to `true`.
   */
  attributes?: boolean;
  /**
   * Set the message subject to `<code>: <message>`, cut to 99 characters, with
   * anything outside printable ASCII replaced by `?` (SNS accepts nothing
   * else). Email subscriptions show it as the subject line. Defaults to `true`.
   */
  subject?: boolean;
  /**
   * Message group for a FIFO topic (an ARN ending in `.fifo`). SNS delivers
   * messages of one group in order. Required for a FIFO topic, and not allowed
   * for any other.
   */
  messageGroupId?: string;
  /** Text printed before failure messages. Defaults to `[error-log-adapter]`. */
  prefix?: string;
  /**
   * How long a publish may take before `log` gives up waiting, in
   * milliseconds. Defaults to 10000. Pass `Infinity` to wait without limit. The
   * request cannot be cancelled, so it may still finish afterwards.
   */
  timeoutMs?: number;
}

const TOPIC_ARN_PATTERN: RegExp =
  /^arn:[a-z0-9-]+:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]{1,256}(\.fifo)?$/;
const encoder = new TextEncoder();

/** `<code>: <message>` reduced to what SNS accepts as a subject, or undefined when nothing is left. */
function buildSubject(code: string, message: string): string | undefined {
  const subject: string = `${code}: ${message}`
    .replace(/[^\x20-\x7e]/g, '?')
    .trim()
    .slice(0, MAX_SUBJECT_LENGTH)
    .trimEnd();
  return subject === '' ? undefined : subject;
}

function attributeBytes(
  attributes: Record<string, SnsMessageAttribute>
): number {
  let bytes = 0;
  for (const [name, { DataType, StringValue }] of Object.entries(attributes)) {
    bytes +=
      encoder.encode(name).length +
      encoder.encode(DataType).length +
      encoder.encode(StringValue).length;
  }
  return bytes;
}

/**
 * Publishes each entry to an Amazon SNS topic as a JSON message (the serialized
 * entry plus its UUID `id`), so one error can fan out to email, SMS, SQS,
 * Lambda and HTTPS subscribers. `log` resolves once SNS accepts the message,
 * which means SNS has it, not that every subscriber has.
 *
 * The entry's `code` and `source` also travel as message attributes, so each
 * subscription can use a filter policy to receive only the codes it cares
 * about. A message over 256 KiB is refused before sending.
 *
 * On a FIFO topic, pass `messageGroupId`; the entry's UUID becomes the
 * deduplication id, so logging the same entry (same `id`) again within five
 * minutes is dropped by SNS instead of delivered twice. A standard topic has no
 * such protection: if a call reports a timeout, the first publish may still
 * arrive, and logging the entry again can deliver it twice.
 */
export class SnsErrorAdapter<
  TCode extends string = string,
> implements ErrorLogAdapter<TCode> {
  private readonly attributes: boolean;
  private readonly subject: boolean;
  private readonly messageGroupId: string | undefined;
  private readonly isFifo: boolean;
  private readonly logPrefix: string;
  private readonly timeoutMs: number;

  /** @throws {RangeError} if `topicArn` is not an SNS topic ARN, `messageGroupId` is missing for a FIFO topic or given for a standard one, or `timeoutMs` is invalid. */
  constructor(
    private readonly client: SnsClientLike,
    private readonly topicArn: string,
    options: SnsErrorOptions = {}
  ) {
    this.attributes = options.attributes ?? true;
    this.subject = options.subject ?? true;
    this.messageGroupId = options.messageGroupId;
    this.logPrefix = options.prefix ?? DEFAULT_PREFIX;
    this.timeoutMs = resolveTimeoutMs(options.timeoutMs, 'SnsErrorAdapter');
    if (!TOPIC_ARN_PATTERN.test(topicArn)) {
      throw new RangeError(
        `SnsErrorAdapter: topicArn must be an SNS topic ARN such as "arn:aws:sns:us-east-1:123456789012:app-errors", received ${JSON.stringify(topicArn)}.`
      );
    }
    this.isFifo = topicArn.endsWith('.fifo');
    if (this.isFifo && (this.messageGroupId ?? '') === '') {
      throw new RangeError(
        `SnsErrorAdapter: "${topicArn}" is a FIFO topic, so messageGroupId is required (for example the app name).`
      );
    }
    if (!this.isFifo && this.messageGroupId !== undefined) {
      throw new RangeError(
        `SnsErrorAdapter: messageGroupId only applies to FIFO topics, and "${topicArn}" does not end in ".fifo".`
      );
    }
    if (this.messageGroupId !== undefined && this.messageGroupId.length > 128) {
      throw new RangeError(
        `SnsErrorAdapter: messageGroupId must be at most 128 characters, received ${this.messageGroupId.length}.`
      );
    }
  }

  async log(entry: ErrorLogEntry<TCode>): Promise<ErrorLogResult> {
    try {
      const id: string = resolveEntryId(entry);
      const record = { id, ...serializeEntry(entry) };
      const input: SnsPublishInput = {
        TopicArn: this.topicArn,
        Message: JSON.stringify(record),
      };
      if (this.subject) {
        const subject: string | undefined = buildSubject(
          record.code,
          record.message
        );
        if (subject !== undefined) {
          input.Subject = subject;
        }
      }
      if (this.attributes) {
        const attributes: Record<string, SnsMessageAttribute> = {};
        if (record.code !== '') {
          attributes['code'] = { DataType: 'String', StringValue: record.code };
        }
        if (record.source !== undefined && record.source !== '') {
          attributes['source'] = {
            DataType: 'String',
            StringValue: record.source,
          };
        }
        if (Object.keys(attributes).length > 0) {
          input.MessageAttributes = attributes;
        }
      }
      if (this.isFifo) {
        input.MessageGroupId = this.messageGroupId as string;
        input.MessageDeduplicationId = id;
      }
      const size: number =
        encoder.encode(input.Message).length +
        attributeBytes(input.MessageAttributes ?? {});
      if (size > MAX_MESSAGE_BYTES) {
        throw new RangeError(
          `the message is ${size} bytes, over the ${MAX_MESSAGE_BYTES} byte limit SNS puts on a message and its attributes, so it was not sent; shorten the message or cause`
        );
      }
      await withTimeout(
        (): Promise<unknown> => this.client.publish(input),
        this.timeoutMs,
        timeoutMessage('SNS', this.timeoutMs)
      );
      return { ok: true };
    } catch (error: unknown) {
      return reportFailure({
        adapterName: 'SnsErrorAdapter',
        prefix: this.logPrefix,
        action: `to publish to topic "${this.topicArn}"`,
        error,
      });
    }
  }
}
