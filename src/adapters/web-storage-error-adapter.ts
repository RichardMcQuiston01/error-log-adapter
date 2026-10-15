import { generateId } from '../uuid.js';
import { describeError, serializeEntry } from '../serialize.js';
import type { SerializedErrorLogEntry } from '../serialize.js';
import type {
  ErrorLogAdapter,
  ErrorLogEntry,
  ErrorLogResult,
} from '../types.js';

/** Default storage key. */
export const DEFAULT_STORAGE_KEY = 'error_log';

/** Default number of entries kept before the oldest are dropped. */
export const DEFAULT_MAX_ENTRIES = 100;

/**
 * The subset of the Web Storage API this adapter uses. Both `sessionStorage`
 * and `localStorage` fit.
 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * The part of `navigator.locks` this adapter uses. `localStorage` is shared by
 * every tab of an origin and has no atomic update, so a lock keeps two tabs from
 * overwriting each other's entry.
 */
export interface LockManagerLike {
  request<T>(name: string, callback: () => T | Promise<T>): Promise<T>;
}

/** A stored record: the serialized entry plus its generated UUID. */
export interface WebStorageErrorRecord extends SerializedErrorLogEntry {
  id: string;
}

export interface WebStorageErrorOptions {
  /** Key the entries are stored under, as one JSON array. Defaults to `error_log`. */
  key?: string;
  /** Most entries to keep. The oldest are dropped first. Defaults to `100`. */
  maxEntries?: number;
  /** Text printed before failure messages. Defaults to `[error-log-adapter]`. */
  prefix?: string;
  /**
   * Lock manager that makes tabs sharing a `localStorage` take turns. Defaults to
   * `navigator.locks` when the browser has it. This reduces lost entries but does
   * not remove them: a tab in another process can still read a stale copy
   * (measured in Chromium). Pass `null` to turn locking off.
   */
  locks?: LockManagerLike | null;
}

/** Browsers report a full store with different names and codes. */
function isQuotaError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const { name, code } = error as { name?: unknown; code?: unknown };
  return (
    (typeof name === 'string' && name.toLowerCase().includes('quota')) ||
    code === 22 ||
    code === 1014
  );
}

/**
 * Keeps the newest entries in a Web Storage object (`sessionStorage` or
 * `localStorage`) as a JSON array under one key, capped at `maxEntries`.
 * When the store is full, the oldest entries are dropped until the new one fits.
 *
 * `sessionStorage` belongs to one tab, so it is safe. `localStorage` is shared by
 * every tab of the origin and has no atomic update: two tabs logging at the same
 * moment can overwrite each other's entry while both get `ok: true`. In Chromium,
 * tabs in separate processes (the usual case) even read a stale copy, so a lock
 * reduces the loss without removing it. Where tabs may log at the same time and
 * every entry matters, use `IndexedDbErrorAdapter`, whose writes are transactional.
 */
export class WebStorageErrorAdapter<
  TCode extends string = string,
> implements ErrorLogAdapter<TCode> {
  private readonly key: string;
  private readonly maxEntries: number;
  private readonly prefix: string;
  private readonly locks: LockManagerLike | null;

  /** @throws {RangeError} if `options.maxEntries` is not a positive integer. */
  constructor(
    private readonly storage: StorageLike,
    options: WebStorageErrorOptions = {}
  ) {
    this.key = options.key ?? DEFAULT_STORAGE_KEY;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.prefix = options.prefix ?? '[error-log-adapter]';
    this.locks =
      options.locks === undefined ? defaultLockManager() : options.locks;
    if (!Number.isInteger(this.maxEntries) || this.maxEntries < 1) {
      throw new RangeError(
        `WebStorageErrorAdapter: maxEntries must be a positive integer, received ${String(options.maxEntries)}.`
      );
    }
  }

  async log(entry: ErrorLogEntry<TCode>): Promise<ErrorLogResult> {
    try {
      const record: WebStorageErrorRecord = {
        id: generateId(),
        ...serializeEntry(entry),
      };
      await this.appendLocked(record);
      return { ok: true };
    } catch (error: unknown) {
      console.error(`${this.prefix} WebStorageErrorAdapter:`, error);
      return {
        ok: false,
        error: `WebStorageErrorAdapter failed to write to storage key "${this.key}": ${describeError(error)}`,
      };
    }
  }

  /**
   * Appends under a cross-tab lock when one is available. If the lock itself
   * cannot be taken (for example a sandboxed frame), the entry is still written
   * without it rather than lost.
   */
  private async appendLocked(record: WebStorageErrorRecord): Promise<void> {
    if (this.locks === null) {
      this.append(record);
      return;
    }
    let appended = false;
    try {
      await this.locks.request(`error-log-adapter:${this.key}`, (): void => {
        appended = true;
        this.append(record);
      });
    } catch (error: unknown) {
      if (appended) {
        throw error;
      }
      this.append(record);
    }
  }

  /** Reads, appends, trims, and writes back. Runs without awaiting, so calls in one tab never interleave. */
  private append(record: WebStorageErrorRecord): void {
    const records: WebStorageErrorRecord[] = [
      ...this.readRecords(),
      record,
    ].slice(-this.maxEntries);
    for (;;) {
      try {
        this.storage.setItem(this.key, JSON.stringify(records));
        return;
      } catch (error: unknown) {
        if (!isQuotaError(error) || records.length <= 1) {
          throw error;
        }
        records.shift();
      }
    }
  }

  /** Returns the stored records, or none if the value is missing or unreadable. */
  private readRecords(): WebStorageErrorRecord[] {
    const stored: string | null = this.storage.getItem(this.key);
    if (stored === null) {
      return [];
    }
    try {
      const parsed: unknown = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        return parsed as WebStorageErrorRecord[];
      }
      this.setAside(stored, 'did not hold an array');
    } catch (error: unknown) {
      this.setAside(stored, `held invalid JSON (${describeError(error)})`);
    }
    return [];
  }

  /**
   * Copies an unusable value to `<key>.corrupt` before it is replaced, so data
   * the host app stored under the same key is not silently destroyed. Only the
   * first one is kept; a later unusable value would not overwrite it.
   */
  private setAside(stored: string, reason: string): void {
    const backupKey = `${this.key}${CORRUPT_KEY_SUFFIX}`;
    let savedTo = 'but it could not be copied aside';
    try {
      if (this.storage.getItem(backupKey) === null) {
        this.storage.setItem(backupKey, stored);
        savedTo = `and a copy was kept under "${backupKey}"`;
      } else {
        savedTo = `and "${backupKey}" already holds an earlier copy`;
      }
    } catch {
      // The store may be full; the original value is replaced regardless.
    }
    console.error(
      `${this.prefix} WebStorageErrorAdapter: storage key "${this.key}" ${reason}, so it was replaced, ${savedTo}.`
    );
  }
}

/** Suffix of the key an unusable value is copied to before being replaced. */
export const CORRUPT_KEY_SUFFIX = '.corrupt';

function defaultLockManager(): LockManagerLike | null {
  const locks: unknown = (globalThis as { navigator?: { locks?: unknown } })
    .navigator?.locks;
  return typeof (locks as LockManagerLike | undefined)?.request === 'function'
    ? (locks as LockManagerLike)
    : null;
}
