import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ErrorLogEntry } from '../types.js';
import { WebhookErrorAdapter } from './webhook-error-adapter.js';

const ENTRY: ErrorLogEntry = {
  code: 'ADAPTER_ERROR',
  message: 'something went wrong',
  timestamp: '2026-01-01T00:00:00.000Z',
};

describe('WebhookErrorAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs the entry as JSON and reports success', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);

    const result = await new WebhookErrorAdapter(
      'https://example.com/errors'
    ).log(ENTRY);

    expect(result).toEqual({ ok: true });
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.com/errors');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(ENTRY);
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json'
    );
  });

  it('merges custom headers into the request', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);
    const adapter = new WebhookErrorAdapter('https://example.com/errors', {
      headers: { 'X-Api-Key': 'secret' },
    });

    await adapter.log(ENTRY);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-Api-Key']).toBe(
      'secret'
    );
  });

  it('serializes Error causes so they survive JSON', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);

    await new WebhookErrorAdapter('https://example.com/errors').log({
      ...ENTRY,
      cause: new Error('root cause'),
    });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      cause: { message: string };
    };
    expect(body.cause.message).toBe('root cause');
  });

  it('returns a failure result on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500 })
    );

    const result = await new WebhookErrorAdapter(
      'https://example.com/errors'
    ).log(ENTRY);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('HTTP 500');
  });

  it('returns a failure result and logs to console.error on fetch rejection', async () => {
    const networkError = new Error('offline');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(networkError));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await new WebhookErrorAdapter('https://example.com/errors', {
      prefix: '[my-app]',
    }).log(ENTRY);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('offline');
    expect(spy).toHaveBeenCalledWith(
      '[my-app] WebhookErrorAdapter:',
      networkError
    );
    spy.mockRestore();
  });
});
