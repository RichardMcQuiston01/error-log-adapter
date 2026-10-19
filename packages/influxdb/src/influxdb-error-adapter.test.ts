import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BatchingErrorAdapter } from '@richardmcquiston01/error-log-adapter';
import type { ErrorLogEntry } from '@richardmcquiston01/error-log-adapter';
import {
  InfluxDb3ErrorAdapter,
  InfluxDbErrorAdapter,
} from './influxdb-error-adapter.js';
import type {
  InfluxDb3ClientLike,
  InfluxDb3WriteOptionsLike,
  InfluxWriteApiLike,
} from './influxdb-error-adapter.js';

const entry: ErrorLogEntry = {
  code: 'DB_DOWN',
  message: 'cannot reach the database',
  source: 'checkout',
  timestamp: '2026-10-19T05:00:00.123Z',
  id: '3f2b8c1e-5a7d-4e21-9c0a-1b2c3d4e5f60',
};

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

function fakeWriteApi(flush: () => Promise<void> = async () => undefined): {
  writeApi: InfluxWriteApiLike;
  written: string[][];
  flushes: () => number;
} {
  const written: string[][] = [];
  let flushCount = 0;
  return {
    writeApi: {
      writeRecords(records): void {
        written.push(records);
      },
      async flush(): Promise<void> {
        flushCount += 1;
        await flush();
      },
    },
    written,
    flushes: () => flushCount,
  };
}

interface V3Call {
  lines: string[];
  database: string | undefined;
  options: InfluxDb3WriteOptionsLike | undefined;
}

function fakeV3Client(write?: () => Promise<void>): {
  client: InfluxDb3ClientLike;
  calls: V3Call[];
} {
  const calls: V3Call[] = [];
  return {
    calls,
    client: {
      async write(lines, database, _org, options): Promise<void> {
        calls.push({ lines, database, options });
        await write?.();
      },
    },
  };
}

