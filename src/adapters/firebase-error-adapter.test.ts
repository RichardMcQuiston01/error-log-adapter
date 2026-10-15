import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ErrorLogEntry } from '../types.js';
import {
  FirestoreErrorAdapter,
  RealtimeDatabaseErrorAdapter,
} from './firebase-error-adapter.js';
import type {
  FirebaseErrorRecord,
  FirestoreCollectionLike,
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
  set: ReturnType<typeof vi.fn<[FirebaseErrorRecord], Promise<unknown>>>;
} {
  const set = vi
    .fn<[FirebaseErrorRecord], Promise<unknown>>()
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
  it('uses the record id as the document id, so a retried write cannot duplicate', async () => {
    const { collection, doc, set } = fakeFirestore();

    await new FirestoreErrorAdapter(collection).log(ENTRY);

    expect(doc).toHaveBeenCalledTimes(1);
    expect(doc.mock.calls[0]?.[0]).toBe(set.mock.calls[0]?.[0].id);
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
