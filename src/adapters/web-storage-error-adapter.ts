import { resolveEntryId } from '../entry-id.js';
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
 */
export class WebStorageErrorAdapter<
  TCode extends string = string,
> implements ErrorLogAdapter<TCode> {
  private readonly key: string;
  private readonly maxEntries: number;
  private readonly prefix: string;

  /** @throws {RangeError} if `options.maxEntries` is not a positive integer. */
  constructor(
    private readonly storage: StorageLike,
    options: WebStorageErrorOptions = {}
  ) {
    this.key = options.key ?? DEFAULT_STORAGE_KEY;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.prefix = options.prefix ?? '[error-log-adapter]';
    if (!Number.isInteger(this.maxEntries) || this.maxEntries < 1) {
      throw new RangeError(
        `WebStorageErrorAdapter: maxEntries must be a positive integer, received ${String(options.maxEntries)}.`
      );
    }
  }

  async log(entry: ErrorLogEntry<TCode>): Promise<ErrorLogResult> {
    try {
      const record: WebStorageErrorRecord = {
        id: resolveEntryId(entry),
        ...serializeEntry(entry),
      };
      this.append(record);
      return { ok: true };
    } catch (error: unknown) {
      console.error(`${this.prefix} WebStorageErrorAdapter:`, error);
      return {
        ok: false,
        error: `WebStorageErrorAdapter failed to write to storage key "${this.key}": ${describeError(error)}`,
      };
    }
  }

  /** Reads, appends, trims, and writes back. Runs without awaiting, so calls never interleave. */
  private append(record: WebStorageErrorRecord): void {
    // An entry logged again with the same id replaces its earlier record.
    const records: WebStorageErrorRecord[] = [
      ...this.readRecords().filter(
        (existing: WebStorageErrorRecord): boolean => existing?.id !== record.id
      ),
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
      console.error(
        `${this.prefix} WebStorageErrorAdapter: storage key "${this.key}" did not hold an array, so it was replaced.`
      );
    } catch (error: unknown) {
      console.error(
        `${this.prefix} WebStorageErrorAdapter: storage key "${this.key}" held invalid JSON (${describeError(error)}), so it was replaced.`
      );
    }
    return [];
  }
}
