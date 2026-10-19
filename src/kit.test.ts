import { describe, expect, it } from 'vitest';
import * as kit from './kit.js';

describe('kit', () => {
  it('exposes the helpers adapter packages build on', () => {
    const names: string[] = Object.keys(kit).sort();
    expect(names).toEqual(
      [
        'DEFAULT_PREFIX',
        'DEFAULT_TABLE_NAME',
        'DEFAULT_TIMEOUT_MS',
        'SerialQueue',
        'SinkTimeoutError',
        'assertIdentifier',
        'backoffDelayMs',
        'describeError',
        'generateId',
        'hasCallerId',
        'reportFailure',
        'resolveEntryId',
        'resolveTimeoutMs',
        'timeoutMessage',
        'withTimeout',
      ].sort()
    );
  });

  it('reports a failure in the shared format', () => {
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]): void => {
      errors.push(args);
    };
    try {
      const result = kit.reportFailure({
        adapterName: 'ExampleErrorAdapter',
        prefix: kit.DEFAULT_PREFIX,
        action: 'to publish',
        error: new Error('broker down'),
      });
      expect(result).toEqual({
        ok: false,
        error: 'ExampleErrorAdapter failed to publish: broker down',
      });
      expect(errors).toHaveLength(1);
    } finally {
      console.error = original;
    }
  });
});
