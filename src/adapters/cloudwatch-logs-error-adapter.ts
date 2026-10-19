import { resolveEntryId } from '../entry-id.js';
import { DEFAULT_PREFIX, reportFailure } from '../fail.js';
import { SerialQueue } from '../queue.js';
import { serializeEntry } from '../serialize.js';
import { resolveTimeoutMs, timeoutMessage, withTimeout } from '../timeout.js';
import type {
  ErrorLogAdapter,
  ErrorLogEntry,
  ErrorLogResult,
} from '../types.js';

/** Largest event CloudWatch accepts: 256 KiB, counting 26 bytes of overhead per event. */
export const MAX_EVENT_BYTES = 262_144;
/** Overhead CloudWatch adds to every event when it measures size. */
export const EVENT_OVERHEAD_BYTES = 26;
/** Largest `PutLogEvents` request: 1 MiB of events. */
export const MAX_BATCH_BYTES = 1_048_576;
/** Most events in one `PutLogEvents` request. */
export const MAX_BATCH_EVENTS = 10_000;
/** The events of one request may not span more than this. */
const MAX_BATCH_SPAN_MS = 24 * 60 * 60 * 1000;

/** Buffered events kept after failed sends: this many times `batchSize`, oldest dropped first. */
export const BUFFER_LIMIT_MULTIPLIER = 10;

/** One event as `PutLogEvents` takes it. */
export interface CloudWatchLogEvent {
  /** Milliseconds since the epoch. */
  timestamp: number;
  message: string;
}

/** The parameters this adapter passes to `putLogEvents`. */
export interface CloudWatchPutLogEventsInput {
  logGroupName: string;
  logStreamName: string;
  logEvents: CloudWatchLogEvent[];
}

/**
 * What an AWS SDK client needs to offer. The AWS SDK v3 aggregated client
 * (`new CloudWatchLogs({ ... })` from `@aws-sdk/client-cloudwatch-logs`) fits as
 * it is. `createLogGroup` and `createLogStream` are only used when
 * `createMissing` is on (the default); leave them out of a hand-written client
 * that cannot create them.
 */
export interface CloudWatchLogsClientLike {
  putLogEvents(input: CloudWatchPutLogEventsInput): Promise<unknown>;
  createLogGroup?(input: { logGroupName: string }): Promise<unknown>;
  createLogStream?(input: {
    logGroupName: string;
    logStreamName: string;
  }): Promise<unknown>;
}

export interface CloudWatchBatchOptions {
  /** Send once this many events are buffered. */
  batchSize: number;
  /**
   * Also send when the oldest buffered event has waited this long (ms). The
   * timer does not keep the process alive, so call `flush()` before exiting.
   */
  maxWaitMs?: number;
}

export interface CloudWatchLogsErrorOptions {
  /**
   * Create the log stream, and the log group if that is missing too, when
   * `PutLogEvents` says they do not exist, then try again once. This needs the
   * `logs:CreateLogStream` (and `logs:CreateLogGroup`) permissions and only runs
   * after a "not found" answer, so a stream that exists costs nothing. A group
   * created this way never expires its logs; set a retention policy on it.
   * Defaults to `true`.
   */
  createMissing?: boolean;
  /**
   * Buffer events and send them together, up to the 10,000 events and 1 MiB
   * that one request allows. Off by default: one request per entry.
   */
  batch?: CloudWatchBatchOptions;
  /** Text printed before failure messages. Defaults to `[error-log-adapter]`. */
  prefix?: string;
  /**
   * How long a request may take before `log` (or `flush`) gives up waiting, in
   * milliseconds. Defaults to 10000. Pass `Infinity` to wait without limit. The
   * request cannot be cancelled, so it may still finish afterwards; in batch
   * mode the events stay buffered and are sent again by the next flush.
   */
  timeoutMs?: number;
}

interface BufferedEvent extends CloudWatchLogEvent {
  /** Entry id, for failure messages. */
  id: string;
}

interface RejectedLogEventsInfo {
  tooNewLogEventStartIndex?: number;
  tooOldLogEventEndIndex?: number;
  expiredLogEventEndIndex?: number;
}

const encoder = new TextEncoder();

function eventBytes(message: string): number {
  return encoder.encode(message).length + EVENT_OVERHEAD_BYTES;
}

