import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ErrorLogEntry } from '../types.js';
import {
  FirestoreErrorAdapter,
  RealtimeDatabaseErrorAdapter,
} from './firebase-error-adapter.js';
import type {
  FirebaseErrorRecord,
  FirestoreCollectionLike,
  FirestoreErrorRecord,
  RealtimeDatabaseRefLike,
} from './firebase-error-adapter.js';

const ENTRY: ErrorLogEntry = {
  code: 'RULE_EVAL_FAILED',
  message: 'bad rule',
  source: 'rules-engine',
  cause: new Error('x'),
  timestamp: '2026-01-02T03:04:05.678Z',
};

function silenceConsole() {
  return vi.spyOn(console, 'error').mockImplementation(() => {});
}

/** Stores written records the way a collection would, keyed by document id. */
function fakeFirestore(): {
  collection: FirestoreCollectionLike;
  doc: ReturnType<typeof vi.fn<[string], unknown>>;
  set: ReturnType<typeof vi.fn<[FirestoreErrorRecord], Promise<unknown>>>;
} {
  const set = vi
    .fn<[FirestoreErrorRecord], Promise<unknown>>()
    .mockResolvedValue({});
  const doc = vi.fn<[string], unknown>().mockReturnValue({ set });
  return {
    collection: { doc } as unknown as FirestoreCollectionLike,
    doc,
    set,
  };
}

function fakeRealtimeDatabase(): {
  reference: RealtimeDatabaseRefLike;
  push: ReturnType<typeof vi.fn<[FirebaseErrorRecord], PromiseLike<unknown>>>;
} {
  const push = vi
    .fn<[FirebaseErrorRecord], PromiseLike<unknown>>()
    .mockResolvedValue({});
  return { reference: { push }, push };
}

