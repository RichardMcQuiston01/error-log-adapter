import { DEFAULT_PREFIX, reportFailure } from '../fail.js';
import { SerialQueue } from '../queue.js';
import { resolveEntryId } from '../entry-id.js';
import { generateId } from '../uuid.js';
import { resolveTimeoutMs, timeoutMessage, withTimeout } from '../timeout.js';
import { describeError, serializeEntry } from '../serialize.js';
import type {
  ErrorLogAdapter,
  ErrorLogEntry,
  ErrorLogResult,
} from '../types.js';

/** Default key prefix for stored objects. */
export const DEFAULT_S3_PREFIX = 'error_log/';

/** Buffered entries kept after failed uploads: this many times `batchSize`, oldest dropped first. */
export const BUFFER_LIMIT_MULTIPLIER = 10;

/** The parameters this adapter passes to `putObject`. */
export interface S3PutObjectInput {
  Bucket: string;
  Key: string;
  Body: string;
  ContentType: string;
}

/**
 * The only thing this adapter needs from an S3 client: `putObject`. The AWS
 * SDK v3 aggregated client (`new S3({ ... })` from `@aws-sdk/client-s3`) fits as
 * it is, and so does anything else that follows the S3 API, including
 * DigitalOcean Spaces, Cloudflare R2 and MinIO when you point the client at
 * their endpoint.
 *
 * Some S3-compatible providers reject the checksum headers that recent AWS SDK
 * v3 versions add by default. If uploads fail with a checksum or header error,
 * create the client with `requestChecksumCalculation: 'WHEN_REQUIRED'` and
 * `responseChecksumValidation: 'WHEN_REQUIRED'`.
 */
export interface S3ClientLike {
  putObject(input: S3PutObjectInput): Promise<unknown>;
}

export interface S3BatchOptions {
  /** Upload once this many entries are buffered. */
  batchSize: number;
  /**
   * Also upload when the oldest buffered entry has waited this long (ms). The
   * timer does not keep the process alive, so call `flush()` before exiting.
   */
  maxWaitMs?: number;
}

export interface S3ErrorOptions {
  /**
   * Key prefix, for example `logs/app/`. A trailing slash is added if missing.
   * Defaults to `error_log/`. Use `''` for no prefix.
   */
  keyPrefix?: string;
  /**
   * Content type of the uploaded objects. Defaults to `application/json`, or
   * `application/x-ndjson` when batching.
   */
  contentType?: string;
  /**
   * Buffer entries and upload them together as one newline-delimited JSON
   * object. Off by default: one object per entry.
   */
  batch?: S3BatchOptions;
  /** Text printed before failure messages. Defaults to `[error-log-adapter]`. */
  prefix?: string;
  /**
   * How long an upload may take before `log` (or `flush`) gives up waiting, in
   * milliseconds. Defaults to 10000. Pass `Infinity` to wait without limit. The
   * upload cannot be cancelled, so it may still finish afterwards; in batch mode
   * the entries stay buffered and are uploaded again by the next flush.
   */
  timeoutMs?: number;
}

interface S3Record {
  id: string;
  code: string;
  message: string;
  cause?: unknown;
  source?: string;
  timestamp: string;
}

/** Turns `2026-01-02T03:04:05.678Z` into `2026/01/02/20260102T030405678Z`. */
function datePath(date: Date): string {
  const compact: string = date.toISOString().replace(/[-:.]/g, '');
  return `${compact.slice(0, 4)}/${compact.slice(4, 6)}/${compact.slice(6, 8)}/${compact}`;
}

