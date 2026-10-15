import { describeError, serializeEntry } from '../serialize.js';
import type {
  ErrorLogAdapter,
  ErrorLogEntry,
  ErrorLogResult,
} from '../types.js';

/** Default Redis key. */
export const DEFAULT_REDIS_KEY = 'error_log';

/**
 * The only thing this adapter needs from a Redis client: send one raw command
 * as an array of strings. node-redis (`client.sendCommand`) already matches.
 * ioredis needs a one-line wrapper:
 *
 * ```ts
 * const client: RedisClientLike = {
 *   sendCommand: (args) => redis.call(args[0] as string, ...args.slice(1)),
 * };
 * ```
 */
export interface RedisClientLike {
  sendCommand(args: string[]): Promise<unknown>;
}

export interface RedisErrorOptions {
  /**
   * `list` (default) pushes each entry onto a Redis list as one JSON string.
   * `stream` appends each entry to a Redis stream (`XADD`) as separate fields.
   */
  mode?: 'list' | 'stream';
  /** Key to write to. Defaults to `error_log`. */
  key?: string;
  /**
   * Most entries to keep. The oldest are dropped first. Unlimited by default.
   * Lists are trimmed with `LTRIM` after the push; streams use an exact `MAXLEN`.
   */
  maxEntries?: number;
  /**
   * List mode only: which end to push onto. `right` (default, `RPUSH`) keeps
   * the newest entry last; `left` (`LPUSH`) keeps the newest entry first.
   */
  side?: 'left' | 'right';
  /** Text printed before failure messages. Defaults to `[error-log-adapter]`. */
  prefix?: string;
}

/**
 * Writes entries to Redis, either as a capped list of JSON strings or as a
 * stream. Each record holds a UUID `id` plus the serialized entry. In stream
 * mode `cause` and `source` fields are left out when the entry has none.
 */
export class RedisErrorAdapter<
  TCode extends string = string,
> implements ErrorLogAdapter<TCode> {
  private readonly mode: 'list' | 'stream';
  private readonly key: string;
  private readonly maxEntries: number | undefined;
  private readonly side: 'left' | 'right';
  private readonly prefix: string;

  /** @throws {RangeError} if `key` is empty, `maxEntries` is not a positive integer, or `mode` / `side` is unknown. */
  constructor(
    private readonly client: RedisClientLike,
    options: RedisErrorOptions = {}
  ) {
    this.mode = options.mode ?? 'list';
    this.key = options.key ?? DEFAULT_REDIS_KEY;
    this.maxEntries = options.maxEntries;
    this.side = options.side ?? 'right';
    this.prefix = options.prefix ?? '[error-log-adapter]';
    if (this.mode !== 'list' && this.mode !== 'stream') {
      throw new RangeError(
        `RedisErrorAdapter: mode must be "list" or "stream", received "${String(options.mode)}".`
      );
    }
    if (this.side !== 'left' && this.side !== 'right') {
      throw new RangeError(
        `RedisErrorAdapter: side must be "left" or "right", received "${String(options.side)}".`
      );
    }
    if (this.key === '') {
      throw new RangeError('RedisErrorAdapter: key must not be empty.');
    }
    if (
      this.maxEntries !== undefined &&
      (!Number.isInteger(this.maxEntries) || this.maxEntries < 1)
    ) {
      throw new RangeError(
        `RedisErrorAdapter: maxEntries must be a positive integer, received ${String(this.maxEntries)}.`
      );
    }
  }

  async log(entry: ErrorLogEntry<TCode>): Promise<ErrorLogResult> {
    try {
      const record = { id: crypto.randomUUID(), ...serializeEntry(entry) };
      if (this.mode === 'stream') {
        await this.client.sendCommand(this.buildStreamCommand(record));
      } else {
        await this.client.sendCommand([
          this.side === 'left' ? 'LPUSH' : 'RPUSH',
          this.key,
          JSON.stringify(record),
        ]);
        await this.trimList();
      }
      return { ok: true };
    } catch (error: unknown) {
      console.error(`${this.prefix} RedisErrorAdapter:`, error);
      return {
        ok: false,
        error: `RedisErrorAdapter failed to write to ${this.mode} "${this.key}": ${describeError(error)}`,
      };
    }
  }

  private buildStreamCommand(record: {
    id: string;
    code: string;
    message: string;
    cause?: unknown;
    source?: string;
    timestamp: string;
  }): string[] {
    const command: string[] = ['XADD', this.key];
    if (this.maxEntries !== undefined) {
      command.push('MAXLEN', '=', String(this.maxEntries));
    }
    command.push(
      '*',
      'id',
      record.id,
      'code',
      record.code,
      'message',
      record.message,
      'timestamp',
      record.timestamp
    );
    if (record.cause !== undefined) {
      command.push('cause', JSON.stringify(record.cause));
    }
    if (record.source !== undefined) {
      command.push('source', record.source);
    }
    return command;
  }

  /**
   * Drops the oldest list entries beyond `maxEntries`. The entry is already
   * stored by now, so a trim failure is reported but does not fail the call;
   * the next successful write trims the list again.
   */
  private async trimList(): Promise<void> {
    if (this.maxEntries === undefined) {
      return;
    }
    const keep: number = this.maxEntries;
    const [start, stop]: [string, string] =
      this.side === 'right' ? [String(-keep), '-1'] : ['0', String(keep - 1)];
    try {
      await this.client.sendCommand(['LTRIM', this.key, start, stop]);
    } catch (error: unknown) {
      console.error(
        `${this.prefix} RedisErrorAdapter: stored the entry but could not trim list "${this.key}" to ${keep} entries: ${describeError(error)}`
      );
    }
  }
}
