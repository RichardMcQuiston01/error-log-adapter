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
import {
  DEFAULT_MEASUREMENT,
  assertMeasurement,
  assertPrecision,
  buildErrorLogLine,
} from './line-protocol.js';
import type { InfluxPrecision } from './line-protocol.js';

/**
 * What the InfluxDB 2.x adapter needs from a write API: `writeRecords` and
 * `flush`. The `WriteApi` from `@influxdata/influxdb-client`
 * (`new InfluxDB({ url, token }).getWriteApi(org, bucket, precision)`) fits as it is.
 */
export interface InfluxWriteApiLike {
  writeRecords(records: string[]): void;
  flush(): Promise<void>;
}

/** The write options this adapter passes to an InfluxDB 3 client. */
export interface InfluxDb3WriteOptionsLike {
  precision?: InfluxPrecision;
}

/**
 * What the InfluxDB 3.x adapter needs from a client: `write`. The
 * `InfluxDBClient` from `@influxdata/influxdb3-client` fits as it is.
 */
export interface InfluxDb3ClientLike {
  write(
    lines: string[],
    database?: string,
    org?: string,
    writeOptions?: InfluxDb3WriteOptionsLike
  ): Promise<void>;
}

interface InfluxBaseOptions {
  /** Measurement to write to. Defaults to `error_log`. */
  measurement?: string;
  /** Text printed before failure messages. Defaults to `[error-log-adapter]`. */
  prefix?: string;
  /**
   * How long `log` waits for InfluxDB, in milliseconds. Defaults to 10000. Pass
   * `Infinity` to wait without limit. The write cannot be cancelled, so it may
   * still finish after `log` has returned a failure.
   */
  timeoutMs?: number;
}

export interface InfluxDbErrorOptions extends InfluxBaseOptions {
  /**
   * Timestamp precision of the points. **Must match the precision the write API
   * was created with** (`getWriteApi(org, bucket, precision)`, which defaults
   * to `ns`), or every point is dated wrongly. Defaults to `ns`.
   */
  precision?: InfluxPrecision;
}

export interface InfluxDb3ErrorOptions extends InfluxBaseOptions {
  /** Timestamp precision. It is sent with each write, so it always matches. Defaults to `ns`. */
  precision?: InfluxPrecision;
  /** Database to write to, when not the client's default. */
  database?: string;
}

abstract class InfluxLineAdapter<
  TCode extends string = string,
> implements ErrorLogAdapter<TCode> {
  protected readonly measurement: string;
  protected readonly precision: InfluxPrecision;
  private readonly logPrefix: string;
  private readonly timeoutMs: number;

  protected constructor(
    private readonly adapterName: string,
    private readonly target: string,
    options: InfluxBaseOptions & { precision?: InfluxPrecision }
  ) {
    this.measurement = options.measurement ?? DEFAULT_MEASUREMENT;
    this.precision = options.precision ?? 'ns';
    this.logPrefix = options.prefix ?? DEFAULT_PREFIX;
    this.timeoutMs = resolveTimeoutMs(options.timeoutMs, adapterName);
    assertMeasurement(this.measurement, adapterName);
    assertPrecision(this.precision, adapterName);
  }

  /** Hands the lines to the client and resolves when InfluxDB has accepted them. */
  protected abstract send(lines: string[]): Promise<unknown>;

  async log(entry: ErrorLogEntry<TCode>): Promise<ErrorLogResult> {
    try {
      await this.write([this.toLine(entry)]);
      return { ok: true };
    } catch (error: unknown) {
      return reportFailure({
        adapterName: this.adapterName,
        prefix: this.logPrefix,
        action: `to write to ${this.target}`,
        error,
      });
    }
  }

  /**
   * Writes several entries in one request, which `BatchingErrorAdapter` uses
   * when it wraps this adapter. Every entry is checked first, so one that
   * cannot be stored (an invalid `id` or `timestamp`) fails the whole call and
   * nothing is written.
   */
  async logBatch(entries: ErrorLogEntry<TCode>[]): Promise<ErrorLogResult> {
    if (entries.length === 0) {
      return { ok: true };
    }
    const count: number = entries.length;
    try {
      const lines: string[] = [];
      for (const [index, entry] of entries.entries()) {
        try {
          lines.push(this.toLine(entry));
        } catch (error: unknown) {
          throw new Error(
            `${describeError(error)} (entry ${index} could not be prepared, so nothing was written)`
          );
        }
      }
      await this.write(lines);
      return { ok: true };
    } catch (error: unknown) {
      return reportFailure({
        adapterName: this.adapterName,
        prefix: this.logPrefix,
        action: `to write ${count} entr${count === 1 ? 'y' : 'ies'} to ${this.target}`,
        error,
      });
    }
  }

  private toLine(entry: ErrorLogEntry<TCode>): string {
    return buildErrorLogLine(
      serializeEntry(entry),
      resolveEntryId(entry),
      this.measurement,
      this.precision
    );
  }

  private async write(lines: string[]): Promise<void> {
    await withTimeout(
      (): Promise<unknown> => this.send(lines),
      this.timeoutMs,
      timeoutMessage('InfluxDB', this.timeoutMs)
    );
  }
}

