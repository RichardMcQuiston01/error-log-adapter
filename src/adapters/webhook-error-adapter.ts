import { backoffDelayMs } from '../backoff.js';
import { DEFAULT_PREFIX } from '../fail.js';
import { hasCallerId, resolveEntryId } from '../entry-id.js';
import { describeError, serializeEntry } from '../serialize.js';
import { resolveTimeoutMs, timeoutMessage } from '../timeout.js';
import type {
  ErrorLogAdapter,
  ErrorLogEntry,
  ErrorLogResult,
} from '../types.js';

export interface WebhookErrorOptions {
  /** Extra headers merged into the request. */
  headers?: Record<string, string>;
  /** Text printed before failure messages. Defaults to `[error-log-adapter]`. */
  prefix?: string;
  /**
   * Allow a plain `http://` URL. Entries contain error messages and stack
   * traces, so they are only sent over `https://` unless this is `true`.
   * `http://localhost`, `127.0.0.1` and `[::1]` are always allowed.
   * Defaults to `false`.
   */
  allowInsecure?: boolean;
  /**
   * How long to wait for the webhook to answer, in milliseconds. Defaults to
   * 10000. Pass `Infinity` to wait without limit. When it passes, the request is
   * cancelled, so the connection is closed rather than left open; the server may
   * still have received the entry.
   */
  timeoutMs?: number;
  /**
   * How many times to try again after a failure that may go away on its own: a
   * network error, a timeout, HTTP 408, 425, 429 or any 5xx. Other 4xx answers and
   * redirects are never retried. Defaults to 0 (send once). The wait doubles
   * after each attempt, starting at `retryDelayMs`, with jitter, and a
   * `Retry-After` header is honored. `timeoutMs` applies to each attempt, and
   * `log()` resolves only after the last one. Every attempt sends the same body,
   * and with `retries` above 0 the body always carries an `id`, so the receiver
   * can drop a repeat if an earlier attempt did arrive.
   */
  retries?: number;
  /** Wait before the first retry, in milliseconds. Defaults to 500. */
  retryDelayMs?: number;
  /** Longest wait between attempts, in milliseconds. Defaults to 30000. */
  maxRetryDelayMs?: number;
  /**
   * Shared secret for signing each request, so the receiver can verify the
   * entry came from you and was not altered. Adds `X-Signature-Timestamp`
   * (Unix seconds) and `X-Signature-256` (`sha256=` and the hex HMAC-SHA256 of
   * `<timestamp>.<body>`). The receiver should recompute it and reject old
   * timestamps. Needs Web Crypto (Node 20+, browsers, Deno, Bun); without it
   * `log()` fails rather than sending an unsigned entry.
   */
  signingSecret?: string;
}

const DEFAULT_RETRY_DELAY_MS = 500;
const DEFAULT_MAX_RETRY_DELAY_MS = 30_000;
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 425, 429]);

/** What one attempt came to. */
type Attempt =
  | { ok: true }
  | { ok: false; reason: string; retryable: boolean; retryAfterMs?: number };

