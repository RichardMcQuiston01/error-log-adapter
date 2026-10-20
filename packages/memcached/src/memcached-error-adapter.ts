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

/** Key prefix used when `keyPrefix` is not given. */
export const DEFAULT_KEY_PREFIX = 'error_log:';

/** How long an entry lives when `ttlSeconds` is not given: seven days. */
export const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Memcached reads a larger expiry as a Unix time, so 30 days is the longest lifetime. */
export const MAX_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Entries kept in the recent list when `ringSize` is not given. */
export const DEFAULT_RING_SIZE = 100;

/** Largest value written, a little under Memcached's default 1 MiB item limit. */
export const DEFAULT_MAX_VALUE_BYTES = 1_000_000;

/** The longest key Memcached accepts. */
const MAX_KEY_LENGTH = 250;

/** The options this adapter passes when it stores a value. */
export interface MemcachedStoreOptionsLike {
  /** Seconds until the value expires. */
  expires?: number;
}

/** The options this adapter passes to `increment`. */
export interface MemcachedIncrementOptionsLike {
  /** Value stored, without incrementing, when the key does not exist yet. */
  initial?: number;
  /** Seconds until the counter expires; 0 never. */
  expires?: number;
}

/**
 * What this adapter needs from a Memcached client: `add`, `set`, `delete` and
 * `increment`. A `Client` from [`memjs`](https://www.npmjs.com/package/memjs)
 * fits as it is.
 */
export interface MemcachedClientLike {
  /** Stores a value only if the key is free. Resolves `false` when the key exists. */
  add(
    key: string,
    value: string,
    options?: MemcachedStoreOptionsLike
  ): Promise<boolean>;
  set(
    key: string,
    value: string,
    options?: MemcachedStoreOptionsLike
  ): Promise<boolean>;
  delete(key: string): Promise<boolean>;
  increment(
    key: string,
    amount: number,
    options?: MemcachedIncrementOptionsLike
  ): Promise<{ success: boolean; value?: number | null | undefined }>;
}

export interface MemcachedKeyOptions {
  /** Prefix of every key this adapter writes. Defaults to `error_log:`. */
  keyPrefix?: string;
  /** How many of the newest entries the recent list keeps. Defaults to 100; 0 turns the list off. */
  ringSize?: number;
}

export interface MemcachedErrorOptions extends MemcachedKeyOptions {
  /**
   * Seconds an entry is kept before Memcached may drop it. Defaults to seven
   * days. At most 30 days.
   */
  ttlSeconds?: number;
  /** Refuse a value larger than this many bytes. Defaults to 1000000. */
  maxValueBytes?: number;
  /** Text printed before failure messages. Defaults to `[error-log-adapter]`. */
  prefix?: string;
  /**
   * How long to wait for each Memcached request, in milliseconds. Defaults to
   * 10000. Pass `Infinity` to wait without limit. The request cannot be
   * cancelled, so it may still finish after `log` has returned a failure.
   */
  timeoutMs?: number;
}

/** One entry as this adapter stores it, as a JSON string. */
export interface MemcachedStoredEntry {
  /** The entry's UUID. */
  id: string;
  code: string;
  message: string;
  /** The serialized cause. Left out when the entry has none. */
  cause?: unknown;
  /** Left out when the entry has none. */
  source?: string;
  /** ISO 8601, UTC. */
  occurred_at: string;
  /** ISO 8601, UTC: when the adapter wrote it. */
  created_at: string;
}

interface PreparedEntry {
  id: string;
  key: string;
  value: string;
}

function assertKeyPrefix(keyPrefix: string, owner: string): void {
  if (
    keyPrefix.length > 100 ||
    !/^[\x21-\x7e]*$/.test(keyPrefix) // printable ASCII, no spaces or control characters
  ) {
    throw new RangeError(
      `${owner}: keyPrefix must be at most 100 printable ASCII characters with no spaces, received ${JSON.stringify(keyPrefix)}.`
    );
  }
}

function assertRingSize(ringSize: number, owner: string): void {
  if (!Number.isInteger(ringSize) || ringSize < 0 || ringSize > 100_000) {
    throw new RangeError(
      `${owner}: ringSize must be a whole number from 0 to 100000, received ${String(ringSize)}.`
    );
  }
}

/** The key one entry is stored under. */
export function entryKey(
  id: string,
  keyPrefix: string = DEFAULT_KEY_PREFIX
): string {
  return `${keyPrefix}${id}`;
}

/** The key of the counter that numbers the entries in the recent list. */
export function counterKey(keyPrefix: string = DEFAULT_KEY_PREFIX): string {
  return `${keyPrefix}count`;
}

