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

/** The one method of a NATS message-headers object this adapter calls. */
export interface NatsHeadersLike {
  set(key: string, value: string): void;
}

export interface NatsPublishOptionsLike {
  headers?: NatsHeadersLike;
}

/**
 * What the core adapter needs from a NATS connection: `publish`, and `flush`
 * when `flush: true` is used. The `nats` package's `NatsConnection` fits as it is.
 */
export interface NatsConnectionLike {
  publish(
    subject: string,
    payload?: Uint8Array,
    options?: NatsPublishOptionsLike
  ): void;
  flush?(): Promise<void>;
}

export interface JetStreamPublishOptionsLike {
  headers?: NatsHeadersLike;
  /** Becomes the `Nats-Msg-Id` header, which the stream uses to drop repeats. */
  msgID?: string;
  /** How long the client waits for the stream's acknowledgement, in milliseconds. */
  timeout?: number;
}

/**
 * What the JetStream adapter needs from a JetStream client: `publish`, which
 * resolves once the stream has stored the message. The `nats` package's
 * `JetStreamClient` (from `connection.jetstream()`) fits as it is.
 */
export interface JetStreamClientLike {
  publish(
    subject: string,
    payload?: Uint8Array,
    options?: JetStreamPublishOptionsLike
  ): Promise<unknown>;
}

interface NatsBaseOptions {
  /**
   * Creates an empty headers object, so `code` and `source` can travel as
   * message headers. Pass the `headers` function from the `nats` package. Left
   * out, no headers are sent.
   */
  createHeaders?: () => NatsHeadersLike;
  /** Text printed before failure messages. Defaults to `[error-log-adapter]`. */
  prefix?: string;
}

export interface NatsErrorOptions extends NatsBaseOptions {
  /**
   * Wait for the connection to flush to the server after publishing, so a
   * failure to reach the server shows up in the result. The server still does
   * not acknowledge the message: core NATS delivers at most once, to whoever
   * is subscribed right now. Defaults to `false`. Needs a client with `flush`.
   */
  flush?: boolean;
  /** With `flush`, how long to wait, in milliseconds. Defaults to 10000. `Infinity` waits without limit. */
  timeoutMs?: number;
}

export interface NatsJetStreamErrorOptions extends NatsBaseOptions {
  /**
   * How long `log` waits for the stream to acknowledge each message, in
   * milliseconds. Defaults to 10000. `Infinity` waits without limit. The publish
   * cannot be cancelled by this adapter, so it may still be stored afterwards.
   */
  timeoutMs?: number;
}

interface PreparedMessage {
  id: string;
  subject: string;
  payload: Uint8Array;
  headers?: NatsHeadersLike;
}

/**
 * NATS answers a JetStream publish that nothing is listening for with the bare
 * status `503` ("no responders"): the `nats` client's error has `code` and
 * `message` both `"503"`. That happens when no stream captures the subject and
 * when the server has JetStream switched off, so say so.
 */
function describeJetStreamError(error: unknown, subject: string): string {
  if (typeof error === 'object' && error !== null) {
    const { code } = error as { code?: unknown };
    if (code === '503') {
      return `NATS answered 503 (no responders): no JetStream stream captures the subject "${subject}", or the server does not have JetStream enabled. Create a stream whose subjects include "${subject}" (for example with \`nats stream add\`), or start the server with \`-js\``;
    }
  }
  return describeError(error);
}

const encoder = new TextEncoder();

/**
 * Publish subjects are dot-separated tokens with no spaces or wildcards
 * (`*` and `>` only appear in subscriptions).
 * @throws {RangeError} when the subject cannot be published to.
 */
function assertSubject(subject: string, adapterName: string): void {
  if (!/^[^\s.*>]+(\.[^\s.*>]+)*$/.test(subject)) {
    throw new RangeError(
      `${adapterName}: subject must be dot-separated tokens with no spaces, empty tokens or wildcards (for example "app.errors"), received ${JSON.stringify(subject)}.`
    );
  }
}

function prepareMessage<TCode extends string>(
  entry: ErrorLogEntry<TCode>,
  subject: string,
  createHeaders: (() => NatsHeadersLike) | undefined
): PreparedMessage {
  const id: string = resolveEntryId(entry);
  const record = { id, ...serializeEntry(entry) };
  const message: PreparedMessage = {
    id,
    subject,
    payload: encoder.encode(JSON.stringify(record)),
  };
  if (createHeaders !== undefined) {
    const headers: NatsHeadersLike = createHeaders();
    let any = false;
    if (record.code !== '') {
      headers.set('code', record.code);
      any = true;
    }
    if (record.source !== undefined && record.source !== '') {
      headers.set('source', record.source);
      any = true;
    }
    if (any) {
      message.headers = headers;
    }
  }
  return message;
}

