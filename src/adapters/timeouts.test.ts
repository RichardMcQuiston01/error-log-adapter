import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ErrorLogAdapter,
  ErrorLogEntry,
  ErrorLogResult,
} from '../types.js';
import { CompositeErrorAdapter } from './composite-error-adapter.js';
import { MongoDbErrorAdapter } from './mongodb-error-adapter.js';
import {
  MySqlErrorAdapter,
  PostgresErrorAdapter,
} from './sql-error-adapter.js';
import { RedisErrorAdapter } from './redis-error-adapter.js';
import { S3ErrorAdapter } from './s3-error-adapter.js';
import { SnsErrorAdapter } from './sns-error-adapter.js';
import { SqliteErrorAdapter } from './sqlite-error-adapter.js';
import { SupabaseErrorAdapter } from './supabase-error-adapter.js';

const ENTRY: ErrorLogEntry = {
  code: 'E',
  message: 'm',
  timestamp: '2026-01-02T03:04:05.678Z',
};

const SNS_TOPIC = 'arn:aws:sns:us-east-1:123456789012:app-errors';

const neverSettles = (): Promise<never> => new Promise<never>(() => {});

interface Case {
  name: string;
  /** Builds the adapter around a client whose call never settles. */
  build: (timeoutMs?: number) => ErrorLogAdapter;
  /** Builds it with an invalid timeout, to check validation. */
  buildRaw: (timeoutMs: number) => unknown;
  sink: string;
}

const CASES: Case[] = [
  {
    name: 'MongoDbErrorAdapter',
    sink: 'MongoDB',
    build: (t) =>
      new MongoDbErrorAdapter({ insertOne: neverSettles }, { timeoutMs: t }),
    buildRaw: (t) =>
      new MongoDbErrorAdapter({ insertOne: neverSettles }, { timeoutMs: t }),
  },
  {
    name: 'PostgresErrorAdapter',
    sink: 'Postgres',
    build: (t) =>
      new PostgresErrorAdapter({ query: neverSettles }, { timeoutMs: t }),
    buildRaw: (t) =>
      new PostgresErrorAdapter({ query: neverSettles }, { timeoutMs: t }),
  },
  {
    name: 'MySqlErrorAdapter',
    sink: 'MySQL',
    build: (t) =>
      new MySqlErrorAdapter({ query: neverSettles }, { timeoutMs: t }),
    buildRaw: (t) =>
      new MySqlErrorAdapter({ query: neverSettles }, { timeoutMs: t }),
  },
  {
    name: 'SqliteErrorAdapter',
    sink: 'SQLite',
    build: (t) =>
      new SqliteErrorAdapter({ run: neverSettles }, { timeoutMs: t }),
    buildRaw: (t) =>
      new SqliteErrorAdapter({ run: neverSettles }, { timeoutMs: t }),
  },
  {
    name: 'RedisErrorAdapter',
    sink: 'Redis',
    build: (t) =>
      new RedisErrorAdapter({ sendCommand: neverSettles }, { timeoutMs: t }),
    buildRaw: (t) =>
      new RedisErrorAdapter({ sendCommand: neverSettles }, { timeoutMs: t }),
  },
  {
    name: 'S3ErrorAdapter',
    sink: 'S3',
    build: (t) =>
      new S3ErrorAdapter({ putObject: neverSettles }, 'bucket', {
        timeoutMs: t,
      }),
    buildRaw: (t) =>
      new S3ErrorAdapter({ putObject: neverSettles }, 'bucket', {
        timeoutMs: t,
      }),
  },
  {
    name: 'SnsErrorAdapter',
    sink: 'SNS',
    build: (t) =>
      new SnsErrorAdapter({ publish: neverSettles }, SNS_TOPIC, {
        timeoutMs: t,
      }),
    buildRaw: (t) =>
      new SnsErrorAdapter({ publish: neverSettles }, SNS_TOPIC, {
        timeoutMs: t,
      }),
  },
  {
    name: 'SupabaseErrorAdapter',
    sink: 'Supabase',
    build: (t) =>
      new SupabaseErrorAdapter(
        { from: () => ({ insert: neverSettles }) },
        { timeoutMs: t }
      ),
    buildRaw: (t) =>
      new SupabaseErrorAdapter(
        { from: () => ({ insert: neverSettles }) },
        { timeoutMs: t }
      ),
  },
];