/** The key of one slot of the recent list; its value is an entry id. */
export function slotKey(
  slot: number,
  keyPrefix: string = DEFAULT_KEY_PREFIX
): string {
  return `${keyPrefix}recent:${slot}`;
}

/**
 * The keys of the recent list, newest first, given the counter's current value
 * (`await client.get(counterKey())`). Read each key, skip the ones that came
 * back empty, then read the entry each id points at with `entryKey`.
 *
 * ```ts
 * const counter = Number((await client.get(counterKey())).value);
 * for (const key of recentSlotKeys(counter, { ringSize: 100 })) {
 *   const id = (await client.get(key)).value?.toString();
 *   // ...
 * }
 * ```
 */
export function recentSlotKeys(
  counter: number,
  options: MemcachedKeyOptions = {}
): string[] {
  const keyPrefix: string = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
  const ringSize: number = options.ringSize ?? DEFAULT_RING_SIZE;
  assertKeyPrefix(keyPrefix, 'recentSlotKeys');
  assertRingSize(ringSize, 'recentSlotKeys');
  if (!Number.isInteger(counter) || counter < 0) {
    throw new RangeError(
      `recentSlotKeys: counter must be a whole number, 0 or more, received ${String(counter)}.`
    );
  }
  const written: number = Math.min(counter + 1, ringSize);
  const keys: string[] = [];
  for (let back = 0; back < written; back += 1) {
    keys.push(slotKey((counter - back) % ringSize, keyPrefix));
  }
  return keys;
}

/**
 * Keeps recent errors in Memcached. Memcached is a cache: it has no queries,
 * no durability, and it may drop any key early when it runs out of memory, so
 * use this for a short, cheap look at what went wrong lately, and put a durable
 * adapter beside it (`CompositeErrorAdapter`) for anything that must survive.
 *
 * Each entry is stored with `add` under `<keyPrefix><id>` as JSON, expiring
 * after `ttlSeconds`. Because the key is the entry id, logging the same entry
 * again changes nothing: `add` refuses a key that exists, which this adapter
 * treats as success, so a retry after a timeout never stores an entry twice.
 *
 * A fixed-size recent list (`ringSize`, default 100) makes the newest entries
 * easy to find, since Memcached cannot list keys: a counter (`<keyPrefix>count`)
 * numbers each new entry, and slot `<keyPrefix>recent:<n % ringSize>` holds its
 * id, overwriting the oldest. Read it with `recentSlotKeys`.
 *
 * `log` needs a reachable server; an unreachable one comes back as `ok: false`.
 */
export class MemcachedErrorAdapter<
  TCode extends string = string,