/**
 * Writes entries to InfluxDB 2.x (or Cloud) through a `WriteApi` from
 * `@influxdata/influxdb-client`. Each entry is one point:
 *
 * ```
 * error_log,code=DB_DOWN,source=checkout id="<uuid>",message="...",cause="<json>" <timestamp>
 * ```
 *
 * `code` and `source` are tags; `id`, `message` and `cause` (a JSON string) are
 * fields. After writing, the adapter calls `flush()` and waits for it, so `log`
 * reports a rejected write (bad token, missing bucket, server down).
 *
 * Create the write API with the same `precision` you give this adapter, and
 * with `maxRetries: 0` if you want a failed write reported once rather than
 * retried in the background. A retried write is harmless: the same entry always
 * produces the same point, so writing it again overwrites instead of duplicating.
 *
 * ```ts
 * const writeApi = new InfluxDB({ url, token }).getWriteApi(org, bucket, 'ns');
 * const adapter = new InfluxDbErrorAdapter(writeApi);
 * ```
 */
export class InfluxDbErrorAdapter<
  TCode extends string = string,
> extends InfluxLineAdapter<TCode> {
  /** @throws {RangeError} if `measurement` is empty, `precision` is not `ns`, `us`, `ms` or `s`, or `timeoutMs` is invalid. */
  constructor(
    private readonly writeApi: InfluxWriteApiLike,
    options: InfluxDbErrorOptions = {}
  ) {
    super(
      'InfluxDbErrorAdapter',
      `measurement "${options.measurement ?? DEFAULT_MEASUREMENT}"`,
      options
    );
  }

  protected async send(lines: string[]): Promise<void> {
    this.writeApi.writeRecords(lines);
    await this.writeApi.flush();
  }
}

/**
 * Writes entries to InfluxDB 3 (Core, Enterprise, Cloud) through an
 * `InfluxDBClient` from `@influxdata/influxdb3-client`. The points are the
 * same as in `InfluxDbErrorAdapter`. `write` resolves once the server accepts
 * the data, and rejects otherwise, so `log` reports failures directly. The
 * `precision` is sent with every write, so it always matches the points.
 *
 * ```ts
 * const client = new InfluxDBClient({ host, token, database: 'logs' });
 * const adapter = new InfluxDb3ErrorAdapter(client);
 * ```
 */
export class InfluxDb3ErrorAdapter<
  TCode extends string = string,
> extends InfluxLineAdapter<TCode> {
  private readonly database: string | undefined;

  /** @throws {RangeError} if `measurement` is empty, `precision` is not `ns`, `us`, `ms` or `s`, or `timeoutMs` is invalid. */
  constructor(
    private readonly client: InfluxDb3ClientLike,
    options: InfluxDb3ErrorOptions = {}
  ) {
    super(
      'InfluxDb3ErrorAdapter',
      `measurement "${options.measurement ?? DEFAULT_MEASUREMENT}"`,
      options
    );
    this.database = options.database;
  }

  protected send(lines: string[]): Promise<void> {
    return this.client.write(lines, this.database, undefined, {
      precision: this.precision,
    });
  }
}
