import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ErrorLogEntry } from '../types.js';
import { EventEmitterErrorAdapter } from './event-emitter-error-adapter.js';
import type {
  EmitterLike,
  EventEmitterErrorRecord,
} from './event-emitter-error-adapter.js';

const ID = '3f2b8c1e-5d4a-4e7b-9a10-2c6d8e0f1a2b';
const ENTRY: ErrorLogEntry = {
  code: 'PAYMENT_FAILED',
  message: 'card declined',
  source: 'checkout',
  cause: new Error('insufficient funds'),
  timestamp: '2026-01-02T03:04:05.678Z',
};

afterEach(() => {
  vi.restoreAllMocks();
});

function quiet() {
  return vi.spyOn(console, 'error').mockImplementation(() => {});
}

describe('EventEmitterErrorAdapter', () => {
  it('emits the serialized entry with a UUID id under the default event name', async () => {
    const emit = vi.fn<[string, EventEmitterErrorRecord], unknown>();

    const result = await new EventEmitterErrorAdapter({ emit }).log(ENTRY);

    expect(result).toEqual({ ok: true });
    expect(emit).toHaveBeenCalledTimes(1);
    const [name, record] = emit.mock.calls[0];
    expect(name).toBe('error-log');
    expect(record.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(record).toMatchObject({
      code: 'PAYMENT_FAILED',
      message: 'card declined',
      source: 'checkout',
      timestamp: '2026-01-02T03:04:05.678Z',
    });
    expect(record.cause).toMatchObject({
      name: 'Error',
      message: 'insufficient funds',
    });
  });

  it('adds a timestamp when missing and gives each call its own id', async () => {
    const emit = vi.fn<[string, EventEmitterErrorRecord], unknown>();
    const adapter = new EventEmitterErrorAdapter({ emit });

    await adapter.log({ code: 'E', message: 'm' });
    await adapter.log({ code: 'E', message: 'm' });

    expect(Number.isNaN(Date.parse(emit.mock.calls[0][1].timestamp))).toBe(
      false
    );
    expect(emit.mock.calls[0][1].id).not.toBe(emit.mock.calls[1][1].id);
  });

  it('uses the caller-supplied id so listeners can drop repeats', async () => {
    const emit = vi.fn<[string, EventEmitterErrorRecord], unknown>();
    await new EventEmitterErrorAdapter({ emit }).log({ ...ENTRY, id: ID });
    expect(emit.mock.calls[0][1].id).toBe(ID);
  });

  it('uses a custom event name', async () => {
    const emit = vi.fn<[string, EventEmitterErrorRecord], unknown>();
    await new EventEmitterErrorAdapter(
      { emit },
      { eventName: 'app:error' }
    ).log(ENTRY);
    expect(emit.mock.calls[0][0]).toBe('app:error');
  });

  it('returns ok: false instead of throwing when the emitter throws', async () => {
    const spy = quiet();
    const emitter: EmitterLike = {
      emit: () => {
        throw new Error('emitter is closed');
      },
    };

    const result = await new EventEmitterErrorAdapter(emitter, {
      prefix: '[app]',
    }).log(ENTRY);

    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      'EventEmitterErrorAdapter failed to emit "error-log": emitter is closed'
    );
    expect(spy).toHaveBeenCalledWith(
      '[app] EventEmitterErrorAdapter:',
      expect.any(Error)
    );
  });

  it('rejects an invalid id with a clear message', async () => {
    quiet();
    const emit = vi.fn();
    const result = await new EventEmitterErrorAdapter({ emit }).log({
      ...ENTRY,
      id: 'nope',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('entry.id must be a UUID');
    expect(emit).not.toHaveBeenCalled();
  });

  it('rejects an empty event name in the constructor', () => {
    expect(
      () => new EventEmitterErrorAdapter({ emit: vi.fn() }, { eventName: '' })
    ).toThrow(/eventName must not be empty/);
  });
});

describe('with a Node EventEmitter', () => {
  it('delivers the record to every listener', async () => {
    const bus = new EventEmitter();
    const first = vi.fn();
    const second = vi.fn();
    bus.on('error-log', first);
    bus.on('error-log', second);

    const result = await new EventEmitterErrorAdapter(bus).log(ENTRY);

    expect(result).toEqual({ ok: true });
    expect(first).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'PAYMENT_FAILED' })
    );
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('reports a listener that throws, naming its message', async () => {
    quiet();
    const bus = new EventEmitter();
    bus.on('error-log', () => {
      throw new Error('toast component crashed');
    });

    const result = await new EventEmitterErrorAdapter(bus).log(ENTRY);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('toast component crashed');
  });

  it('counts an entry nobody listened to as delivered by default', async () => {
    expect(
      await new EventEmitterErrorAdapter(new EventEmitter()).log(ENTRY)
    ).toEqual({ ok: true });
  });

  it('fails an entry nobody listened to when requireListener is set', async () => {
    quiet();
    const result = await new EventEmitterErrorAdapter(new EventEmitter(), {
      requireListener: true,
    }).log(ENTRY);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no listener is attached to "error-log"');
  });

  it('still succeeds with requireListener once a listener is attached', async () => {
    const bus = new EventEmitter();
    bus.on('error-log', () => {});
    expect(
      await new EventEmitterErrorAdapter(bus, { requireListener: true }).log(
        ENTRY
      )
    ).toEqual({ ok: true });
  });

  it('shows why not to use "error": Node throws without a listener, and log reports it', async () => {
    quiet();
    const result = await new EventEmitterErrorAdapter(new EventEmitter(), {
      eventName: 'error',
    }).log(ENTRY);
    expect(result.ok).toBe(false);
  });
});

describe('with other emitter shapes', () => {
  it('works with a mitt-style emitter whose emit returns nothing', async () => {
    const handlers = new Map<string, Array<(payload: unknown) => void>>();
    const mittLike = {
      emit(type: string, payload?: unknown): void {
        (handlers.get(type) ?? []).forEach((handler) => handler(payload));
      },
    };
    const seen: unknown[] = [];
    handlers.set('error-log', [(payload) => seen.push(payload)]);

    const result = await new EventEmitterErrorAdapter(mittLike, {
      requireListener: true,
    }).log(ENTRY);

    expect(result).toEqual({ ok: true });
    expect(seen).toHaveLength(1);
  });

  it('works with an EventTarget wrapper', async () => {
    const target = new EventTarget();
    const details: unknown[] = [];
    target.addEventListener('error-log', (event) =>
      details.push((event as CustomEvent).detail)
    );
    const emitter: EmitterLike = {
      emit: (name, payload) =>
        target.dispatchEvent(new CustomEvent(name, { detail: payload })),
    };

    expect(await new EventEmitterErrorAdapter(emitter).log(ENTRY)).toEqual({
      ok: true,
    });
    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({ message: 'card declined' });
  });
});
