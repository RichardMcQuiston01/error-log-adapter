import { describe, expect, it, vi } from 'vitest';
import type { ErrorLogEntry } from '../types.js';
import { ConsoleErrorAdapter } from './console-error-adapter.js';

const ENTRY: ErrorLogEntry = {
  code: 'ADAPTER_ERROR',
  message: 'something went wrong',
};

describe('ConsoleErrorAdapter', () => {
  it('writes the entry to console.error with the default prefix', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await new ConsoleErrorAdapter().log(ENTRY);

    expect(result).toEqual({ ok: true });
    expect(spy).toHaveBeenCalledWith('[error-log-adapter]', ENTRY);
    spy.mockRestore();
  });

  it('uses a custom prefix', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await new ConsoleErrorAdapter({ prefix: '[my-app]' }).log(ENTRY);

    expect(spy).toHaveBeenCalledWith('[my-app]', ENTRY);
    spy.mockRestore();
  });

  it('returns a failure result instead of throwing if console.error throws', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {
      throw new Error('stderr closed');
    });

    const result = await new ConsoleErrorAdapter().log(ENTRY);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('stderr closed');
    spy.mockRestore();
  });
});