function normalizePrefix(prefix: string): string {
  const trimmed: string = prefix.replace(/^\/+/, '');
  return trimmed === '' || trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

/**
 * Stores entries as objects in an S3-compatible bucket, keyed by date and UUID:
 * `error_log/2026/01/02/20260102T030405678Z-<uuid>.json`.
 *
 * By default each entry becomes its own JSON object and `log` resolves once the
 * upload succeeds. With `batch`, entries are buffered and uploaded together as
 * one `.ndjson` object; `log` then resolves ok as soon as the entry is
 * buffered (it is not stored yet), except for the call that fills the batch,
 * which resolves with the upload result. Call `flush()` before shutting down.
 */
export class S3ErrorAdapter<
  TCode extends string = string,
> implements ErrorLogAdapter<TCode> {
  private readonly keyPrefix: string;
  private readonly contentType: string;
  private readonly batch: S3BatchOptions | undefined;
  private readonly logPrefix: string;
  private readonly timeoutMs: number;
  private buffer: S3Record[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly flushQueue: SerialQueue = new SerialQueue();

  /** @throws {RangeError} if `bucket` is empty or the batch options are invalid. */
  constructor(
    private readonly client: S3ClientLike,
    private readonly bucket: string,
    options: S3ErrorOptions = {}
  ) {
    this.keyPrefix = normalizePrefix(options.keyPrefix ?? DEFAULT_S3_PREFIX);
    this.batch = options.batch;
    this.contentType =
      options.contentType ??
      (this.batch === undefined ? 'application/json' : 'application/x-ndjson');
    this.logPrefix = options.prefix ?? DEFAULT_PREFIX;
    this.timeoutMs = resolveTimeoutMs(options.timeoutMs, 'S3ErrorAdapter');
    if (bucket === '') {
      throw new RangeError('S3ErrorAdapter: bucket must not be empty.');
    }
    if (this.batch !== undefined) {
      if (!Number.isInteger(this.batch.batchSize) || this.batch.batchSize < 1) {
        throw new RangeError(
          `S3ErrorAdapter: batch.batchSize must be a positive integer, received ${String(this.batch.batchSize)}.`
        );
      }
      if (
        this.batch.maxWaitMs !== undefined &&
        (!Number.isFinite(this.batch.maxWaitMs) || this.batch.maxWaitMs <= 0)
      ) {
        throw new RangeError(
          `S3ErrorAdapter: batch.maxWaitMs must be a positive number, received ${String(this.batch.maxWaitMs)}.`
        );
      }
    }
  }

  async log(entry: ErrorLogEntry<TCode>): Promise<ErrorLogResult> {
    try {
      const record: S3Record = {
        id: resolveEntryId(entry),
        ...serializeEntry(entry),
      };
      const occurredAt: Date = new Date(record.timestamp);
      if (Number.isNaN(occurredAt.getTime())) {
        throw new RangeError(
          `timestamp "${record.timestamp}" is not a valid ISO 8601 date`
        );
      }
      if (this.batch === undefined) {
        const key: string = `${this.keyPrefix}${datePath(occurredAt)}-${record.id}.json`;
        await this.upload(key, `${JSON.stringify(record)}\n`);
        return { ok: true };
      }
      return await this.addToBatch(record, this.batch);
    } catch (error: unknown) {
      return this.fail(error);
    }
  }

  /**
   * Uploads any buffered entries now. Resolves ok when nothing is buffered.
   * Entries from a failed upload stay buffered and are retried by the next flush.
   */
  flush(): Promise<ErrorLogResult> {
    return this.flushQueue.run((): Promise<ErrorLogResult> =>
      this.uploadBuffered()
    );
  }

  private async addToBatch(
    record: S3Record,
    batch: S3BatchOptions
  ): Promise<ErrorLogResult> {
    this.buffer.push(record);
    const limit: number = batch.batchSize * BUFFER_LIMIT_MULTIPLIER;
    if (this.buffer.length > limit) {
      const dropped: number = this.buffer.length - limit;
      this.buffer = this.buffer.slice(dropped);
      console.error(
        `${this.logPrefix} S3ErrorAdapter: dropped the ${dropped} oldest buffered entries because uploads to bucket "${this.bucket}" keep failing and the buffer is full (${limit} entries).`
      );
    }
    if (this.buffer.length >= batch.batchSize) {
      return this.flush();
    }
    this.scheduleFlush(batch);
    return { ok: true };
  }

  private scheduleFlush(batch: S3BatchOptions): void {
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

  private async uploadBuffered(): Promise<ErrorLogResult> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const pending: S3Record[] = this.buffer.slice();
    if (pending.length === 0) {
      return { ok: true };
    }
    try {
      const key: string = `${this.keyPrefix}${datePath(new Date())}-${generateId()}.ndjson`;
      const body: string = pending
        .map((record: S3Record): string => JSON.stringify(record))
        .join('\n');
      await this.upload(key, `${body}\n`);
      const uploaded: Set<S3Record> = new Set(pending);
      this.buffer = this.buffer.filter(
        (record: S3Record): boolean => !uploaded.has(record)
      );
      return { ok: true };
    } catch (error: unknown) {
      if (this.batch !== undefined) {
        this.scheduleFlush(this.batch);
      }
      return this.fail(error, pending.length);
    }
  }

  private upload(key: string, body: string): Promise<unknown> {
    return withTimeout(
      (): Promise<unknown> =>
        this.client.putObject({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: this.contentType,
        }),
      this.timeoutMs,
      timeoutMessage('S3', this.timeoutMs)
    );
  }

  private fail(error: unknown, bufferedCount?: number): ErrorLogResult {
    const retry: string =
      bufferedCount === undefined
        ? ''
        : ` (${bufferedCount} buffered ${bufferedCount === 1 ? 'entry was' : 'entries were'} kept for the next flush)`;
    return reportFailure({
      adapterName: 'S3ErrorAdapter',
      prefix: this.logPrefix,
      action: `to upload to bucket "${this.bucket}"`,
      error,
      reason: `${describeError(error)}${retry}`,
    });
  }
}