/** The AWS SDK names its errors; this works for both SDK v3 errors and hand-made ones. */
function errorName(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null
    ? (error as { name?: string }).name
    : undefined;
}

/**
 * Splits events (oldest first) into groups that fit one `PutLogEvents` request:
 * at most 10,000 events, 1 MiB, and 24 hours between the first and the last.
 */
export function splitIntoRequests<T extends CloudWatchLogEvent>(
  events: readonly T[]
): T[][] {
  const requests: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const event of events) {
    const size: number = eventBytes(event.message);
    const first: T | undefined = current[0];
    if (
      first !== undefined &&
      (current.length >= MAX_BATCH_EVENTS ||
        bytes + size > MAX_BATCH_BYTES ||
        event.timestamp - first.timestamp > MAX_BATCH_SPAN_MS)
    ) {
      requests.push(current);
      current = [];
      bytes = 0;
    }
    current.push(event);
    bytes += size;
  }
  if (current.length > 0) {
    requests.push(current);
  }
  return requests;
}

/**
 * Sends entries to one CloudWatch Logs stream through `PutLogEvents`, each as a
 * JSON event (the serialized entry plus its UUID `id`) stamped with the entry's
 * time, so Logs Insights can query its fields. AWS no longer asks for sequence
 * tokens, so none are tracked.
 *
 * By default each entry is its own request and `log` resolves once CloudWatch
 * accepts it. With `batch`, events are buffered and sent together; `log` then
 * resolves ok as soon as the event is buffered (it is not stored yet), except
 * for the call that fills the batch, which resolves with the send result. Call
 * `flush()` before shutting down.
 *
 * CloudWatch can answer ok and still reject events it considers too old (over
 * 14 days) or too new (over 2 hours ahead); that is reported as `ok: false`. An
 * event over 256 KiB is refused before sending, since CloudWatch would reject
 * the whole request.
 *
 * In AWS Lambda, ECS and similar runtimes, anything written to stdout already
 * reaches CloudWatch; this adapter is for apps running elsewhere.
 */
export class CloudWatchLogsErrorAdapter<
  TCode extends string = string,
