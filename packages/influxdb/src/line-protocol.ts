import type { SerializedErrorLogEntry } from '@richardmcquiston01/error-log-adapter';

/** Timestamp precision of a write. Must match the precision the client writes with. */
export type InfluxPrecision = 'ns' | 'us' | 'ms' | 's';

/** Default measurement name. */
export const DEFAULT_MEASUREMENT = 'error_log';

/**
 * Escaping. Servers disagree about what a backslash means in a measurement or
 * tag (a parser may treat it as swallowing the next character, including the
 * `,` or space that ends the name), so backslashes are replaced with `/` there
 * and line breaks with a space; the other special characters are escaped with a
 * backslash. String field values escape only `\` and `"`, which is
 * unambiguous and matches `escape.quoted` of the official
 * `@influxdata/influxdb3-client` (a test compares them).
 */

/** Makes a measurement name safe: no backslashes or line breaks, commas and spaces escaped. */
function escapeMeasurement(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/\r\n|[\r\n]/g, ' ')
    .replace(/[, ]/g, '\\$&');
}

/** Makes a tag key or value safe: no backslashes or line breaks, commas, equals signs and spaces escaped. */
function escapeTag(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/\r\n|[\r\n]/g, ' ')
    .replace(/[,= ]/g, '\\$&');
}

/** Escapes a string field value: backslashes and double quotes. */
function escapeFieldString(value: string): string {
  return value.replace(/[\\"]/g, '\\$&');
}

/**
 * The point timestamp for an entry, in `precision` units.
 *
 * InfluxDB treats points with the same measurement, tags and timestamp as one
 * point and keeps only the last, so two errors with the same `code` and
 * `source` in the same millisecond would overwrite each other. To prevent that
 * the sub-millisecond part of the timestamp (microseconds and nanoseconds, when
 * `precision` is `us` or `ns`) comes from the entry's `id`. The same entry
 * always gets the same timestamp, so writing it twice overwrites instead of
 * duplicating. With `ms` or `s` there is no room for this and entries with the
 * same tags and time collide.
 *
 * @throws {RangeError} if the entry's timestamp is not a valid date.
 */
export function pointTimestamp(
  entryTimestamp: string,
  id: string,
  precision: InfluxPrecision
): string {
  const millis: number = new Date(entryTimestamp).getTime();
  if (Number.isNaN(millis)) {
    throw new RangeError(
      `timestamp "${entryTimestamp}" is not a valid ISO 8601 date`
    );
  }
  if (precision === 's') {
    return Math.floor(millis / 1000).toString();
  }
  const unitsPerMilli: bigint =
    precision === 'ns' ? 1_000_000n : precision === 'us' ? 1_000n : 1n;
  const offset: bigint =
    unitsPerMilli === 1n
      ? 0n
      : BigInt(`0x${id.replace(/-/g, '').slice(0, 12)}`) % unitsPerMilli;
  return (BigInt(millis) * unitsPerMilli + offset).toString();
}

/**
 * Builds one line of InfluxDB line protocol for an entry:
 *
 * ```
 * error_log,code=DB_DOWN,source=checkout id="<uuid>",message="...",cause="<json>" <timestamp>
 * ```
 *
 * `code` and `source` are tags (there are few distinct values, and tags are
 * indexed); `id`, `message` and `cause` are fields. A tag with no value is left out.
 */
export function buildErrorLogLine(
  record: SerializedErrorLogEntry,
  id: string,
  measurement: string,
  precision: InfluxPrecision
): string {
  const tags: string[] = [];
  if (record.code !== '') {
    tags.push(`code=${escapeTag(record.code)}`);
  }
  if (record.source !== undefined && record.source !== '') {
    tags.push(`source=${escapeTag(record.source)}`);
  }
  const fields: string[] = [
    `id="${escapeFieldString(id)}"`,
    `message="${escapeFieldString(record.message)}"`,
  ];
  if (record.cause !== undefined) {
    fields.push(`cause="${escapeFieldString(JSON.stringify(record.cause))}"`);
  }
  const series: string = [escapeMeasurement(measurement), ...tags].join(',');
  return `${series} ${fields.join(',')} ${pointTimestamp(record.timestamp, id, precision)}`;
}

/** @throws {RangeError} unless the measurement is a non-empty, single-line name. */
export function assertMeasurement(measurement: string, owner: string): void {
  if (measurement === '' || /[\r\n]/.test(measurement)) {
    throw new RangeError(
      `${owner}: measurement must be a non-empty name without line breaks, received ${JSON.stringify(measurement)}.`
    );
  }
}

const PRECISIONS: readonly string[] = ['ns', 'us', 'ms', 's'];

/** @throws {RangeError} unless `precision` is `ns`, `us`, `ms` or `s`. */
export function assertPrecision(precision: string, owner: string): void {
  if (!PRECISIONS.includes(precision)) {
    throw new RangeError(
      `${owner}: precision must be one of ns, us, ms or s, received ${JSON.stringify(precision)}.`
    );
  }
}
