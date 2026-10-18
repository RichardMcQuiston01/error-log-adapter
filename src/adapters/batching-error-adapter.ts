import { backoffDelayMs } from '../backoff.js';
import { DEFAULT_PREFIX } from '../fail.js';
import { describeError } from '../serialize.js';
import type {
  ErrorLogAdapter,
  ErrorLogEntry,
  ErrorLogResult,
} from '../types.js';

/**
 * An adapter that can send several entries in one go, such as
 * `WebhookErrorAdapter` (one request carrying a JSON array).
 * `BatchingErrorAdapter` uses it when it is there. The whole batch succeeds or
 * fails together.
 */
export interface BatchCapableAdapter<
  TCode extends string = string,
> extends ErrorLogAdapter<TCode> {
  logBatch(entries: ErrorLogEntry<TCode>[]): Promise<ErrorLogResult>;
}

export interface BatchingErrorOptions<TCode extends string = string> {
  /** Deliver once this many entries are waiting. Defaults to 20. */
  batchSize?: number;
  /**
   * Also deliver once the oldest waiting entry has waited this long (ms).
   * Defaults to 5000. Pass `Infinity` to deliver only when `batchSize` is
   * reached or `flush()` is called. The timer does not keep the process alive,
   * so call `flush()` before exiting.
   */
  maxWaitMs?: number;
  /**
   * How many times to try an entry again after a failed delivery before giving
   * up on it. Defaults to 3 (four attempts in all).
   */
  retries?: number;
  /** Wait before the first retry, in milliseconds; it doubles after that. Defaults to 500. */
  retryDelayMs?: number;
  /** Longest wait between attempts, in milliseconds. Defaults to 30000. */
  maxRetryDelayMs?: number;
  /**
   * Most entries kept while the sink is slow or down. Past this, the oldest
   * are dropped. Defaults to 1000. Must be at least `batchSize`.
   */
  maxBuffered?: number;
  /**
   * Use the wrapped adapter's `logBatch` when it has one. Defaults to `true`.
   * Pass `false` to deliver one entry at a time even then (a wrapped
   * `WebhookErrorAdapter` then sends one request per entry, not an array).
   */
  useBatchMethod?: boolean;
  /**
   * Called when entries are given up on, either because they failed every
   * attempt or because the buffer was full. Errors it throws are ignored.
   */
  onDrop?: (entries: ErrorLogEntry<TCode>[], reason: string) => void;
  /** Text printed before failure messages. Defaults to `[error-log-adapter]`. */
  prefix?: string;
}

interface Pending<TCode extends string> {
  entry: ErrorLogEntry<TCode>;
  /** Failed deliveries so far. */
  failures: number;
}

const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_MAX_WAIT_MS = 5000;
const DEFAULT_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 500;
const DEFAULT_MAX_RETRY_DELAY_MS = 30_000;
const DEFAULT_MAX_BUFFERED = 1000;

function hasLogBatch<TCode extends string>(
  adapter: ErrorLogAdapter<TCode>
): adapter is BatchCapableAdapter<TCode> {
  return (
    typeof (adapter as Partial<BatchCapableAdapter<TCode>>).logBatch ===
    'function'
  );
}

/**
 * Puts a queue in front of any other adapter. `log()` returns `ok: true` as
 * soon as the entry is queued, so a slow or failing sink never holds up the
 * application; entries are then delivered in order, in batches, and a failed
 * delivery is tried again with exponential backoff before the entry is given up
 * on (see `onDrop`).
 *
 * Delivery uses the wrapped adapter's `logBatch` when it has one (the webhook
 * sends one request for the whole batch); otherwise the entries go one at a
 * time through `log`, stopping at the first failure so a sink that is down is
 * not hammered. Because of that, `ok: true` from `log()` means "queued", not
 * "stored": call `flush()` before the process exits, and watch `onDrop` or the
 * console for entries that could not be delivered. The queue is in memory, so
 * entries still waiting when the process dies are lost; put a durable adapter
 * beside it in a `CompositeErrorAdapter` when that matters.
 *
 * ```ts
 * const errorLog = new BatchingErrorAdapter(
 *   new WebhookErrorAdapter('https://example.com/errors'),
 *   { batchSize: 50, maxWaitMs: 2000 }
 * );
 * process.on('beforeExit', () => void errorLog.flush());
 * ```
 *
 * Do not also turn on the wrapped adapter's own retries (for example the
 * webhook's `retries`): the two multiply.
 */
export class BatchingErrorAdapter<
  TCode extends string = string,