> implements ErrorLogAdapter<TCode> {
  private readonly createMissing: boolean;
  private readonly batch: CloudWatchBatchOptions | undefined;
  private readonly logPrefix: string;
  private readonly timeoutMs: number;
  private buffer: BufferedEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly flushQueue: SerialQueue = new SerialQueue();

  /** @throws {RangeError} if a name is empty, the batch or timeout options are invalid, or `createMissing` is on but the client cannot create streams. */
  constructor(
    private readonly client: CloudWatchLogsClientLike,
    private readonly logGroupName: string,
    private readonly logStreamName: string,
    options: CloudWatchLogsErrorOptions = {}
  ) {
    this.createMissing = options.createMissing ?? true;
    this.batch = options.batch;
    this.logPrefix = options.prefix ?? DEFAULT_PREFIX;
    this.timeoutMs = resolveTimeoutMs(
      options.timeoutMs,
      'CloudWatchLogsErrorAdapter'
    );
    if (logGroupName === '') {
      throw new RangeError(
        'CloudWatchLogsErrorAdapter: logGroupName must not be empty.'
      );
    }
    if (logStreamName === '') {
      throw new RangeError(
        'CloudWatchLogsErrorAdapter: logStreamName must not be empty.'
      );
    }
    if (this.createMissing && typeof client.createLogStream !== 'function') {
      throw new RangeError(
        'CloudWatchLogsErrorAdapter: createMissing is on, but the client has no createLogStream method. Pass createMissing: false, or use an AWS SDK CloudWatchLogs client.'
      );
    }
    if (this.batch !== undefined) {
      if (!Number.isInteger(this.batch.batchSize) || this.batch.batchSize < 1) {
        throw new RangeError(
          `CloudWatchLogsErrorAdapter: batch.batchSize must be a positive integer, received ${String(this.batch.batchSize)}.`
        );
      }
      if (
        this.batch.maxWaitMs !== undefined &&
        (!Number.isFinite(this.batch.maxWaitMs) || this.batch.maxWaitMs <= 0)
      ) {
        throw new RangeError(
          `CloudWatchLogsErrorAdapter: batch.maxWaitMs must be a positive number, received ${String(this.batch.maxWaitMs)}.`
        );
      }
    }
  }

  async log(entry: ErrorLogEntry<TCode>): Promise<ErrorLogResult> {
    try {
      const id: string = resolveEntryId(entry);
      const record = { id, ...serializeEntry(entry) };
      const timestamp: number = Date.parse(record.timestamp);
      if (Number.isNaN(timestamp)) {
        throw new RangeError(
          `timestamp "${record.timestamp}" is not a valid ISO 8601 date`
        );
      }
      const message: string = JSON.stringify(record);
      const size: number = eventBytes(message);
      if (size > MAX_EVENT_BYTES) {
        throw new RangeError(
          `the event is ${size} bytes, over the ${MAX_EVENT_BYTES} byte limit CloudWatch Logs puts on one event, so it was not sent; shorten the message or cause`
        );
      }
      const event: BufferedEvent = { id, timestamp, message };
      if (this.batch === undefined) {
        const rejection: string | undefined = await this.send([event]);
        if (rejection !== undefined) {
          throw new Error(rejection);
        }
        return { ok: true };
      }
      return await this.addToBatch(event, this.batch);
    } catch (error: unknown) {
      return this.fail(error);
    }
  }

  /**
   * Sends any buffered events now. Resolves ok when nothing is buffered. Events
   * from a failed send stay buffered and are retried by the next flush.
   */
  flush(): Promise<ErrorLogResult> {
    return this.flushQueue.run((): Promise<ErrorLogResult> =>
      this.sendBuffered()
    );
  }

  private async addToBatch(
    event: BufferedEvent,
    batch: CloudWatchBatchOptions
  ): Promise<ErrorLogResult> {
    this.buffer.push(event);
    const limit: number = batch.batchSize * BUFFER_LIMIT_MULTIPLIER;
    if (this.buffer.length > limit) {
      const dropped: number = this.buffer.length - limit;
      this.buffer = this.buffer.slice(dropped);
      console.error(
        `${this.logPrefix} CloudWatchLogsErrorAdapter: dropped the ${dropped} oldest buffered events because sends to log stream "${this.logStreamName}" keep failing and the buffer is full (${limit} events).`
      );
    }
    if (this.buffer.length >= batch.batchSize) {
      return this.flush();
    }
    this.scheduleFlush(batch);
    return { ok: true };
  }

  private scheduleFlush(batch: CloudWatchBatchOptions): void {
    if (batch.maxWaitMs === undefined || this.timer !== null) {
      return;
    }
    const timer = setTimeout((): void => {
      this.timer = null;
      void this.flush();
    }, batch.maxWaitMs);
    (timer as { unref?: () => void }).unref?.();
    this.timer = timer;
  }

  private async sendBuffered(): Promise<ErrorLogResult> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const pending: BufferedEvent[] = this.buffer.slice();
    if (pending.length === 0) {
      return { ok: true };
    }
    // PutLogEvents wants events oldest first. The sort is stable, so events
    // with the same time keep the order they were logged in.
    pending.sort(
      (a: BufferedEvent, b: BufferedEvent): number => a.timestamp - b.timestamp
    );
    let rejectedTotal = 0;
    let lastRejection = '';
    try {
      for (const request of splitIntoRequests(pending)) {
        const rejection: string | undefined = await this.send(request);
        // Accepted or rejected for good (too old will never be accepted), the
        // events leave the buffer; only a thrown error keeps them for a retry.
        const sent: Set<BufferedEvent> = new Set(request);
        this.buffer = this.buffer.filter(
          (event: BufferedEvent): boolean => !sent.has(event)
        );
        if (rejection !== undefined) {
          rejectedTotal += request.length;
          lastRejection = rejection;
        }
      }
    } catch (error: unknown) {
      if (this.batch !== undefined) {
        this.scheduleFlush(this.batch);
      }
      return this.fail(error, this.buffer.length);
    }
    if (rejectedTotal > 0) {
      return this.fail(new Error(lastRejection), rejectedTotal);
    }
    return { ok: true };
  }

  /**
   * Sends one request, creating the stream first if CloudWatch says it is
   * missing. Resolves to a description of any events CloudWatch refused, or
   * undefined when it took them all.
   */
  private async send(events: BufferedEvent[]): Promise<string | undefined> {
    let output: unknown;
    try {
      output = await this.putLogEvents(events);
    } catch (error: unknown) {
      if (
        !this.createMissing ||
        errorName(error) !== 'ResourceNotFoundException'
      ) {
        throw error;
      }
      await this.createStream();
      output = await this.putLogEvents(events);
    }
    return describeRejection(output, events.length);
  }

  private putLogEvents(events: BufferedEvent[]): Promise<unknown> {
    return withTimeout(
      (): Promise<unknown> =>
        this.client.putLogEvents({
          logGroupName: this.logGroupName,
          logStreamName: this.logStreamName,
          logEvents: events.map(
            ({ timestamp, message }: BufferedEvent): CloudWatchLogEvent => ({
              timestamp,
              message,
            })
          ),
        }),
      this.timeoutMs,
      timeoutMessage('CloudWatch Logs', this.timeoutMs)
    );
  }

  private async createStream(): Promise<void> {
    const createStream = (): Promise<unknown> =>
      withTimeout(
        (): Promise<unknown> =>
          (
            this.client.createLogStream as NonNullable<
              CloudWatchLogsClientLike['createLogStream']
            >
          )({
            logGroupName: this.logGroupName,
            logStreamName: this.logStreamName,
          }),
        this.timeoutMs,
        timeoutMessage('CloudWatch Logs', this.timeoutMs, 'create the stream')
      );
    try {
      await createStream();
    } catch (error: unknown) {
      const name: string | undefined = errorName(error);
      if (name === 'ResourceAlreadyExistsException') {
        return;
      }
      if (
        name !== 'ResourceNotFoundException' ||
        typeof this.client.createLogGroup !== 'function'
      ) {
        throw error;
      }
      // The group is missing too.
      const createGroup = this.client.createLogGroup.bind(this.client);
      try {
        await withTimeout(
          (): Promise<unknown> =>
            createGroup({ logGroupName: this.logGroupName }),
          this.timeoutMs,
          timeoutMessage('CloudWatch Logs', this.timeoutMs, 'create the group')
        );
      } catch (groupError: unknown) {
        if (errorName(groupError) !== 'ResourceAlreadyExistsException') {
          throw groupError;
        }
      }
      try {
        await createStream();
      } catch (retryError: unknown) {
        if (errorName(retryError) !== 'ResourceAlreadyExistsException') {
          throw retryError;
        }
      }
    }
  }

  private fail(error: unknown, count?: number): ErrorLogResult {
    return reportFailure({
      adapterName: 'CloudWatchLogsErrorAdapter',
      prefix: this.logPrefix,
      action: `to send to log stream "${this.logStreamName}" in log group "${this.logGroupName}"${count === undefined ? '' : ` (${count} event${count === 1 ? '' : 's'} affected)`}`,
      error,
    });
  }
}