/**
 * Publishes each entry to a NATS subject as a JSON message (the serialized
 * entry plus its UUID `id`) over a connection you create. `code` and `source`
 * can also go out as message headers (see `createHeaders`).
 *
 * This is core NATS: publishing is fire-and-forget, and a message reaches only
 * the subscribers connected at that moment. `ok: true` means the message was
 * handed to the client (and, with `flush: true`, written to the server). For a
 * stored, acknowledged, de-duplicated log use `NatsJetStreamErrorAdapter`.
 *
 * `logBatch` publishes the entries in order, which `BatchingErrorAdapter` uses
 * when it wraps this adapter.
 */
export class NatsErrorAdapter<
  TCode extends string = string,
> implements ErrorLogAdapter<TCode> {
  private readonly flush: boolean;
  private readonly createHeaders: (() => NatsHeadersLike) | undefined;
  private readonly logPrefix: string;
  private readonly timeoutMs: number;

  /** @throws {RangeError} if `subject` cannot be published to, `flush` is set but the client has no `flush`, or `timeoutMs` is invalid. */
  constructor(
    private readonly connection: NatsConnectionLike,
    private readonly subject: string,
    options: NatsErrorOptions = {}
  ) {
    this.flush = options.flush ?? false;
    this.createHeaders = options.createHeaders;
    this.logPrefix = options.prefix ?? DEFAULT_PREFIX;
    this.timeoutMs = resolveTimeoutMs(options.timeoutMs, 'NatsErrorAdapter');
    assertSubject(subject, 'NatsErrorAdapter');
    if (this.flush && typeof connection.flush !== 'function') {
      throw new RangeError(
        'NatsErrorAdapter: flush is on, but the connection has no flush() method.'
      );
    }
  }

  async log(entry: ErrorLogEntry<TCode>): Promise<ErrorLogResult> {
    try {
      this.send(prepareMessage(entry, this.subject, this.createHeaders));
      await this.flushIfNeeded();
      return { ok: true };
    } catch (error: unknown) {
      return reportFailure({
        adapterName: 'NatsErrorAdapter',
        prefix: this.logPrefix,
        action: `to publish to subject "${this.subject}"`,
        error,
      });
    }
  }

  /**
   * Publishes several entries in order, then flushes once when `flush` is on.
   * Every entry is checked first, so one that cannot be sent (an invalid `id`)
   * fails the whole call and nothing is published. After that the call stops at
   * the first failure and says how many entries had already been handed over.
   */
  async logBatch(entries: ErrorLogEntry<TCode>[]): Promise<ErrorLogResult> {
    if (entries.length === 0) {
      return { ok: true };
    }
    const prepared: PreparedMessage[] = [];
    for (const [index, entry] of entries.entries()) {
      try {
        prepared.push(prepareMessage(entry, this.subject, this.createHeaders));
      } catch (error: unknown) {
        return this.failBatch(
          entries.length,
          error,
          `entry ${index} could not be prepared, so nothing was published`
        );
      }
    }
    let published = 0;
    try {
      for (const message of prepared) {
        this.send(message);
        published += 1;
      }
      await this.flushIfNeeded();
    } catch (error: unknown) {
      return this.failBatch(
        entries.length,
        error,
        `${published} of ${entries.length} entries were handed to the client before this`
      );
    }
    return { ok: true };
  }

  private send(message: PreparedMessage): void {
    this.connection.publish(
      message.subject,
      message.payload,
      message.headers === undefined ? undefined : { headers: message.headers }
    );
  }

  private async flushIfNeeded(): Promise<void> {
    if (!this.flush) {
      return;
    }
    const flushConnection = (this.connection.flush as () => Promise<void>).bind(
      this.connection
    );
    await withTimeout(
      flushConnection,
      this.timeoutMs,
      timeoutMessage('NATS', this.timeoutMs, 'flush')
    );
  }

  private failBatch(
    count: number,
    error: unknown,
    context: string
  ): ErrorLogResult {
    return reportFailure({
      adapterName: 'NatsErrorAdapter',
      prefix: this.logPrefix,
      action: `to publish ${count} entr${count === 1 ? 'y' : 'ies'} to subject "${this.subject}"`,
      error,
      reason: `${describeError(error)} (${context})`,
    });
  }
}

