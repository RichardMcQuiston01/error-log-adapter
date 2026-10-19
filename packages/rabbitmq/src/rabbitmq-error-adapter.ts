import type {
  ErrorLogAdapter,
  ErrorLogEntry,
  ErrorLogResult,
} from '@richardmcquiston01/error-log-adapter';
import { serializeEntry } from '@richardmcquiston01/error-log-adapter';
import {
  DEFAULT_PREFIX,
  describeError,
  reportFailure,
  resolveEntryId,
  resolveTimeoutMs,
  timeoutMessage,
  withTimeout,
} from '@richardmcquiston01/error-log-adapter/kit';

/** Routing key (and so queue name, on the default exchange) used when none is given. */
export const DEFAULT_ROUTING_KEY = 'error_log';

/** The message properties this adapter sets. */
export interface AmqpPublishOptions {
  /** Delivery mode 2: the broker writes the message to disk if the queue is durable. */
  persistent?: boolean;
  contentType?: string;
  /** The entry's UUID. */
  messageId?: string;
  /** Seconds since the epoch, as AMQP defines it. */
  timestamp?: number;
  /** The entry's `code`. */
  type?: string;
  /** `code` and `source`, so a headers exchange can route on them. */
  headers?: Record<string, string>;
}

/**
 * The only thing this adapter needs from an amqplib channel: `publish`.
 * `amqplib`'s `Channel` and `ConfirmChannel` both fit as they are. Only a
 * `ConfirmChannel` (from `connection.createConfirmChannel()`) calls the
 * callback once the broker has the message, which is what `confirm: true` waits for.
 */
export interface AmqpChannelLike {
  publish(
    exchange: string,
    routingKey: string,
    content: Buffer,
    options?: AmqpPublishOptions,
    callback?: (error: unknown, ok?: unknown) => void
  ): boolean;
}

export interface RabbitMqErrorOptions {
  /**
   * Exchange to publish to. Defaults to `''`, the default exchange, which
   * delivers to the queue named by `routingKey`.
   */
  exchange?: string;
  /** Routing key. Defaults to `error_log`. */
  routingKey?: string;
  /**
   * Wait for the broker to confirm each message. Needs a `ConfirmChannel`: on a
   * plain `Channel` the confirmation never comes and every `log` times out.
   * Defaults to `false`, where `ok: true` means the message was handed to the
   * client's send buffer, not that the broker has it.
   */
  confirm?: boolean;
  /** Mark messages persistent. Defaults to `true`. */
  persistent?: boolean;
  /** Send `code` and `source` as message headers. Defaults to `true`. */
  headers?: boolean;
  /** Text printed before failure messages. Defaults to `[error-log-adapter]`. */
  prefix?: string;
  /**
   * With `confirm: true`, how long `log` waits for the broker, in milliseconds.
   * Defaults to 10000. Pass `Infinity` to wait without limit. The publish cannot
   * be cancelled, so it may still be confirmed after `log` has returned a failure.
   */
  timeoutMs?: number;
}

interface PreparedMessage {
  content: Buffer;
  options: AmqpPublishOptions;
}

/**
 * Publishes each entry to RabbitMQ as a JSON message (the serialized entry plus
 * its UUID `id`) through an amqplib channel you create. The UUID is also the
 * AMQP `message-id`, the `code` is the message `type`, and `code` and `source`
 * travel as headers, so consumers and headers exchanges can pick entries out
 * without parsing the body.
 *
 * RabbitMQ does not detect repeats: logging the same entry (same `id`) twice
 * delivers it twice, so a consumer that needs exactly-once handling should
 * de-duplicate on `message-id`.
 *
 * Declare the exchange or queue yourself (`assertQueue` / `assertExchange`);
 * the adapter only publishes. A message to a missing exchange closes the
 * channel, which later `log` calls report as failures.
 *
 * `logBatch` publishes the entries in order, which `BatchingErrorAdapter` uses
 * when it wraps this adapter.
 */
export class RabbitMqErrorAdapter<
  TCode extends string = string,