/** Explains `rejectedLogEventsInfo`, which CloudWatch returns with an otherwise successful answer. */
function describeRejection(
  output: unknown,
  eventCount: number
): string | undefined {
  const info: RejectedLogEventsInfo | undefined =
    typeof output === 'object' && output !== null
      ? (output as { rejectedLogEventsInfo?: RejectedLogEventsInfo })
          .rejectedLogEventsInfo
      : undefined;
  if (info === undefined || info === null) {
    return undefined;
  }
  const reasons: string[] = [];
  if (info.tooOldLogEventEndIndex !== undefined) {
    reasons.push(
      `${info.tooOldLogEventEndIndex} event(s) were older than the 14 days CloudWatch accepts`
    );
  }
  if (info.expiredLogEventEndIndex !== undefined) {
    reasons.push(
      `${info.expiredLogEventEndIndex} event(s) were older than the log group's retention period`
    );
  }
  if (info.tooNewLogEventStartIndex !== undefined) {
    reasons.push(
      `${Math.max(0, eventCount - info.tooNewLogEventStartIndex)} event(s) were more than 2 hours ahead of the current time`
    );
  }
  return reasons.length === 0
    ? undefined
    : `CloudWatch Logs accepted the request but rejected events: ${reasons.join('; ')}`;
}
