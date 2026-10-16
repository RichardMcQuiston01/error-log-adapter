import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREFIX, reportFailure } from './fail.js';
import { SerialQueue } from './queue.js';
import { assertIdentifier } from './sql-ident.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('assertIdentifier', () => {
  it.each(['error_log', '_x', 'A1', 'a'])('accepts %s', (name) => {
    expect(() => assertIdentifier(name, 'table name', 'Owner')).not.toThrow();
  });

  it.each(['', '1table', 'bad name', 'x;DROP', 'a-b', 'a.b', '"q"'])(
    'rejects %j with the owner and label in the message',
    (name) => {
      expect(() => assertIdentifier(name, 'role name', 'Owner')).toThrow(
        new RangeError(
          `Owner: invalid role name "${name}". Use only letters, digits and underscores, and do not start with a digit.`
        )
      );
    }
  );

  it('enforces an optional length limit', () => {
    expect(() =>
      assertIdentifier('abcd', 'table name', 'Owner', 4)
    ).not.toThrow();
    expect(() => assertIdentifier('abcde', 'table name', 'Owner', 4)).toThrow(
      'Owner: table name "abcde" is 5 characters long, but the limit is 4.'
    );
  });
});

describe('reportFailure', () => {
  it('logs under the prefix and returns a descriptive result', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error('disk full');

    const result = reportFailure({
      adapterName: 'XAdapter',
      prefix: '[app]',
      action: 'to write "f"',
      error,
    });

    expect(result).toEqual({
      ok: false,
      error: 'XAdapter failed to write "f": disk full',
    });
    expect(spy).toHaveBeenCalledWith('[app] XAdapter:', error);
  });

  it('describes a thrown non-Error and accepts a custom reason', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      reportFailure({
        adapterName: 'X',
        prefix: 'p',
        action: 'a',
        error: 'text',
      }).error
    ).toBe('X failed a: text');
    expect(
      reportFailure({
        adapterName: 'X',
        prefix: 'p',
        action: 'a',
        error: { message: 'raw' },
        reason: 'custom words',
      }).error
    ).toBe('X failed a: custom words');
  });

  it('exposes the default prefix', () => {
    expect(DEFAULT_PREFIX).toBe('[error-log-adapter]');
  });
});

describe('SerialQueue', () => {
  it('runs tasks one at a time, in order', async () => {
    const queue = new SerialQueue();
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));

    const first = queue.run(async () => {
      order.push('first start');
      await gate;
      order.push('first end');
      return 1;
    });
    const second = queue.run(async () => {
      order.push('second');
      return 2;
    });

    await Promise.resolve();
    expect(order).toEqual(['first start']);
    release();
    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(order).toEqual(['first start', 'first end', 'second']);
  });

  it('keeps running after a task rejects, and still reports that rejection', async () => {
    const queue = new SerialQueue();
    const failing = queue.run(() => Promise.reject(new Error('nope')));
    const next = queue.run(async () => 'still ran');

    await expect(failing).rejects.toThrow('nope');
    expect(await next).toBe('still ran');
  });
});
