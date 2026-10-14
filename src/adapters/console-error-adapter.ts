import type {
  ErrorLogAdapter,
  ErrorLogEntry,
  ErrorLogResult,
} from '../types.js';

export interface ConsoleErrorOptions {
  /** Text printed before each entry. Defaults to `[error-log-adapter]`. */
  prefix?: string;
}

export class ConsoleErrorAdapter<
  TCode extends string = string,
> implements ErrorLogAdapter<TCode> {
  private readonly prefix: string;

  constructor(options: ConsoleErrorOptions = {}) {
    this.prefix = options.prefix ?? '[error-log-adapter]';
  }

  async log(entry: ErrorLogEntry<TCode>): Promise<ErrorLogResult> {
    try {
      console.error(this.prefix, entry);
      return { ok: true };
    } catch (error: unknown) {
      return {
        ok: false,
        error: `ConsoleErrorAdapter failed: ${String(error)}`,
      };
    }
  }
}
