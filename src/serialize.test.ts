import nodeVm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { serializeCause, serializeEntry } from './serialize.js';

function withCause(message: string, cause: unknown): Error {
  return Object.assign(new Error(message), { cause });
}

describe('serializeCause', () => {
  it('keeps name, message and stack of an Error', () => {
    const result = serializeCause(new TypeError('bad')) as Record<
      string,
      unknown
    >;
    expect(result['name']).toBe('TypeError');
    expect(result['message']).toBe('bad');
    expect(typeof result['stack']).toBe('string');
    expect(result).not.toHaveProperty('cause');
  });

  it('keeps nested causes', () => {
    const outer = withCause('outer', withCause('middle', 'root cause text'));
    const result = JSON.parse(JSON.stringify(serializeCause(outer)));
    expect(result.cause.message).toBe('middle');
    expect(result.cause.cause).toBe('root cause text');
  });

  it('keeps the errors of an AggregateError', () => {
    const aggregate = Object.assign(new Error('both failed'), {
      name: 'AggregateError',
      errors: [new Error('first'), new Error('second')],
    });
    const result = JSON.parse(JSON.stringify(serializeCause(aggregate)));
    expect(result.errors.map((e: { message: string }) => e.message)).toEqual([
      'first',
      'second',
    ]);
  });

  it('converts an Error nested inside a plain object or array', () => {
    const result = JSON.parse(
      JSON.stringify(
        serializeCause({
          request: 'r',
          error: new Error('nope'),
          list: [new Error('x')],
        })
      )
    );
    expect(result.error.message).toBe('nope');
    expect(result.list[0].message).toBe('x');
  });

  it('recognises an error from another realm by its shape', () => {
    const foreign = {
      name: 'Error',
      message: 'from vm',
      stack: 'Error: from vm\n  at x',
    };
    expect(serializeCause(foreign)).toMatchObject({ message: 'from vm' });
    const foreignError = nodeVm.runInNewContext('new Error("other realm")');
    expect(foreignError instanceof Error).toBe(false);
    expect(
      JSON.parse(JSON.stringify(serializeCause({ error: foreignError }))).error
        .message
    ).toBe('other realm');
  });

  it('marks circular references instead of throwing', () => {
    const loop: Record<string, unknown> = { name: 'loop' };
    loop['self'] = loop;
    const result = serializeCause(loop) as Record<string, unknown>;
    expect(result['self']).toBe('[Circular]');
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it('marks a cause chain that points back at itself', () => {
    const error = new Error('self-caused');
    (error as { cause?: unknown }).cause = error;
    const result = JSON.parse(JSON.stringify(serializeCause(error)));
    expect(result.cause).toBe('[Circular]');
  });

  it('does not mark a value that is merely shared as circular', () => {
    const shared = { n: 1 };
    const result = serializeCause({ a: shared, b: shared });
    expect(result).toEqual({ a: { n: 1 }, b: { n: 1 } });
  });

  it('truncates very deep structures', () => {
    let deep: Record<string, unknown> = { end: true };
    for (let i = 0; i < 20; i++) {
      deep = { next: deep };
    }
    expect(JSON.stringify(serializeCause(deep))).toContain('[Truncated]');
  });

  it('turns BigInt, Symbol, function and non-finite numbers into strings', () => {
    function namedFunction(): void {}
    const result = serializeCause({
      big: 10n,
      sym: Symbol('s'),
      fn: namedFunction,
      inf: Infinity,
      nan: NaN,
    });
    expect(result).toEqual({
      big: '10n',
      sym: 'Symbol(s)',
      fn: '[Function namedFunction]',
      inf: 'Infinity',
      nan: 'NaN',
    });
  });

  it('describes a property or toJSON that throws', () => {
    const hostile = {
      get boom(): string {
        throw new Error('getter failed');
      },
      ok: 1,
    };
    expect(serializeCause(hostile)).toEqual({
      boom: '[Unreadable: getter failed]',
      ok: 1,
    });
    const badJson = {
      toJSON(): never {
        throw new Error('no json');
      },
    };
    expect(serializeCause(badJson)).toBe('[toJSON failed: no json]');
  });

  it('uses toJSON, as JSON.stringify would', () => {
    expect(serializeCause(new Date('2026-01-02T03:04:05.000Z'))).toBe(
      '2026-01-02T03:04:05.000Z'
    );
  });

  it('passes plain values through', () => {
    expect(serializeCause('text')).toBe('text');
    expect(serializeCause(5)).toBe(5);
    expect(serializeCause(null)).toBeNull();
    expect(serializeCause(undefined)).toBeUndefined();
  });
});

describe('serializeEntry', () => {
  it('always produces something JSON.stringify accepts', () => {
    const loop: Record<string, unknown> = {};
    loop['self'] = loop;
    const entry = serializeEntry({
      code: 'X',
      message: 'm',
      cause: { loop, big: 1n },
    });
    expect(() => JSON.stringify(entry)).not.toThrow();
  });

  it('adds a timestamp and omits missing optional fields', () => {
    const entry = serializeEntry({ code: 'X', message: 'm' });
    expect(Number.isNaN(Date.parse(entry.timestamp))).toBe(false);
    expect(entry).not.toHaveProperty('cause');
    expect(entry).not.toHaveProperty('source');
  });
});
