import { describe, expect, it, vi } from 'vitest';
import type { ErrorLogAdapter, ErrorLogEntry } from '../types.js';
import { CompositeErrorAdapter } from './composite-error-adapter.js';

const ENTRY: ErrorLogEntry = { code: 'ADAPTER_ERROR', message: 'boom' };

const succeeding = (): ErrorLogAdapter => ({
  log: vi.fn().mockResolvedValue({ ok: true }),
});
const failing = (): ErrorLogAdapter => ({
  log: vi.fn().mockResolvedValue({ ok: false, error: 'sink down' }),
});

describe('CompositeErrorAdapter', () => {
  it('forwards the entry to every adapter and succeeds when all succeed', async () => {
    const first = succeeding();
    const second = succeeding();

    const result = await new CompositeErrorAdapter([first, second]).log(ENTRY);

    expect(result).toEqual({ ok: true });
    expect(first.log).toHaveBeenCalledWith(ENTRY);
    expect(second.log).toHaveBeenCalledWith(ENTRY);
  });

  it('still calls the remaining adapters when one fails, and reports the failure', async () => {
    const good = succeeding();

    const result = await new CompositeErrorAdapter([failing(), good]).log(
      ENTRY
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('1 of 2 adapters failed');
    expect(result.error).toContain('sink down');
    expect(good.log).toHaveBeenCalledOnce();
  });

  it('contains an adapter that throws instead of returning a result', async () => {
    const throwing: ErrorLogAdapter = {
      log: vi.fn().mockRejectedValue(new Error('rogue')),
    };

    const result = await new CompositeErrorAdapter([
      throwing,
      succeeding(),
    ]).log(ENTRY);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('rogue');
  });
});
