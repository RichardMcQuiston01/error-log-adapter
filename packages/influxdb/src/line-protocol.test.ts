import { escape } from '@influxdata/influxdb3-client';
import { describe, expect, it } from 'vitest';
import {
  assertMeasurement,
  assertPrecision,
  buildErrorLogLine,
  pointTimestamp,
} from './line-protocol.js';

const id = '3f2b8c1e-5a7d-4e21-9c0a-1b2c3d4e5f60';
const timestamp = '2026-10-19T05:00:00.123Z';
const millis: bigint = BigInt(Date.parse(timestamp));

describe('pointTimestamp', () => {
  it('uses the entry time in the requested precision', () => {
    expect(pointTimestamp(timestamp, id, 's')).toBe('1792386000');
    expect(pointTimestamp(timestamp, id, 'ms')).toBe(millis.toString());
  });

  it('adds a sub-millisecond offset taken from the id for ns and us', () => {
    const ns = BigInt(pointTimestamp(timestamp, id, 'ns'));
    const us = BigInt(pointTimestamp(timestamp, id, 'us'));
    expect(ns / 1_000_000n).toBe(millis);
    expect(us / 1_000n).toBe(millis);
    expect(ns % 1_000_000n).toBeGreaterThan(0n);
    expect(us % 1_000n).toBeGreaterThan(0n);
  });

  it('is the same for the same id and different for another id', () => {
    const other = 'aaaaaaaa-5a7d-4e21-9c0a-1b2c3d4e5f60';
    expect(pointTimestamp(timestamp, id, 'ns')).toBe(
      pointTimestamp(timestamp, id, 'ns')
    );
    expect(pointTimestamp(timestamp, other, 'ns')).not.toBe(
      pointTimestamp(timestamp, id, 'ns')
    );
  });

  it('rejects a timestamp that is not a date', () => {
    expect(() => pointTimestamp('yesterday', id, 'ns')).toThrow(
      'is not a valid ISO 8601 date'
    );
  });
});

describe('buildErrorLogLine', () => {
  it('writes tags, fields and the timestamp', () => {
    const line = buildErrorLogLine(
      {
        code: 'DB_DOWN',
        message: 'cannot reach the database',
        source: 'checkout',
        cause: { message: 'ECONNREFUSED' },
        timestamp,
      },
      id,
      'error_log',
      'ms'
    );
    expect(line).toBe(
      `error_log,code=DB_DOWN,source=checkout id="${id}",message="cannot reach the database",cause="{\\"message\\":\\"ECONNREFUSED\\"}" ${millis}`
    );
  });

  it('leaves out a missing source, an empty code and a missing cause', () => {
    const line = buildErrorLogLine(
      { code: '', message: 'm', timestamp },
      id,
      'error_log',
      'ms'
    );
    expect(line).toBe(`error_log id="${id}",message="m" ${millis}`);
  });

  it('escapes tags and measurements the way the official client does when there is no backslash or line break', () => {
    for (const value of ['plain', 'a "b" c', 'x, y=z w']) {
      const line = buildErrorLogLine(
        { code: value, message: value, source: value, timestamp },
        id,
        value,
        'ms'
      );
      const tag = escape.tag(value);
      expect(line).toBe(
        `${escape.measurement(value)},code=${tag},source=${tag} id="${id}",message=${escape.quoted(value)} ${millis}`
      );
    }
  });

  it('escapes string fields exactly as the official client does', () => {
    for (const value of ['a "b" \\ c', 'trailing\\', 'two\nlines', '\\"']) {
      const line = buildErrorLogLine(
        { code: 'c', message: value, timestamp },
        id,
        'error_log',
        'ms'
      );
      expect(line).toBe(
        `error_log,code=c id="${id}",message=${escape.quoted(value)} ${millis}`
      );
    }
  });

  it('never lets a backslash or line break in a tag or measurement reach the line', () => {
    const line = buildErrorLogLine(
      { code: 'C:\\app\\x', message: 'm', source: 'a\nb', timestamp },
      id,
      'my\\log',
      'ms'
    );
    expect(line).toBe(
      `my/log,code=C:/app/x,source=a\\ b id="${id}",message="m" ${millis}`
    );
  });
});
describe('option checks', () => {
  it('rejects an empty or multi-line measurement', () => {
    expect(() => assertMeasurement('', 'X')).toThrow(RangeError);
    expect(() => assertMeasurement('a\nb', 'X')).toThrow(RangeError);
    expect(() => assertMeasurement('error_log', 'X')).not.toThrow();
  });

  it('rejects an unknown precision', () => {
    expect(() => assertPrecision('minutes', 'X')).toThrow(RangeError);
    expect(() => assertPrecision('ms', 'X')).not.toThrow();
  });
});
