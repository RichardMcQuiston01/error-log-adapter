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
}

export class WebhookErrorAdapter<
  TCode extends string = string,
> implements ErrorLogAdapter<TCode> {
  private readonly prefix: string;

  constructor(
    private readonly url: string,
    private readonly options: WebhookErrorOptions = {}
  ) {
    this.prefix = options.prefix ?? '[error-log-adapter]';
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
      });
      if (!response.ok) {
        return this.fail(
          `webhook ${this.url} responded with HTTP ${response.status}`
        );
      }
      return { ok: true };
    } catch (error: unknown) {
      console.error(`${this.prefix} WebhookErrorAdapter:`, error);
      return this.fail(
        `could not reach webhook ${this.url}: ${describeError(error)}`
      );
    }
  }

  private fail(reason: string): ErrorLogResult {
    return { ok: false, error: `WebhookErrorAdapter failed: ${reason}` };
  }
}