/**
 * Publishes each entry to a NATS JetStream stream as a JSON message (the
 * serialized entry plus its UUID `id`). `log` resolves once the stream has
 * stored the message and acknowledged it.
 *
 * The entry's UUID is sent as `Nats-Msg-Id`, so the stream drops a repeat
 * inside its duplicate window (two minutes unless the stream says otherwise):
 * logging the same entry again after a timeout does not store it twice. The
 * subject must be one the stream captures; otherwise the publish fails with
 * "no responders".
 *
 * `logBatch` publishes the entries together and waits for every
 * acknowledgement, which `BatchingErrorAdapter` uses when it wraps this adapter.
 */
export class NatsJetStreamErrorAdapter<
  TCode extends string = string,
> implements ErrorLogAdapter<TCode> {
  private readonly createHeaders: (() => NatsHeadersLike) | undefined;
  private readonly logPrefix: string;
  private readonly timeoutMs: number;

  /** @throws {RangeError} if `subject` cannot be published to or `timeoutMs` is invalid. */
  constructor(
    private readonly jetstream: JetStreamClientLike,
    private readonly subject: string,
    options: NatsJetStreamErrorOptions = {}
  ) {
    this.createHeaders = options.createHeaders;
    this.logPrefix = options.prefix ?? DEFAULT_PREFIX;
    this.timeoutMs = resolveTimeoutMs(
      options.timeoutMs,
      'NatsJetStreamErrorAdapter'
    );
    assertSubject(subject, 'NatsJetStreamErrorAdapter');
  }

  async log(entry: ErrorLogEntry<TCode>): Promise<ErrorLogResult> {
    try {
      await this.publish(
        prepareMessage(entry, this.subject, this.createHeaders)
      );
      return { ok: true };
    } catch (error: unknown) {
      return reportFailure({
        adapterName: 'NatsJetStreamErrorAdapter',
        prefix: this.logPrefix,
        action: `to publish to subject "${this.subject}"`,
        error,
        reason: describeJetStreamError(error, this.subject),
      });
    }
  }

  /**
   * Publishes several entries at once and waits for all of the stream's
   * acknowledgements. Every entry is checked first, so one that cannot be sent
   * (an invalid `id`) fails the whole call and nothing is published. If some
   * publishes fail, the error says how many were stored; trying the whole batch
   * again is safe within the stream's duplicate window, because repeats are
   * dropped by entry `id`.
   */
  async logBatch(entries: ErrorLogEntry<TCode>[]): Promise<ErrorLogResult> {
    if (entries.length === 0) {
      return { ok: true };
    }
    const prepared: PreparedMessage[] = [];
    for (const [index, entry] of entries.entries()) {
      try {
        prepared.push(prepareMessage(entry, this.subject, this.createHeaders));
      } catch (error: unknown) {
        return this.failBatch(
          entries.length,
          error,
          `entry ${index} could not be prepared, so nothing was published`
        );
      }
    }
    const outcomes: PromiseSettledResult<void>[] = await Promise.allSettled(
      prepared.map((message: PreparedMessage): Promise<void> =>
        this.publish(message)
      )
    );
    const failures: PromiseRejectedResult[] = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === 'rejected'
    );
    if (failures.length === 0) {
      return { ok: true };
    }
    return this.failBatch(
      entries.length,
      (failures[0] as PromiseRejectedResult).reason,
      `${entries.length - failures.length} of ${entries.length} entries were stored; ${failures.length} failed`
    );
  }

  /** Publishes one message and waits for the stream's acknowledgement. */
  private async publish(message: PreparedMessage): Promise<void> {
    const options: JetStreamPublishOptionsLike = { msgID: message.id };
    if (message.headers !== undefined) {
      options.headers = message.headers;
    }
    if (this.timeoutMs !== Infinity) {
      options.timeout = this.timeoutMs;
    }
    await withTimeout(
      (): Promise<unknown> =>
        this.jetstream.publish(message.subject, message.payload, options),
      this.timeoutMs,
      timeoutMessage(
        'NATS JetStream',
        this.timeoutMs,
        'acknowledge the message'
      )
    );
  }

  private failBatch(
    count: number,
    error: unknown,
    context: string
  ): ErrorLogResult {
    return reportFailure({
      adapterName: 'NatsJetStreamErrorAdapter',
      prefix: this.logPrefix,
      action: `to publish ${count} entr${count === 1 ? 'y' : 'ies'} to subject "${this.subject}"`,
      error,
      reason: `${describeJetStreamError(error, this.subject)} (${context})`,
    });
  }
}
