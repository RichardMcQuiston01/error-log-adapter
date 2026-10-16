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
  /** Scheme and host only. Webhook URLs often carry a secret in the path or query. */
  private readonly target: string;

  /** @throws {RangeError} if `url` is not a valid `https://` URL (see `allowInsecure`) or `timeoutMs` is invalid. */
  constructor(
    private readonly url: string,
    private readonly options: WebhookErrorOptions = {}
  ) {
    this.prefix = options.prefix ?? DEFAULT_PREFIX;
    this.timeoutMs = resolveTimeoutMs(options.timeoutMs, 'WebhookErrorAdapter');
    this.target = parseWebhookUrl(url, options.allowInsecure ?? false).origin;
  }

  async log(entry: ErrorLogEntry<TCode>): Promise<ErrorLogResult> {
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
        },
        // A caller-supplied id goes along so the receiver can drop a repeat.
        body: JSON.stringify(
          hasCallerId(entry)
            ? { id: resolveEntryId(entry), ...serializeEntry(entry) }
            : serializeEntry(entry)
        ),
        // A redirect would turn the POST into a GET without a body (302, 303)
        // or re-send the entry and headers to another host (307, 308).
        redirect: 'manual',
        signal: controller.signal,
      });
      if (response.type === 'opaqueredirect') {
        return this.fail(this.redirectMessage('a redirect'));
      }
      if (!response.ok) {
        if (response.status >= 300 && response.status < 400) {
          return this.fail(this.redirectMessage(`HTTP ${response.status}`));
        }
        return this.fail(
          `webhook ${this.target} responded with HTTP ${response.status}`
        );
      }
      return { ok: true };
    } catch (error: unknown) {
      console.error(`${this.prefix} WebhookErrorAdapter:`, error);
      if (timedOut) {
        return this.fail(
          timeoutMessage(`webhook ${this.target}`, this.timeoutMs)
        );
      }
      return this.fail(
        `could not reach webhook ${this.target}: ${this.redact(describeError(error))}`
      );
    } finally {
      clearTimeout(timer);
    }
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