describe('InfluxDbErrorAdapter (InfluxDB 2.x write API)', () => {
  it('writes the point and waits for the flush', async () => {
    const { writeApi, written, flushes } = fakeWriteApi();
    const result = await new InfluxDbErrorAdapter(writeApi).log(entry);
    expect(result).toEqual({ ok: true });
    expect(written).toHaveLength(1);
    expect(written[0]).toHaveLength(1);
    expect(written[0]?.[0]).toMatch(
      /^error_log,code=DB_DOWN,source=checkout id="3f2b8c1e-[^"]+",message="cannot reach the database" \d{19}$/
    );
    expect(flushes()).toBe(1);
  });

  it('reports a rejected flush', async () => {
    const { writeApi } = fakeWriteApi(() =>
      Promise.reject(new Error('401 unauthorized access'))
    );
    const result = await new InfluxDbErrorAdapter(writeApi).log(entry);
    expect(result).toEqual({
      ok: false,
      error:
        'InfluxDbErrorAdapter failed to write to measurement "error_log": 401 unauthorized access',
    });
  });

  it('times out a flush that never completes', async () => {
    const { writeApi } = fakeWriteApi(() => new Promise<void>(() => undefined));
    const result = await new InfluxDbErrorAdapter(writeApi, {
      timeoutMs: 20,
    }).log(entry);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('InfluxDB did not respond within 20 ms');
  });

  it('honors measurement and precision', async () => {
    const { writeApi, written } = fakeWriteApi();
    await new InfluxDbErrorAdapter(writeApi, {
      measurement: 'app errors',
      precision: 'ms',
    }).log(entry);
    expect(written[0]?.[0]).toMatch(/^app\\ errors,code=/);
    expect(written[0]?.[0]).toMatch(/ 1792386000123$/);
  });

  it('rejects an invalid id or timestamp without writing', async () => {
    const { writeApi, written } = fakeWriteApi();
    const adapter = new InfluxDbErrorAdapter(writeApi);
    expect((await adapter.log({ ...entry, id: 'nope' })).error).toContain(
      'entry.id must be a UUID'
    );
    expect(
      (await adapter.log({ ...entry, timestamp: 'yesterday' })).error
    ).toContain('is not a valid ISO 8601 date');
    expect(written).toHaveLength(0);
  });

  it('rejects options that can never work', () => {
    const { writeApi } = fakeWriteApi();
    expect(
      () => new InfluxDbErrorAdapter(writeApi, { measurement: '' })
    ).toThrow(RangeError);
    expect(
      () =>
        new InfluxDbErrorAdapter(writeApi, {
          precision: 'minutes' as unknown as 'ns',
        })
    ).toThrow(RangeError);
    expect(() => new InfluxDbErrorAdapter(writeApi, { timeoutMs: 0 })).toThrow(
      RangeError
    );
  });

  describe('logBatch', () => {
    it('writes every entry in one call and flushes once', async () => {
      const { writeApi, written, flushes } = fakeWriteApi();
      const result = await new InfluxDbErrorAdapter(writeApi).logBatch([
        { code: 'A', message: '1' },
        { code: 'B', message: '2' },
      ]);
      expect(result).toEqual({ ok: true });
      expect(written).toHaveLength(1);
      expect(written[0]).toHaveLength(2);
      expect(flushes()).toBe(1);
    });

    it('does nothing for an empty batch', async () => {
      const { writeApi, written } = fakeWriteApi();
      expect(await new InfluxDbErrorAdapter(writeApi).logBatch([])).toEqual({
        ok: true,
      });
      expect(written).toHaveLength(0);
    });

    it('writes nothing when one entry is invalid', async () => {
      const { writeApi, written } = fakeWriteApi();
      const result = await new InfluxDbErrorAdapter(writeApi).logBatch([
        { code: 'A', message: '1' },
        { code: 'B', message: '2', id: 'nope' },
      ]);
      expect(result.ok).toBe(false);
      expect(result.error).toContain(
        'entry 1 could not be prepared, so nothing was written'
      );
      expect(written).toHaveLength(0);
    });

    it('is used by BatchingErrorAdapter', async () => {
      const { writeApi, written } = fakeWriteApi();
      const batching = new BatchingErrorAdapter(
        new InfluxDbErrorAdapter(writeApi),
        { batchSize: 2, maxWaitMs: Infinity }
      );
      await batching.log({ code: 'A', message: '1' });
      await batching.log({ code: 'B', message: '2' });
      await batching.flush();
      expect(written).toHaveLength(1);
      expect(written[0]).toHaveLength(2);
    });
  });
});

describe('InfluxDb3ErrorAdapter (InfluxDB 3.x client)', () => {
  it('writes the point with the precision and database', async () => {
    const { client, calls } = fakeV3Client();
    const result = await new InfluxDb3ErrorAdapter(client, {
      database: 'logs',
      precision: 'us',
    }).log(entry);
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.database).toBe('logs');
    expect(calls[0]?.options).toEqual({ precision: 'us' });
    expect(calls[0]?.lines[0]).toMatch(/ \d{16}$/);
  });

  it('defaults to nanoseconds and the client database', async () => {
    const { client, calls } = fakeV3Client();
    await new InfluxDb3ErrorAdapter(client).log(entry);
    expect(calls[0]?.database).toBeUndefined();
    expect(calls[0]?.options).toEqual({ precision: 'ns' });
    expect(calls[0]?.lines[0]).toMatch(/ \d{19}$/);
  });

  it('reports a rejected write', async () => {
    const { client } = fakeV3Client(() =>
      Promise.reject(new Error('503 Service Unavailable : down'))
    );
    const result = await new InfluxDb3ErrorAdapter(client).log(entry);
    expect(result).toEqual({
      ok: false,
      error:
        'InfluxDb3ErrorAdapter failed to write to measurement "error_log": 503 Service Unavailable : down',
    });
  });

  it('writes a batch in one call', async () => {
    const { client, calls } = fakeV3Client();
    const result = await new InfluxDb3ErrorAdapter(client).logBatch([
      { code: 'A', message: '1' },
      { code: 'B', message: '2' },
    ]);
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.lines).toHaveLength(2);
  });
});