/** The parts of Web Crypto used for signing. */
interface SubtleLike {
  importKey(
    format: 'raw',
    keyData: Uint8Array,
    algorithm: { name: 'HMAC'; hash: 'SHA-256' },
    extractable: boolean,
    usages: string[]
  ): Promise<unknown>;
  sign(algorithm: 'HMAC', key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
}

/** Signing could not be done at all, as opposed to the webhook failing. */
class SigningUnavailableError extends Error {}

/** Hex HMAC-SHA256 of `message`. @throws {SigningUnavailableError} when Web Crypto is missing. */
async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const subtle: SubtleLike | undefined = (
    globalThis as { crypto?: { subtle?: SubtleLike } }
  ).crypto?.subtle;
  if (subtle === undefined) {
    throw new SigningUnavailableError(
      'signingSecret needs Web Crypto (crypto.subtle), which this runtime does not provide, so the entry was not sent unsigned'
    );
  }
  const encoder = new TextEncoder();
  const key: unknown = await subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature: ArrayBuffer = await subtle.sign(
    'HMAC',
    key,
    encoder.encode(message)
  );
  return Array.from(new Uint8Array(signature), (byte: number): string =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}

/** Reads `Retry-After` (seconds or an HTTP date) as milliseconds, or undefined. */
function parseRetryAfterMs(
  value: string | null | undefined
): number | undefined {
  if (value === null || value === undefined || value.trim() === '') {
    return undefined;
  }
  const seconds: number = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const date: number = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function validateRetryOptions(options: WebhookErrorOptions): {
  retries: number;
  retryDelayMs: number;
  maxRetryDelayMs: number;
} {
  const retries: number = options.retries ?? 0;
  if (!Number.isInteger(retries) || retries < 0) {
    throw new RangeError(
      `WebhookErrorAdapter: retries must be a whole number of 0 or more, received ${String(options.retries)}.`
    );
  }
  const retryDelayMs: number = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  if (!Number.isFinite(retryDelayMs) || retryDelayMs <= 0) {
    throw new RangeError(
      `WebhookErrorAdapter: retryDelayMs must be a positive number, received ${String(options.retryDelayMs)}.`
    );
  }
  const maxRetryDelayMs: number =
    options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  if (!Number.isFinite(maxRetryDelayMs) || maxRetryDelayMs < retryDelayMs) {
    throw new RangeError(
      `WebhookErrorAdapter: maxRetryDelayMs must be a number no smaller than retryDelayMs (${retryDelayMs}), received ${String(options.maxRetryDelayMs)}.`
    );
  }
  if (options.signingSecret === '') {
    throw new RangeError(
      'WebhookErrorAdapter: signingSecret must not be empty; leave it out to send unsigned.'
    );
  }
  return { retries, retryDelayMs, maxRetryDelayMs };
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve: () => void): void => {
    setTimeout(resolve, ms);
  });
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
]);

/** Parses the URL, and rejects one that is invalid or would send entries unencrypted. */
function parseWebhookUrl(url: string, allowInsecure: boolean): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new RangeError(
      'WebhookErrorAdapter: the webhook URL is not a valid absolute URL (for example https://example.com/errors).'
    );
  }
  if (parsed.protocol === 'https:') {
    return parsed;
  }
  if (
    parsed.protocol === 'http:' &&
    (allowInsecure || LOOPBACK_HOSTS.has(parsed.hostname))
  ) {
    return parsed;
  }
  throw new RangeError(
    `WebhookErrorAdapter: the webhook URL must use https:// because entries contain error messages and stack traces (received ${parsed.protocol}//${parsed.host}). Pass allowInsecure: true to send over http.`
  );
}

export class WebhookErrorAdapter<
  TCode extends string = string,