describe.each([
  {
    name: 'FirestoreErrorAdapter',
    setup: () => {
      const { collection, doc, set } = fakeFirestore();
      return {
        adapter: (options?: { prefix?: string }) =>
          new FirestoreErrorAdapter(collection, options),
        written: () => set.mock.calls.map(([record]) => record),
        failWith: (error: Error) => set.mockRejectedValue(error),
        doc,
      };
    },
  },
  {
    name: 'RealtimeDatabaseErrorAdapter',
    setup: () => {
      const { reference, push } = fakeRealtimeDatabase();
      return {
        adapter: (options?: { prefix?: string }) =>
          new RealtimeDatabaseErrorAdapter(reference, options),
        written: () => push.mock.calls.map(([record]) => record),
        failWith: (error: Error) => push.mockRejectedValue(error),
        doc: undefined,
      };
    },
  },
])('$name', ({ name, setup }) => {
  it('writes the record: UUID id, fields, and the cause as a JSON string', async () => {
    const { adapter, written } = setup();

    const result = await adapter().log(ENTRY);

    expect(result).toEqual({ ok: true });
    const [record] = written();
    expect(record?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(record).toMatchObject({
      code: 'RULE_EVAL_FAILED',
      message: 'bad rule',
      source: 'rules-engine',
      timestamp: '2026-01-02T03:04:05.678Z',
    });
    expect(typeof record?.cause).toBe('string');
    expect(JSON.parse(record?.cause ?? '')).toMatchObject({
      name: 'Error',
      message: 'x',
    });
  });

  it('leaves out source and cause when the entry has none, and never writes undefined', async () => {
    const { adapter, written } = setup();

    await adapter().log({
      code: 'X',
      message: 'm',
      timestamp: ENTRY.timestamp,
    });

    const [record] = written();
    expect(Object.keys(record ?? {}).sort()).toEqual([
      'code',
      'id',
      'message',
      'timestamp',
    ]);
  });

  it('fills in a timestamp when the entry has none', async () => {
    const { adapter, written } = setup();

    await adapter().log({ code: 'X', message: 'm' });

    expect(Number.isNaN(Date.parse(written()[0]?.timestamp ?? ''))).toBe(false);
  });

  it('stores causes that Firebase cannot hold natively (nested arrays, odd keys)', async () => {
    const { adapter, written } = setup();

    const result = await adapter().log({
      ...ENTRY,
      cause: { 'a.b/c': [[1, 2], [3]], $weird: undefined },
    });

    expect(result).toEqual({ ok: true });
    expect(JSON.parse(written()[0]?.cause ?? '')).toEqual({
      'a.b/c': [[1, 2], [3]],
    });
  });

  it('returns a failure result and logs to console.error if the write rejects', async () => {
    const { adapter, failWith } = setup();
    failWith(
      new Error('PERMISSION_DENIED: Missing or insufficient permissions.')
    );
    const spy = silenceConsole();

    const result = await adapter({ prefix: '[my-app]' }).log(ENTRY);

    expect(result.ok).toBe(false);
    expect(result.error).toContain(name);
    expect(result.error).toContain('PERMISSION_DENIED');
    expect(spy).toHaveBeenCalledWith(`[my-app] ${name}:`, expect.any(Error));
    spy.mockRestore();
  });

  it('stores an entry whose cause is circular, marking the loop', async () => {
    const { adapter, written } = setup();
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    const result = await adapter().log({ ...ENTRY, cause: circular });

    expect(result).toEqual({ ok: true });
    expect(written()[0].cause).toContain('[Circular]');
  });
});

describe('FirestoreErrorAdapter document ids', () => {
  it('uses the record id as the document id', async () => {
    const { collection, doc, set } = fakeFirestore();

    await new FirestoreErrorAdapter(collection).log(ENTRY);

    expect(doc).toHaveBeenCalledTimes(1);
    expect(doc.mock.calls[0]?.[0]).toBe(set.mock.calls[0]?.[0].id);
  });

  it('gives a second log call for the same entry a new id, so a caller retry is a new document', async () => {
    const { collection, set } = fakeFirestore();
    const adapter = new FirestoreErrorAdapter(collection);

    await adapter.log(ENTRY);
    await adapter.log(ENTRY);

    expect(set.mock.calls[0]?.[0].id).not.toBe(set.mock.calls[1]?.[0].id);
  });
});

describe('RealtimeDatabaseErrorAdapter thenables', () => {
  it('waits for a thenable that is not a real Promise, as the Firebase SDK returns', async () => {
    let saved = false;
    const thenable = {
      then: (onFulfilled: (value: unknown) => void): void => {
        saved = true;
        onFulfilled({});
      },
    } as unknown as PromiseLike<unknown>;
    const reference: RealtimeDatabaseRefLike = { push: () => thenable };

    const result = await new RealtimeDatabaseErrorAdapter(reference).log(ENTRY);

    expect(result).toEqual({ ok: true });
    expect(saved).toBe(true);
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe.each([
  {
    name: 'FirestoreErrorAdapter',
    create: (hang: boolean, options: { timeoutMs?: number }) => {
      const never = new Promise<unknown>(() => {});
      const set = vi.fn().mockReturnValue(hang ? never : Promise.resolve({}));
      const collection = {
        doc: () => ({ set }),
      } as unknown as FirestoreCollectionLike;
      return new FirestoreErrorAdapter(collection, options);
    },
  },
  {
    name: 'RealtimeDatabaseErrorAdapter',
    create: (hang: boolean, options: { timeoutMs?: number }) => {
      const never = new Promise<unknown>(() => {});
      const push = vi.fn().mockReturnValue(hang ? never : Promise.resolve({}));
      return new RealtimeDatabaseErrorAdapter({ push }, options);
    },
  },
])('$name write timeout', ({ name, create }) => {
  it('gives up with a descriptive failure when the write never settles', async () => {
    vi.useFakeTimers();
    const spy = silenceConsole();
    const adapter = create(true, { timeoutMs: 5000 });

    const pending = adapter.log(ENTRY);
    await vi.advanceTimersByTimeAsync(4999);
    let settled = false;
    void pending.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(result.error).toContain(name);
    expect(result.error).toContain('not saved within 5000 ms');
    expect(result.error).toContain('could store it twice');
    spy.mockRestore();
  });

  it('uses a 10 second limit by default', async () => {
    vi.useFakeTimers();
    const spy = silenceConsole();
    const pending = create(true, {}).log(ENTRY);

    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;

    expect(result.error).toContain('not saved within 10000 ms');
    spy.mockRestore();
  });

  it('clears its timer when the write succeeds', async () => {
    vi.useFakeTimers();

    const result = await create(false, { timeoutMs: 5000 }).log(ENTRY);

    expect(result).toEqual({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits without limit when timeoutMs is Infinity', async () => {
    vi.useFakeTimers();

    const pending = create(false, { timeoutMs: Infinity }).log(ENTRY);

    expect(vi.getTimerCount()).toBe(0);
    expect(await pending).toEqual({ ok: true });
  });

  it.each([0, -1, Number.NaN])(
    'rejects timeoutMs of %s',
    (timeoutMs: number) => {
      expect(() => create(false, { timeoutMs })).toThrowError(
        new RegExp(`${name}: timeoutMs must be a positive number or Infinity`)
      );
    }
  );
});

describe('FirestoreErrorAdapter expiry', () => {
  const DAY = 24 * 60 * 60 * 1000;

  it('adds no expiry field by default', async () => {
    const { collection, set } = fakeFirestore();
    await new FirestoreErrorAdapter(collection).log(ENTRY);
    expect(set.mock.calls[0][0]).not.toHaveProperty('expire_at');
  });

  it('stores a Date the entry timestamp plus expireAfterMs in expire_at', async () => {
    const { collection, set } = fakeFirestore();

    const result = await new FirestoreErrorAdapter(collection, {
      expireAfterMs: 30 * DAY,
    }).log(ENTRY);

    expect(result).toEqual({ ok: true });
    const record = set.mock.calls[0][0] as Record<string, unknown>;
    expect(record.expire_at).toBeInstanceOf(Date);
    expect((record.expire_at as Date).toISOString()).toBe(
      new Date(Date.parse('2026-01-02T03:04:05.678Z') + 30 * DAY).toISOString()
    );
    // the other fields are untouched, and timestamp stays a string
    expect(record.timestamp).toBe('2026-01-02T03:04:05.678Z');
  });

  it('uses a custom expireField', async () => {
    const { collection, set } = fakeFirestore();
    await new FirestoreErrorAdapter(collection, {
      expireAfterMs: DAY,
      expireField: 'delete_after',
    }).log(ENTRY);
    const record = set.mock.calls[0][0] as Record<string, unknown>;
    expect(record.delete_after).toBeInstanceOf(Date);
    expect(record).not.toHaveProperty('expire_at');
  });

  it('works from the time of logging when the entry has no timestamp', async () => {
    const { collection, set } = fakeFirestore();
    const before = Date.now();
    await new FirestoreErrorAdapter(collection, { expireAfterMs: DAY }).log({
      code: 'E',
      message: 'm',
    });
    const expiry = (set.mock.calls[0][0] as Record<string, unknown>)
      .expire_at as Date;
    expect(expiry.getTime()).toBeGreaterThanOrEqual(before + DAY);
    expect(expiry.getTime()).toBeLessThanOrEqual(Date.now() + DAY);
  });

  it('reports a timestamp that is not a date instead of writing a bad expiry', async () => {
    silenceConsole();
    const { collection, set } = fakeFirestore();
    const result = await new FirestoreErrorAdapter(collection, {
      expireAfterMs: DAY,
    }).log({ ...ENTRY, timestamp: 'soon' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('expiry time cannot be worked out');
    expect(set).not.toHaveBeenCalled();
  });

  it('gives the same expiry to a retry with the same id and timestamp', async () => {
    const { collection, set } = fakeFirestore();
    const adapter = new FirestoreErrorAdapter(collection, {
      expireAfterMs: DAY,
    });
    const entry = { ...ENTRY, id: '3f2b8c1e-5d4a-4e7b-9a10-2c6d8e0f1a2b' };
    await adapter.log(entry);
    await adapter.log(entry);
    expect((set.mock.calls[0][0] as Record<string, unknown>).expire_at).toEqual(
      (set.mock.calls[1][0] as Record<string, unknown>).expire_at
    );
  });

  it.each([0, -1, NaN, Infinity])('rejects expireAfterMs %s', (value) => {
    expect(
      () =>
        new FirestoreErrorAdapter(fakeFirestore().collection, {
          expireAfterMs: value,
        })
    ).toThrow(/expireAfterMs must be a positive number/);
  });

  it.each(['', 'id', 'timestamp', 'cause', 'a.b', 'a/b'])(
    'rejects expireField %j',
    (field) => {
      expect(
        () =>
          new FirestoreErrorAdapter(fakeFirestore().collection, {
            expireAfterMs: DAY,
            expireField: field,
          })
      ).toThrow(/expireField must be a name other than/);
    }
  );
});
