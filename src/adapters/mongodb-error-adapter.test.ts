import { describe, expect, it, vi } from 'vitest';
import type { ErrorLogEntry } from '../types.js';
import { MongoDbErrorAdapter } from './mongodb-error-adapter.js';

const ENTRY: ErrorLogEntry = {
  code: 'RULE_EVAL_FAILED',
  message: 'bad rule',
  cause: new Error('x'),
};

describe('MongoDbErrorAdapter', () => {
  it('inserts a serialized entry into the collection', async () => {
    const insertOne = vi.fn().mockResolvedValue({ insertedId: 'id1' });

    const result = await new MongoDbErrorAdapter({ insertOne }).log(ENTRY);

    expect(result).toEqual({ ok: true });
    const doc = insertOne.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(doc['code']).toBe('RULE_EVAL_FAILED');
    expect(doc['cause']).toMatchObject({ name: 'Error', message: 'x' });
    expect(typeof doc['timestamp']).toBe('string');
  });

  it('returns a failure result and logs to console.error if insertOne rejects', async () => {
    const dbError = new Error('db down');
    const insertOne = vi.fn().mockRejectedValue(dbError);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await new MongoDbErrorAdapter(
      { insertOne },
      { prefix: '[my-app]' }
    ).log(ENTRY);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('db down');
    expect(spy).toHaveBeenCalledWith('[my-app] MongoDbErrorAdapter:', dbError);
    spy.mockRestore();
  });
});