> implements ErrorLogAdapter<TCode> {
  private readonly prefix: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  /** Scheme and host only. Webhook URLs often carry a secret in the path or query. */
  private readonly target: string;

  /** @throws {RangeError} if `url` is not a valid `https://` URL (see `allowInsecure`) or a timeout, retry or signing option is invalid. */
  constructor(
    private readonly url: string,
    private readonly options: WebhookErrorOptions = {}
  ) {
    this.prefix = options.prefix ?? DEFAULT_PREFIX;
    this.timeoutMs = resolveTimeoutMs(options.timeoutMs, 'WebhookErrorAdapter');
    ({
      retries: this.retries,
      retryDelayMs: this.retryDelayMs,
      maxRetryDelayMs: this.maxRetryDelayMs,
    } = validateRetryOptions(options));
    this.target = parseWebhookUrl(url, options.allowInsecure ?? false).origin;
  }

  async log(entry: ErrorLogEntry<TCode>): Promise<ErrorLogResult> {
    let body: string;
    try {
      // A caller-supplied id goes along so the receiver can drop a repeat; a
      // retry can repeat too, so it gets one as well.
      body = JSON.stringify(
        hasCallerId(entry) || this.retries > 0
          ? { id: resolveEntryId(entry), ...serializeEntry(entry) }
          : serializeEntry(entry)
      );
    } catch (error: unknown) {
      console.error(`${this.prefix} WebhookErrorAdapter:`, error);
      return this.fail(
        `could not prepare the entry: ${this.redact(describeError(error))}`
      );
    }

    return this.deliver(body);
  }

  /**
   * Sends several entries in one request, as a JSON array of the same records
   * `log` sends one at a time (each with an `id`). `BatchingErrorAdapter` uses
   * this when it wraps a webhook, so the receiver must accept an array. The
   * whole request succeeds or fails together.
   */
  async logBatch(entries: ErrorLogEntry<TCode>[]): Promise<ErrorLogResult> {
    if (entries.length === 0) {
      return { ok: true };
    }
    let body: string;
    try {
      body = JSON.stringify(
        entries.map((entry: ErrorLogEntry<TCode>) => ({
          id: resolveEntryId(entry),
          ...serializeEntry(entry),
        }))
      );
    } catch (error: unknown) {
      console.error(`${this.prefix} WebhookErrorAdapter:`, error);
      return this.fail(
        `could not prepare the entries: ${this.redact(describeError(error))}`
      );
    }
    return this.deliver(body);
  }

  /** Sends one prepared body, trying again as `retries` allows. */
  private async deliver(body: string): Promise<ErrorLogResult> {
    let attempt: Attempt = await this.send(body);
    let attempts = 1;
    while (!attempt.ok && attempt.retryable && attempts <= this.retries) {
      await sleep(this.retryWaitMs(attempts, attempt.retryAfterMs));
      attempt = await this.send(body);
      attempts += 1;
    }
    if (attempt.ok) {
      return { ok: true };
    }
    return this.fail(
      attempts > 1
        ? `${attempt.reason} (after ${attempts} attempts)`
        : attempt.reason
    );
  }

  /** Milliseconds to wait before retry number `retryNumber` (1 for the first). */
  private retryWaitMs(retryNumber: number, retryAfterMs?: number): number {
    if (retryAfterMs !== undefined) {
      return Math.min(retryAfterMs, this.maxRetryDelayMs);
    }
    return backoffDelayMs(retryNumber, this.retryDelayMs, this.maxRetryDelayMs);
  }

  private async send(body: string): Promise<Attempt> {
    const controller: AbortController = new AbortController();
    let timedOut = false;
    const timer: ReturnType<typeof setTimeout> | undefined =
      this.timeoutMs === Infinity
        ? undefined
        : setTimeout((): void => {
            timedOut = true;
            controller.abort();
          }, this.timeoutMs);
    try {
      const response: Response = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.options.headers,
          ...(await this.signatureHeaders(body)),
        },
        body,
        // A redirect would turn the POST into a GET without a body (302, 303)
        // or re-send the entry and headers to another host (307, 308).
        redirect: 'manual',
        signal: controller.signal,
      });
      if (response.type === 'opaqueredirect') {
        return this.rejected(this.redirectMessage('a redirect'));
      }
      if (!response.ok) {
        if (response.status >= 300 && response.status < 400) {
          return this.rejected(this.redirectMessage(`HTTP ${response.status}`));
        }
        return {
          ok: false,
          reason: `webhook ${this.target} responded with HTTP ${response.status}`,
          retryable:
            response.status >= 500 || RETRYABLE_STATUSES.has(response.status),
          retryAfterMs: parseRetryAfterMs(response.headers?.get('retry-after')),
        };
      }
      return { ok: true };
    } catch (error: unknown) {
      console.error(`${this.prefix} WebhookErrorAdapter:`, error);
      if (error instanceof SigningUnavailableError) {
        // A missing Web Crypto will not appear on a second try.
        return this.rejected(error.message);
      }
      if (timedOut) {
        return {
          ok: false,
          reason: timeoutMessage(`webhook ${this.target}`, this.timeoutMs),
          retryable: true,
        };
      }
      return {
        ok: false,
        reason: `could not reach webhook ${this.target}: ${this.redact(describeError(error))}`,
        retryable: true,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Timestamp and signature headers, or none when no `signingSecret` is set. */
  private async signatureHeaders(
    body: string
  ): Promise<Record<string, string>> {
    const secret: string | undefined = this.options.signingSecret;
    if (secret === undefined) {
      return {};
    }
    const timestamp: string = String(Math.floor(Date.now() / 1000));
    const signature: string = await hmacSha256Hex(
      secret,
      `${timestamp}.${body}`
    );
    return {
      'X-Signature-Timestamp': timestamp,
      'X-Signature-256': `sha256=${signature}`,
    };
  }

  private rejected(reason: string): Attempt {
    return { ok: false, reason, retryable: false };
  }

  private redirectMessage(what: string): string {
    return `webhook ${this.target} responded with ${what}, which is not followed because the entry would not arrive intact; use the final URL instead`;
  }

  /** Replaces the full URL in a message with its origin, in case the runtime put it there. */
  private redact(message: string): string {
    return message.split(this.url).join(this.target);
  }

  private fail(reason: string): ErrorLogResult {
    return { ok: false, error: `WebhookErrorAdapter failed: ${reason}` };
  }
}