> implements ErrorLogAdapter<TCode> {
  private readonly keyPrefix: string;
  private readonly ringSize: number;
  private readonly ttlSeconds: number;
  private readonly maxValueBytes: number;
  private readonly logPrefix: string;
  private readonly timeoutMs: number;

  /** @throws {RangeError} if `keyPrefix`, `ringSize`, `ttlSeconds` or `maxValueBytes` is out of range, or `timeoutMs` is invalid. */
  constructor(
    private readonly client: MemcachedClientLike,
    options: MemcachedErrorOptions = {}
  ) {
    const owner = 'MemcachedErrorAdapter';
    this.keyPrefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
    this.ringSize = options.ringSize ?? DEFAULT_RING_SIZE;
    this.ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    this.maxValueBytes = options.maxValueBytes ?? DEFAULT_MAX_VALUE_BYTES;
    this.logPrefix = options.prefix ?? DEFAULT_PREFIX;
    assertKeyPrefix(this.keyPrefix, owner);
    assertRingSize(this.ringSize, owner);
    if (
      !Number.isInteger(this.ttlSeconds) ||
      this.ttlSeconds < 1 ||
      this.ttlSeconds > MAX_TTL_SECONDS
    ) {
      throw new RangeError(
        `${owner}: ttlSeconds must be a whole number from 1 to ${MAX_TTL_SECONDS} (30 days; Memcached reads a larger expiry as a Unix time), received ${String(this.ttlSeconds)}.`
      );
    }
    if (!Number.isInteger(this.maxValueBytes) || this.maxValueBytes < 1) {
      throw new RangeError(
        `${owner}: maxValueBytes must be a whole number, at least 1, received ${String(this.maxValueBytes)}.`
      );
    }
    this.timeoutMs = resolveTimeoutMs(options.timeoutMs, owner);
  }

  async log(entry: ErrorLogEntry<TCode>): Promise<ErrorLogResult> {
    try {
      await this.store(this.prepare(entry));
      return { ok: true };
    } catch (error: unknown) {
      return reportFailure({
        adapterName: 'MemcachedErrorAdapter',
        prefix: this.logPrefix,
        action: 'to store an entry',
        error,
      });
    }
  }

  /**
   * Stores several entries in order. Every entry is checked first, so one that
   * cannot be stored (an invalid `id`, a value that is too large) fails the
   * whole call and nothing is written. After that the call stops at the first
   * failure and the error says how many entries were already stored. Trying the
   * whole batch again is safe: entries that exist are left as they are.
   */
  async logBatch(entries: ErrorLogEntry<TCode>[]): Promise<ErrorLogResult> {
    if (entries.length === 0) {
      return { ok: true };
    }
    const count: number = entries.length;
    const prepared: PreparedEntry[] = [];
    for (const [index, entry] of entries.entries()) {
      try {
        prepared.push(this.prepare(entry));
      } catch (error: unknown) {
        return this.failBatch(
          count,
          error,
          `entry ${index} could not be prepared, so nothing was stored`
        );
      }
    }
    let stored = 0;
    for (const item of prepared) {
      try {
        await this.store(item);
        stored += 1;
      } catch (error: unknown) {
        return this.failBatch(
          count,
          error,
          `${stored} of ${count} entries were stored before this`
        );
      }
    }
    return { ok: true };
  }

  private failBatch(
    count: number,
    error: unknown,
    detail: string
  ): ErrorLogResult {
    return reportFailure({
      adapterName: 'MemcachedErrorAdapter',
      prefix: this.logPrefix,
      action: `to store ${count} entr${count === 1 ? 'y' : 'ies'}`,
      error: new Error(`${describeError(error)} (${detail})`),
    });
  }

  private prepare(entry: ErrorLogEntry<TCode>): PreparedEntry {
    const serialized = serializeEntry(entry);
    const occurredAt: Date = new Date(serialized.timestamp);
    if (Number.isNaN(occurredAt.getTime())) {
      throw new RangeError(
        `timestamp "${serialized.timestamp}" is not a valid ISO 8601 date`
      );
    }
    const id: string = resolveEntryId(entry);
    const key: string = entryKey(id, this.keyPrefix);
    if (key.length > MAX_KEY_LENGTH || !/^[\x21-\x7e]+$/.test(key)) {
      throw new RangeError(
        `the key "${key}" is not a valid Memcached key: it must be at most ${MAX_KEY_LENGTH} printable ASCII characters with no spaces (check keyPrefix and the entry id)`
      );
    }
    const stored: MemcachedStoredEntry = {
      id,
      code: serialized.code,
      message: serialized.message,
      occurred_at: occurredAt.toISOString(),
      created_at: new Date().toISOString(),
    };
    if (serialized.cause !== undefined) {
      stored.cause = serialized.cause;
    }
    if (serialized.source !== undefined) {
      stored.source = serialized.source;
    }
    const value: string = JSON.stringify(stored);
    const bytes: number = new TextEncoder().encode(value).length;
    if (bytes > this.maxValueBytes) {
      throw new RangeError(
        `the entry is ${bytes} bytes as JSON, which is more than maxValueBytes (${this.maxValueBytes}); Memcached refuses items over its item size limit, 1 MiB by default`
      );
    }
    return { id, key, value };
  }

  /** `add` the entry; if it is new, number it and point a recent-list slot at it. */
  private async store(item: PreparedEntry): Promise<void> {
    const added: boolean = await this.request((): Promise<boolean> =>
      this.client.add(item.key, item.value, { expires: this.ttlSeconds })
    );
    if (!added || this.ringSize === 0) {
      // The key exists: this entry was stored before, so it is already listed.
      return;
    }
    try {
      const counter = await this.request(() =>
        this.client.increment(counterKey(this.keyPrefix), 1, {
          initial: 0,
          expires: 0,
        })
      );
      const count: number | null | undefined = counter.value;
      if (!counter.success || typeof count !== 'number') {
        throw new Error(
          'Memcached did not return the counter value, so the entry cannot be put in the recent list'
        );
      }
      await this.request((): Promise<boolean> =>
        this.client.set(
          slotKey(count % this.ringSize, this.keyPrefix),
          item.id,
          { expires: this.ttlSeconds }
        )
      );
    } catch (error: unknown) {
      // Take the entry back so a retry stores it and lists it again.
      await this.request((): Promise<boolean> =>
        this.client.delete(item.key)
      ).catch((): undefined => undefined);
      throw error;
    }
  }

  private request<T>(call: () => Promise<T>): Promise<T> {
    return withTimeout(
      call,
      this.timeoutMs,
      timeoutMessage('Memcached', this.timeoutMs)
    );
  }
}
