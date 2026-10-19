import { SerialQueue } from '../queue.js';
import { DEFAULT_PREFIX, reportFailure } from '../fail.js';
import {
  DEFAULT_MAX_FILES,
  assertPositiveInteger,
  rotateIfNeeded,
} from '../file-rotation.js';
import { loadNodeFileSystem, parentDirectory } from '../file-system.js';
import type { FileSystemLike } from '../file-system.js';
import { serializeEntry } from '../serialize.js';
import type { SerializedErrorLogEntry } from '../serialize.js';
import type {
  ErrorLogAdapter,
  ErrorLogEntry,
  ErrorLogResult,
} from '../types.js';

export { DEFAULT_MAX_FILES };

export interface FlatFileErrorOptions {
  /** File system to write to. Defaults to `node:fs/promises`, loaded on first use. */
  fs?: FileSystemLike;
  /** Turns an entry into one line of text. Defaults to `formatErrorLogLine`. */
  formatLine?: (entry: SerializedErrorLogEntry) => string;
  /** Rotate the file before it would grow past this many bytes. Off by default. */
  maxBytes?: number;
  /** Rotated files to keep (`app.log.1` is newest). Defaults to `3`. Needs `maxBytes`. */
  maxFiles?: number;
  /** Create missing parent directories on first use. Defaults to `true`. */
  createDirectory?: boolean;
  /** Text printed before failure messages. Defaults to `[error-log-adapter]`. */
  prefix?: string;
}

/** Keeps one entry on one line by escaping line breaks. */
function escapeLineBreaks(text: string): string {
  return text.replace(/\r?\n/g, '\\n');
}

function describeCause(cause: unknown): string {
  if (typeof cause === 'string') {
    return cause;
  }
  if (typeof cause === 'object' && cause !== null) {
    const { name, message } = cause as { name?: unknown; message?: unknown };
    if (typeof name === 'string' && typeof message === 'string') {
      return `${name}: ${message}`;
    }
  }
  try {
    return JSON.stringify(cause) ?? String(cause);
  } catch {
    return String(cause);
  }
}

/**
 * The default line format:
 * `2026-01-02T03:04:05.000Z [CODE] source: message (cause: Error: details)`.
 * `source` and `cause` are left out when the entry has none.
 */
export function formatErrorLogLine(entry: SerializedErrorLogEntry): string {
  const source: string = entry.source === undefined ? '' : `${entry.source}: `;
  const cause: string =
    entry.cause === undefined ? '' : ` (cause: ${describeCause(entry.cause)})`;
  return escapeLineBreaks(
    `${entry.timestamp} [${entry.code}] ${source}${entry.message}${cause}`
  );
}

/**
 * Appends one text line per entry to a file, optionally rotating it by size.
 * Writes are queued, so concurrent `log` calls never interleave or race a rotation.
 */
export class FlatFileErrorAdapter<
  TCode extends string = string,
> implements ErrorLogAdapter<TCode> {
  private readonly formatLine: (entry: SerializedErrorLogEntry) => string;
  private readonly maxBytes: number | undefined;
  private readonly maxFiles: number;
  private readonly createDirectory: boolean;
  private readonly prefix: string;
  private fs: FileSystemLike | undefined;
  private directoryReady: boolean = false;
  private readonly queue: SerialQueue = new SerialQueue();

  /** @throws {RangeError} if `maxBytes` or `maxFiles` is not a positive integer. */
  constructor(
    private readonly filePath: string,
    options: FlatFileErrorOptions = {}
  ) {
    this.fs = options.fs;
    this.formatLine = options.formatLine ?? formatErrorLogLine;
    this.maxBytes = options.maxBytes;
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.createDirectory = options.createDirectory ?? true;
    this.prefix = options.prefix ?? DEFAULT_PREFIX;
    if (this.maxBytes !== undefined) {
      assertPositiveInteger('FlatFileErrorAdapter', this.maxBytes, 'maxBytes');
    }
    assertPositiveInteger('FlatFileErrorAdapter', this.maxFiles, 'maxFiles');
  }

  log(entry: ErrorLogEntry<TCode>): Promise<ErrorLogResult> {
    return this.queue.run((): Promise<ErrorLogResult> => this.write(entry));
  }

  private async write(entry: ErrorLogEntry<TCode>): Promise<ErrorLogResult> {
    try {
      const fs: FileSystemLike = await this.getFileSystem();
      const formatted: string = this.formatLine(serializeEntry(entry));
      const line: string = formatted.endsWith('\n')
        ? formatted
        : `${formatted}\n`;
      await this.prepareDirectory(fs);
      if (this.maxBytes !== undefined) {
        await rotateIfNeeded(
          fs,
          this.filePath,
          new TextEncoder().encode(line).length,
          { maxBytes: this.maxBytes, maxFiles: this.maxFiles },
          { adapterName: 'FlatFileErrorAdapter', prefix: this.prefix }
        );
      }
      await fs.appendFile(this.filePath, line);
      return { ok: true };
    } catch (error: unknown) {
      return reportFailure({
        adapterName: 'FlatFileErrorAdapter',
        prefix: this.prefix,
        action: `to append to "${this.filePath}"`,
        error,
      });
    }
  }

  /** Uses the injected file system, or loads `node:fs/promises` on first use. */
  private async getFileSystem(): Promise<FileSystemLike> {
    if (this.fs === undefined) {
      this.fs = await loadNodeFileSystem();
    }
    return this.fs;
  }

  private async prepareDirectory(fs: FileSystemLike): Promise<void> {
    if (!this.createDirectory || this.directoryReady) {
      return;
    }
    const directory: string | null = parentDirectory(this.filePath);
    if (directory !== null) {
      await fs.mkdir(directory, { recursive: true });
    }
    this.directoryReady = true;
  }
}