describe.each(CASES)('$name timeout', ({ name, build, buildRaw, sink }) => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('stops waiting after the default 10 seconds and says why', async () => {
    const pending = build().log(ENTRY);
    await vi.advanceTimersByTimeAsync(9_999);
    let settled = false;
    void pending.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const result: ErrorLogResult = await pending;

    expect(result.ok).toBe(false);
    expect(result.error).toContain(name);
    expect(result.error).toContain(`${sink} did not respond within 10000 ms`);
    expect(result.error).toContain('retrying could store it twice');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses a custom timeoutMs', async () => {
    const pending = build(250).log(ENTRY);
    await vi.advanceTimersByTimeAsync(250);
    expect((await pending).error).toContain('within 250 ms');
  });

  it('does not set a timer when timeoutMs is Infinity', () => {
    void build(Infinity).log(ENTRY);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, -5, NaN])('rejects timeoutMs %s in the constructor', (value) => {
    expect(() => buildRaw(value)).toThrow(
      new RegExp(`${name}: timeoutMs must be a positive number or Infinity`)
    );
  });
});

describe('timeouts do not break a working sink', () => {
  it('returns ok and clears the timer when the client answers', async () => {
    vi.useFakeTimers();
    const insertOne = vi.fn().mockResolvedValue({});
    const result = await new MongoDbErrorAdapter({ insertOne }).log(ENTRY);
    expect(result).toEqual({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('keeps a hung table creation from blocking later calls', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let hang = true;
    const query = vi.fn((): Promise<unknown> =>
      hang ? neverSettles() : Promise.resolve({})
    );
    const adapter = new PostgresErrorAdapter({ query }, { timeoutMs: 100 });

    const first = adapter.log(ENTRY);
    await vi.advanceTimersByTimeAsync(100);
    expect((await first).ok).toBe(false);

    hang = false;
    expect(await adapter.log(ENTRY)).toEqual({ ok: true });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps S3 batch entries buffered when the upload times out, then uploads them', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let hang = true;
    const putObject = vi.fn((): Promise<unknown> =>
      hang ? neverSettles() : Promise.resolve({})
    );
    const adapter = new S3ErrorAdapter({ putObject }, 'b', {
      batch: { batchSize: 1 },
      timeoutMs: 100,
    });

    const first = adapter.log(ENTRY);
    await vi.advanceTimersByTimeAsync(100);
    expect((await first).ok).toBe(false);

    hang = false;
    expect(await adapter.flush()).toEqual({ ok: true });
    const body = (
      putObject.mock.calls.at(-1) as unknown as [{ Body: string }]
    )[0].Body;
    expect(body.trim().split('\n')).toHaveLength(1);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
});

describe('CompositeErrorAdapter timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports a hung adapter without holding back the others', async () => {
    class HangingAdapter implements ErrorLogAdapter {
      log(): Promise<ErrorLogResult> {
        return neverSettles();
      }
    }
    const good: ErrorLogAdapter = { log: async () => ({ ok: true }) };
    const composite = new CompositeErrorAdapter([new HangingAdapter(), good], {
      timeoutMs: 200,
    });

    const pending = composite.log(ENTRY);
    await vi.advanceTimersByTimeAsync(200);
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(result.error).toContain('1 of 2 adapters failed');
    expect(result.error).toContain(
      'adapter 0 (HangingAdapter) did not return within 200 ms'
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('defaults to 30 seconds', async () => {
    const composite = new CompositeErrorAdapter([{ log: neverSettles }]);
    const pending = composite.log(ENTRY);
    await vi.advanceTimersByTimeAsync(29_999);
    let settled = false;
    void pending.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).error).toContain('within 30000 ms');
  });

  it('rejects an invalid timeoutMs', () => {
    expect(() => new CompositeErrorAdapter([], { timeoutMs: 0 })).toThrow(
      /CompositeErrorAdapter: timeoutMs/
    );
  });
});
