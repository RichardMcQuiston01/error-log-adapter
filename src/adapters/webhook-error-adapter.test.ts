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

  it('does not follow redirects', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);

    await new WebhookErrorAdapter('https://example.com/errors').log(ENTRY);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(init.redirect).toBe('manual');
  });

  it.each([301, 302, 303, 307, 308])(
    'fails on an HTTP %i redirect without echoing the URL',
    async (status: number) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: false, status, type: 'basic' })
      );

      const result = await new WebhookErrorAdapter(
        'https://hooks.example.com/services/SECRET'
      ).log(ENTRY);

      expect(result.ok).toBe(false);
      expect(result.error).toContain(`HTTP ${status}`);
      expect(result.error).toContain('not followed');
      expect(result.error).not.toContain('SECRET');
    }
  );

  it('fails on a browser opaque redirect', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({ ok: false, status: 0, type: 'opaqueredirect' })
    );

    const result = await new WebhookErrorAdapter(
      'https://example.com/errors'
    ).log(ENTRY);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('a redirect');
  });

  it('keeps the secret part of the URL out of failure results', async () => {
    const url =
      'https://hooks.slack.com/services/T000/B000/SECRET?token=SECRET2';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500 })
    );
    const http500 = await new WebhookErrorAdapter(url).log(ENTRY);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error(`request to ${url} failed`))
    );
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const network = await new WebhookErrorAdapter(url).log(ENTRY);
    spy.mockRestore();

    for (const result of [http500, network]) {
      expect(result.ok).toBe(false);
      expect(result.error).toContain('https://hooks.slack.com');
      expect(result.error).not.toContain('SECRET');
      expect(result.error).not.toContain('token=');
    }
  });

  it('rejects a plain http URL unless allowInsecure is set', () => {
    expect(() => new WebhookErrorAdapter('http://example.com/errors')).toThrow(
      /must use https/
    );
    expect(
      () =>
        new WebhookErrorAdapter('http://example.com/errors', {
          allowInsecure: true,
        })
    ).not.toThrow();
  });

  it.each([
    'http://localhost:3000/e',
    'http://127.0.0.1/e',
    'http://[::1]:8080/e',
  ])('always allows the loopback address %s', (url: string) => {
    expect(() => new WebhookErrorAdapter(url)).not.toThrow();
  });

  it.each(['not a url', '', 'ftp://example.com/e', 'example.com/errors'])(
    'rejects the invalid or non-http URL %j',
    (url: string) => {
      expect(() => new WebhookErrorAdapter(url)).toThrow(RangeError);
    }
  );
});
