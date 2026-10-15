import { describeError, serializeEntry } from '../serialize.js';
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
  /** Scheme and host only. Webhook URLs often carry a secret in the path or query. */
  private readonly target: string;

  /** @throws {RangeError} if `url` is not a valid `https://` URL (see `allowInsecure`). */
  constructor(
    private readonly url: string,
    private readonly options: WebhookErrorOptions = {}
  ) {
    this.prefix = options.prefix ?? '[error-log-adapter]';
    this.target = parseWebhookUrl(url, options.allowInsecure ?? false).origin;
  }

  async log(entry: ErrorLogEntry<TCode>): Promise<ErrorLogResult> {
    try {
      const response: Response = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.options.headers,
        },
        body: JSON.stringify(serializeEntry(entry)),
        // A redirect would turn the POST into a GET without a body (302, 303)
        // or re-send the entry and headers to another host (307, 308).
        redirect: 'manual',
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
      return this.fail(
        `could not reach webhook ${this.target}: ${this.redact(describeError(error))}`
      );
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