> implements ErrorLogAdapter<TCode> {
  private readonly exchange: string;
  private readonly routingKey: string;
  private readonly confirm: boolean;
  private readonly persistent: boolean;
  private readonly headers: boolean;
  private readonly logPrefix: string;
  private readonly timeoutMs: number;

  /** @throws {RangeError} if the exchange and routing key are both empty, or `timeoutMs` is invalid. */
  constructor(
    private readonly channel: AmqpChannelLike,
    options: RabbitMqErrorOptions = {}
  ) {
    this.exchange = options.exchange ?? '';
    this.routingKey = options.routingKey ?? DEFAULT_ROUTING_KEY;
    this.confirm = options.confirm ?? false;
    this.persistent = options.persistent ?? true;
    this.headers = options.headers ?? true;
    this.logPrefix = options.prefix ?? DEFAULT_PREFIX;
    this.timeoutMs = resolveTimeoutMs(
      options.timeoutMs,
      'RabbitMqErrorAdapter'
    );
    if (this.exchange === '' && this.routingKey === '') {
      throw new RangeError(
        'RabbitMqErrorAdapter: with the default exchange the routing key is the queue name, so routingKey must not be empty.'
      );
    }
  }

  async log(entry: ErrorLogEntry<TCode>): Promise<ErrorLogResult> {
    try {
      await this.publish(this.prepare(entry));
      return { ok: true };
    } catch (error: unknown) {
      return reportFailure({
        adapterName: 'RabbitMqErrorAdapter',
        prefix: this.logPrefix,
        action: `to publish to ${this.describeTarget()}`,
        error,
      });
    }
  }

  /**
   * Publishes several entries in order. Every entry is checked before anything
   * is sent, so one that cannot be sent (an invalid `id`) fails the whole call
   * and nothing is published. After that the call stops at the first failure,
   * and the error says how many entries had already been published; trying the
   * whole batch again sends those a second time.
   */
  async logBatch(entries: ErrorLogEntry<TCode>[]): Promise<ErrorLogResult> {
    if (entries.length === 0) {
      return { ok: true };
    }
    const prepared: PreparedMessage[] = [];
    for (const [index, entry] of entries.entries()) {
      try {
        prepared.push(this.prepare(entry));
      } catch (error: unknown) {
        return this.failBatch(
          entries.length,
          error,
          `entry ${index} could not be prepared, so nothing was published`
        );
      }
    }
    let published = 0;
    for (const message of prepared) {
      try {
        await this.publish(message);
        published += 1;
      } catch (error: unknown) {
        return this.failBatch(
          entries.length,
          error,
          `${published} of ${entries.length} entries were published before this`
        );
      }
    }
    return { ok: true };
  }

  private prepare(entry: ErrorLogEntry<TCode>): PreparedMessage {
    const id: string = resolveEntryId(entry);
    const record = { id, ...serializeEntry(entry) };
    const options: AmqpPublishOptions = {
      persistent: this.persistent,
      contentType: 'application/json',
      messageId: id,
      timestamp: Math.floor(Date.parse(record.timestamp) / 1000),
    };
    if (Number.isNaN(options.timestamp)) {
      delete options.timestamp;
    }
    if (record.code !== '') {
      options.type = record.code;
    }
    if (this.headers) {
      const headers: Record<string, string> = {};
      if (record.code !== '') {
        headers['code'] = record.code;
      }
      if (record.source !== undefined && record.source !== '') {
        headers['source'] = record.source;
      }
      if (Object.keys(headers).length > 0) {
        options.headers = headers;
      }
    }
    return { content: Buffer.from(JSON.stringify(record), 'utf8'), options };
  }

  /** Sends one message and, with `confirm`, waits for the broker to acknowledge it. */
  private async publish({ content, options }: PreparedMessage): Promise<void> {
    if (!this.confirm) {
      // `false` means the client's buffer is full, but the message is still queued.
      this.channel.publish(this.exchange, this.routingKey, content, options);
      return;
    }
    await withTimeout(
      (): Promise<void> =>
        new Promise<void>(
          (resolve: () => void, reject: (reason: unknown) => void): void => {
            this.channel.publish(
              this.exchange,
              this.routingKey,
              content,
              options,
              (error: unknown): void => {
                if (error === null || error === undefined) {
                  resolve();
                } else {
                  reject(error);
                }
              }
            );
          }
        ),
      this.timeoutMs,
      timeoutMessage('RabbitMQ', this.timeoutMs, 'confirm the message')
    );
  }

  private describeTarget(): string {
    return this.exchange === ''
      ? `queue "${this.routingKey}" on the default exchange`
      : `exchange "${this.exchange}" with routing key "${this.routingKey}"`;
  }

  private failBatch(
    count: number,
    error: unknown,
    context: string
  ): ErrorLogResult {
    return reportFailure({
      adapterName: 'RabbitMqErrorAdapter',
      prefix: this.logPrefix,
      action: `to publish ${count} entr${count === 1 ? 'y' : 'ies'} to ${this.describeTarget()}`,
      error,
      reason: `${describeError(error)} (${context})`,
    });
  }
}