> implements ErrorLogAdapter<TCode> {
  private readonly batchSize: number;
  private readonly maxWaitMs: number;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly maxBuffered: number;
  private readonly useBatchMethod: boolean;
  private readonly onDrop: BatchingErrorOptions<TCode>['onDrop'];
  private readonly logPrefix: string;

  private queue: Pending<TCode>[] = [];
  private waitTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffTimer: ReturnType<typeof setTimeout> | null = null;
  private draining: Promise<void> | null = null;
  private flushers = 0;
  private droppedSinceFlush = 0;
  private lastDropReason = '';

  /** @throws {RangeError} if an option is out of range. */
  constructor(
    private readonly inner: ErrorLogAdapter<TCode>,
    options: BatchingErrorOptions<TCode> = {}
  ) {
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.retries = options.retries ?? DEFAULT_RETRIES;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.maxRetryDelayMs =
      options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
    this.maxBuffered = options.maxBuffered ?? DEFAULT_MAX_BUFFERED;
    this.useBatchMethod = options.useBatchMethod ?? true;
    this.onDrop = options.onDrop;
    this.logPrefix = options.prefix ?? DEFAULT_PREFIX;

    if (!Number.isInteger(this.batchSize) || this.batchSize < 1) {
      throw new RangeError(
        `BatchingErrorAdapter: batchSize must be a positive integer, received ${String(options.batchSize)}.`
      );
    }
    if (Number.isNaN(this.maxWaitMs) || this.maxWaitMs <= 0) {
      throw new RangeError(
        `BatchingErrorAdapter: maxWaitMs must be a positive number or Infinity, received ${String(options.maxWaitMs)}.`
      );
    }
    if (!Number.isInteger(this.retries) || this.retries < 0) {
      throw new RangeError(
        `BatchingErrorAdapter: retries must be a whole number of 0 or more, received ${String(options.retries)}.`
      );
    }
    if (!Number.isFinite(this.retryDelayMs) || this.retryDelayMs <= 0) {
      throw new RangeError(
        `BatchingErrorAdapter: retryDelayMs must be a positive number, received ${String(options.retryDelayMs)}.`
      );
    }
    if (
      !Number.isFinite(this.maxRetryDelayMs) ||
      this.maxRetryDelayMs < this.retryDelayMs
    ) {
      throw new RangeError(
        `BatchingErrorAdapter: maxRetryDelayMs must be a number no smaller than retryDelayMs (${this.retryDelayMs}), received ${String(options.maxRetryDelayMs)}.`
      );
    }
    if (
      !Number.isInteger(this.maxBuffered) ||
      this.maxBuffered < this.batchSize
    ) {
      throw new RangeError(
        `BatchingErrorAdapter: maxBuffered must be a whole number no smaller than batchSize (${this.batchSize}), received ${String(options.maxBuffered)}.`
      );
    }
  }

  /** Queues the entry. Resolves ok straight away; delivery happens in the background. */
  log(entry: ErrorLogEntry<TCode>): Promise<ErrorLogResult> {
    this.queue.push({ entry, failures: 0 });
    if (this.queue.length > this.maxBuffered) {
      const overflow: Pending<TCode>[] = this.queue.splice(
        0,
        this.queue.length - this.maxBuffered
      );
      this.drop(
        overflow,
        `the buffer of ${this.maxBuffered} entries was full because the wrapped adapter keeps failing`
      );
    }
    if (this.queue.length >= this.batchSize) {
      this.startDraining();
    } else {
      this.scheduleDrain();
    }
    return Promise.resolve({ ok: true });
  }

  /**
   * Delivers everything queued, retrying as configured, and resolves once the
   * queue is empty. Resolves `ok: false` if any entries were given up on since
   * the last flush. With retries on and the sink down this can take a while
   * (the waits add up to well over a minute with the defaults).
   */
  async flush(): Promise<ErrorLogResult> {
    this.flushers += 1;
    // A process waiting in flush() must not exit during a backoff sleep.
    this.backoffTimer?.ref?.();
    try {
      this.startDraining();
      while (this.draining !== null) {
        await this.draining;
      }
    } finally {
      this.flushers -= 1;
    }
    if (this.droppedSinceFlush > 0) {
      const count: number = this.droppedSinceFlush;
      const reason: string = this.lastDropReason;
      this.droppedSinceFlush = 0;
      this.lastDropReason = '';
      return {
        ok: false,
        error: `BatchingErrorAdapter gave up on ${count} entr${count === 1 ? 'y' : 'ies'}: ${reason}`,
      };
    }
    return { ok: true };
  }

  private scheduleDrain(): void {
    if (this.waitTimer !== null || this.maxWaitMs === Infinity) {
      return;
    }
    const timer = setTimeout((): void => {
      this.waitTimer = null;
      this.startDraining();
    }, this.maxWaitMs);
    (timer as { unref?: () => void }).unref?.();
    this.waitTimer = timer;
  }

  private startDraining(): void {
    if (this.waitTimer !== null) {
      clearTimeout(this.waitTimer);
      this.waitTimer = null;
    }
    if (this.draining !== null || this.queue.length === 0) {
      return;
    }
    this.draining = this.drain()
      .catch((error: unknown): void => {
        // drain() handles every failure itself; this only guards a bug.
        console.error(`${this.logPrefix} BatchingErrorAdapter:`, error);
      })
      .finally((): void => {
        this.draining = null;
        // Entries logged after the last batch was taken still need a timer.
        if (this.queue.length > 0) {
          this.scheduleDrain();
        }
      });
  }

  /** Delivers batches until the queue is empty, waiting out a backoff after each failure. */
  private async drain(): Promise<void> {
    let failedRounds = 0;
    while (this.queue.length > 0) {
      const batch: Pending<TCode>[] = this.queue.slice(0, this.batchSize);
      const failure: string | undefined = await this.deliver(batch);
      if (failure === undefined) {
        failedRounds = 0;
        continue;
      }
      failedRounds += 1;
      const exhausted: Pending<TCode>[] = this.queue.filter(
        (item: Pending<TCode>): boolean => item.failures > this.retries
      );
      if (exhausted.length > 0) {
        this.queue = this.queue.filter(
          (item: Pending<TCode>): boolean => item.failures <= this.retries
        );
        this.drop(
          exhausted,
          `delivery failed ${this.retries + 1} time${this.retries === 0 ? '' : 's'}; last error: ${failure}`
        );
      }
      if (this.queue.length > 0) {
        await this.backoff(failedRounds);
      }
    }
  }

  /**
   * Tries to deliver `batch` (the front of the queue). Delivered entries leave
   * the queue; an entry that failed has its failure count raised and stays.
   * Resolves to the failure message, or undefined when everything went through.
   */
  private async deliver(batch: Pending<TCode>[]): Promise<string | undefined> {
    const remove = (delivered: Pending<TCode>[]): void => {
      const gone: Set<Pending<TCode>> = new Set(delivered);
      this.queue = this.queue.filter(
        (item: Pending<TCode>): boolean => !gone.has(item)
      );
    };

    if (this.useBatchMethod && hasLogBatch(this.inner)) {
      const result: ErrorLogResult = await this.safely(
        (): Promise<ErrorLogResult> =>
          (this.inner as BatchCapableAdapter<TCode>).logBatch(
            batch.map(
              (item: Pending<TCode>): ErrorLogEntry<TCode> => item.entry
            )
          )
      );
      if (result.ok) {
        remove(batch);
        return undefined;
      }
      for (const item of batch) {
        item.failures += 1;
      }
      return result.error ?? 'the wrapped adapter reported a failure';
    }

    for (const item of batch) {
      const result: ErrorLogResult = await this.safely(
        (): Promise<ErrorLogResult> => this.inner.log(item.entry)
      );
      if (result.ok) {
        remove([item]);
        continue;
      }
      // Stop here: the entries after this one stay queued without a failure
      // counted against them, and are tried after the backoff.
      item.failures += 1;
      return result.error ?? 'the wrapped adapter reported a failure';
    }
    return undefined;
  }

  /** The wrapped adapter should not throw, but a bug in one must not stop the queue. */
  private async safely(
    call: () => Promise<ErrorLogResult>
  ): Promise<ErrorLogResult> {
    try {
      return await call();
    } catch (error: unknown) {
      return { ok: false, error: describeError(error) };
    }
  }

  private backoff(failedRounds: number): Promise<void> {
    return new Promise<void>((resolve: () => void): void => {
      const timer = setTimeout(
        (): void => {
          this.backoffTimer = null;
          resolve();
        },
        backoffDelayMs(failedRounds, this.retryDelayMs, this.maxRetryDelayMs)
      );
      // Only a caller waiting in flush() should be kept alive by this wait.
      if (this.flushers === 0) {
        (timer as { unref?: () => void }).unref?.();
      }
      this.backoffTimer = timer;
    });
  }

  private drop(items: Pending<TCode>[], reason: string): void {
    if (items.length === 0) {
      return;
    }
    this.droppedSinceFlush += items.length;
    this.lastDropReason = reason;
    console.error(
      `${this.logPrefix} BatchingErrorAdapter: gave up on ${items.length} entr${items.length === 1 ? 'y' : 'ies'}: ${reason}`
    );
    try {
      this.onDrop?.(
        items.map((item: Pending<TCode>): ErrorLogEntry<TCode> => item.entry),
        reason
      );
    } catch {
      // A failing callback must not stop delivery.
    }
  }
}
