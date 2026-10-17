import { createHmac } from 'node:crypto';
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

  describe('timeout', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /** A fetch that never answers on its own but rejects like the real one when aborted. */
    function hangingFetch() {
      return vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(
                new DOMException('This operation was aborted', 'AbortError')
              )
            );
          })
      );
    }

    it('aborts the request and fails after the default 10 seconds', async () => {
      vi.useFakeTimers();
      const mockFetch = hangingFetch();
      vi.stubGlobal('fetch', mockFetch);
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const pending = new WebhookErrorAdapter(
        'https://hooks.example.com/services/SECRET'
      ).log(ENTRY);
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;

      expect(result.ok).toBe(false);
      expect(result.error).toContain(
        'webhook https://hooks.example.com did not respond within 10000 ms'
      );
      expect(result.error).not.toContain('SECRET');
      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(init.signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      spy.mockRestore();
    });

    it('uses a custom timeoutMs and leaves no timer behind on success', async () => {
      vi.useFakeTimers();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, status: 200 })
      );

      const result = await new WebhookErrorAdapter('https://example.com/e', {
        timeoutMs: 250,
      }).log(ENTRY);

      expect(result).toEqual({ ok: true });
      expect(vi.getTimerCount()).toBe(0);
    });

    it('does not set a timer for Infinity', async () => {
      vi.useFakeTimers();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, status: 200 })
      );
      const pending = new WebhookErrorAdapter('https://example.com/e', {
        timeoutMs: Infinity,
      }).log(ENTRY);
      expect(vi.getTimerCount()).toBe(0);
      await pending;
    });

    it.each([0, -1, NaN])('rejects timeoutMs %s', (value: number) => {
      expect(
        () =>
          new WebhookErrorAdapter('https://example.com/e', { timeoutMs: value })
      ).toThrow(/WebhookErrorAdapter: timeoutMs must be a positive number/);
    });
  });

  describe('retries', () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    const URL_ = 'https://example.com/errors';
    const ok = { ok: true, status: 200 };
    const status = (code: number, headers: Record<string, string> = {}) => ({
      ok: false,
      status: code,
      headers: new Headers(headers),
    });

    it('sends once by default, without an id', async () => {
      const mockFetch = vi.fn().mockResolvedValue(status(503));
      vi.stubGlobal('fetch', mockFetch);
      const result = await new WebhookErrorAdapter(URL_).log(ENTRY);
      expect(result.ok).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(init.body as string)).toEqual(ENTRY);
    });

    it('retries a 5xx with doubling waits and succeeds', async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(1);
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(status(503))
        .mockResolvedValueOnce(status(500))
        .mockResolvedValueOnce(ok);
      vi.stubGlobal('fetch', mockFetch);

      const pending = new WebhookErrorAdapter(URL_, {
        retries: 3,
        retryDelayMs: 100,
      }).log(ENTRY);
      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(99);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(199);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);

      expect(await pending).toEqual({ ok: true });
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('sends the same body, with an id, on every attempt', async () => {
      vi.useFakeTimers();
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(status(502))
        .mockResolvedValueOnce(ok);
      vi.stubGlobal('fetch', mockFetch);
      const pending = new WebhookErrorAdapter(URL_, { retries: 1 }).log(ENTRY);
      await vi.runAllTimersAsync();
      await pending;
      const bodies = mockFetch.mock.calls.map(
        ([, init]: [string, RequestInit]) => init.body as string
      );
      expect(bodies[0]).toBe(bodies[1]);
      expect(JSON.parse(bodies[0] as string).id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('reports the last failure and the attempt count when retries run out', async () => {
      vi.useFakeTimers();
      const mockFetch = vi.fn().mockResolvedValue(status(500));
      vi.stubGlobal('fetch', mockFetch);
      const pending = new WebhookErrorAdapter(URL_, { retries: 2 }).log(ENTRY);
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(result.error).toBe(
        'WebhookErrorAdapter failed: webhook https://example.com responded with HTTP 500 (after 3 attempts)'
      );
    });

    it.each([400, 401, 403, 404, 422])(
      'does not retry HTTP %i',
      async (code: number) => {
        const mockFetch = vi.fn().mockResolvedValue(status(code));
        vi.stubGlobal('fetch', mockFetch);
        await new WebhookErrorAdapter(URL_, { retries: 3 }).log(ENTRY);
        expect(mockFetch).toHaveBeenCalledTimes(1);
      }
    );

    it.each([408, 425, 429])('retries HTTP %i', async (code: number) => {
      vi.useFakeTimers();
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(status(code))
        .mockResolvedValueOnce(ok);
      vi.stubGlobal('fetch', mockFetch);
      const pending = new WebhookErrorAdapter(URL_, { retries: 1 }).log(ENTRY);
      await vi.runAllTimersAsync();
      expect(await pending).toEqual({ ok: true });
    });

    it('does not retry a redirect', async () => {
      const mockFetch = vi.fn().mockResolvedValue(status(307));
      vi.stubGlobal('fetch', mockFetch);
      await new WebhookErrorAdapter(URL_, { retries: 3 }).log(ENTRY);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('retries a network error and logs only the final one', async () => {
      vi.useFakeTimers();
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const mockFetch = vi
        .fn()
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(ok);
      vi.stubGlobal('fetch', mockFetch);
      const pending = new WebhookErrorAdapter(URL_, { retries: 1 }).log(ENTRY);
      await vi.runAllTimersAsync();
      expect(await pending).toEqual({ ok: true });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('retries after a timeout, with the timeout applying to each attempt', async () => {
      vi.useFakeTimers();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const mockFetch = vi
        .fn()
        .mockImplementationOnce(
          (_url: string, init: RequestInit) =>
            new Promise((_resolve, reject) => {
              init.signal?.addEventListener('abort', () =>
                reject(new DOMException('aborted', 'AbortError'))
              );
            })
        )
        .mockResolvedValueOnce(ok);
      vi.stubGlobal('fetch', mockFetch);
      const pending = new WebhookErrorAdapter(URL_, {
        retries: 1,
        timeoutMs: 1000,
      }).log(ENTRY);
      await vi.runAllTimersAsync();
      expect(await pending).toEqual({ ok: true });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('honors Retry-After in seconds, capped at maxRetryDelayMs', async () => {
      vi.useFakeTimers();
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(status(429, { 'Retry-After': '2' }))
        .mockResolvedValueOnce(status(429, { 'Retry-After': '3600' }))
        .mockResolvedValueOnce(ok);
      vi.stubGlobal('fetch', mockFetch);
      const pending = new WebhookErrorAdapter(URL_, {
        retries: 2,
        maxRetryDelayMs: 5000,
      }).log(ENTRY);
      await vi.advanceTimersByTimeAsync(1999);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(4999);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual({ ok: true });
    });

    it('honors a Retry-After HTTP date', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(
          status(503, { 'Retry-After': 'Thu, 01 Jan 2026 00:00:03 GMT' })
        )
        .mockResolvedValueOnce(ok);
      vi.stubGlobal('fetch', mockFetch);
      const pending = new WebhookErrorAdapter(URL_, {
        retries: 1,
        maxRetryDelayMs: 10_000,
      }).log(ENTRY);
      await vi.advanceTimersByTimeAsync(2999);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual({ ok: true });
    });

    it('rejects invalid retry options', () => {
      const bad: Record<string, unknown>[] = [
        { retries: -1 },
        { retries: 1.5 },
        { retries: NaN },
        { retryDelayMs: 0 },
        { retryDelayMs: Infinity },
        { retryDelayMs: 1000, maxRetryDelayMs: 500 },
        { signingSecret: '' },
      ];
      for (const options of bad) {
        expect(() => new WebhookErrorAdapter(URL_, options)).toThrow(
          RangeError
        );
      }
    });

    it('reports an invalid entry id without sending', async () => {
      const mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const result = await new WebhookErrorAdapter(URL_, { retries: 2 }).log({
        ...ENTRY,
        id: 'nope',
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('entry.id must be a UUID');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('signingSecret', () => {
    const URL_ = 'https://example.com/errors';

    it('signs timestamp.body with HMAC-SHA256', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal('fetch', mockFetch);
      await new WebhookErrorAdapter(URL_, { signingSecret: 's3cret' }).log(
        ENTRY
      );
      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      const expected: string = createHmac('sha256', 's3cret')
        .update(`${headers['X-Signature-Timestamp']}.${init.body as string}`)
        .digest('hex');
      expect(headers['X-Signature-256']).toBe(`sha256=${expected}`);
      expect(Number(headers['X-Signature-Timestamp'])).toBeGreaterThan(1.7e9);
    });

    it('sends no signature headers without a secret', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal('fetch', mockFetch);
      await new WebhookErrorAdapter(URL_).log(ENTRY);
      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(init.headers).not.toHaveProperty('X-Signature-256');
    });

    it('signs again, with a fresh timestamp, on each retry', async () => {
      const now = vi
        .spyOn(Date, 'now')
        .mockReturnValueOnce(1_900_000_000_000)
        .mockReturnValue(1_900_000_002_000);
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          headers: new Headers({ 'Retry-After': '0' }),
        })
        .mockResolvedValueOnce({ ok: true, status: 200 });
      vi.stubGlobal('fetch', mockFetch);
      const result = await new WebhookErrorAdapter(URL_, {
        signingSecret: 'k',
        retries: 1,
      }).log(ENTRY);
      now.mockRestore();
      expect(result).toEqual({ ok: true });
      const stamps: string[] = mockFetch.mock.calls.map(
        ([, init]: [string, RequestInit]) =>
          (init.headers as Record<string, string>)['X-Signature-Timestamp']
      );
      expect(stamps).toEqual(['1900000000', '1900000002']);
    });

    it('fails without sending or retrying when Web Crypto is missing', async () => {
      const mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);
      vi.stubGlobal('crypto', undefined);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const result = await new WebhookErrorAdapter(URL_, {
        signingSecret: 'k',
        retries: 2,
      }).log(ENTRY);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('signingSecret needs Web Crypto');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
