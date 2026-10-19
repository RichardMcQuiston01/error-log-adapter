import { SerialQueue } from '../queue.js';
import { DEFAULT_PREFIX, reportFailure } from '../fail.js';
import { resolveEntryId } from '../entry-id.js';
import {
  DEFAULT_MAX_FILES,
  assertPositiveInteger,
  rotateIfNeeded,
} from '../file-rotation.js';
import {
  isMissingFileError,
  loadNodeFileSystem,
  parentDirectory,
} from '../file-system.js';
import type { ReadWriteFileSystemLike } from '../file-system.js';
import { describeError, serializeEntry } from '../serialize.js';
import type { SerializedErrorLogEntry } from '../serialize.js';
import type {
  ErrorLogAdapter,
  ErrorLogEntry,
  ErrorLogResult,
} from '../types.js';

/** Default number of spaces used to indent array mode output. */
export const DEFAULT_INDENT = 2;

/** A stored record: the serialized entry plus its generated UUID. */
export interface JsonFileErrorRecord extends SerializedErrorLogEntry {
  id: string;
}

export interface JsonFileErrorOptions {
  /**
   * `ndjson` (default) appends one compact JSON object per line, which is cheap
   * and safe to tail. `array` keeps the whole file as one JSON array that is
   * rewritten on every entry.
   */
  mode?: 'ndjson' | 'array';
  /** Array mode only: most entries to keep. The oldest are dropped first. */
  maxEntries?: number;
  /**
   * NDJSON mode only: rotate the file before it would grow past this many
   * bytes, moving it to `<path>.1` (older files shift up). Off by default.
   */
  maxBytes?: number;
  /** NDJSON mode only: rotated files to keep (`errors.ndjson.1` is newest). Defaults to `3`. Needs `maxBytes`. */
  maxFiles?: number;
  /** Array mode only: spaces of indentation. Defaults to `2`; `0` is compact. */
  indent?: number;
  /** File system to write to. Defaults to `node:fs/promises`, loaded on first use. */
  fs?: ReadWriteFileSystemLike;
  /** Create missing parent directories on first use. Defaults to `true`. */
  createDirectory?: boolean;
  /** Text printed before failure messages. Defaults to `[error-log-adapter]`. */
  prefix?: string;
}

/**
 * Stores entries as JSON in a file (Node and Bun), either as newline-delimited
 * JSON or as one array. Writes are queued, so concurrent `log` calls stay in
 * order. Only one process should write to a given file.
 */
export class JsonFileErrorAdapter<
  TCode extends string = string,
> implements ErrorLogAdapter<TCode> {
  private readonly mode: 'ndjson' | 'array';
  private readonly maxEntries: number | undefined;
  private readonly maxBytes: number | undefined;
  private readonly maxFiles: number;
  private readonly indent: number;
  private readonly createDirectory: boolean;
  private readonly prefix: string;
  private fs: ReadWriteFileSystemLike | undefined;
  private directoryReady: boolean = false;
  private readonly queue: SerialQueue = new SerialQueue();

  /** @throws {RangeError} if `maxEntries`, `maxBytes`, `maxFiles` or `indent` is invalid, or an option is used in the wrong mode. */
  constructor(
    private readonly filePath: string,
    options: JsonFileErrorOptions = {}
  ) {
    this.mode = options.mode ?? 'ndjson';
    this.maxEntries = options.maxEntries;
    this.maxBytes = options.maxBytes;
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.indent = options.indent ?? DEFAULT_INDENT;
    this.fs = options.fs;
    this.createDirectory = options.createDirectory ?? true;
    this.prefix = options.prefix ?? DEFAULT_PREFIX;
    if (this.maxEntries !== undefined) {
      if (this.mode !== 'array') {
        throw new RangeError(
          `JsonFileErrorAdapter: maxEntries only applies to mode "array", but mode is "${this.mode}". Use mode "array" or remove maxEntries.`
        );
      }
      if (!Number.isInteger(this.maxEntries) || this.maxEntries < 1) {
        throw new RangeError(
          `JsonFileErrorAdapter: maxEntries must be a positive integer, received ${String(this.maxEntries)}.`
        );
      }
    }
    if (this.maxBytes !== undefined || options.maxFiles !== undefined) {
      if (this.mode !== 'ndjson') {
        throw new RangeError(
          `JsonFileErrorAdapter: maxBytes and maxFiles only apply to mode "ndjson", but mode is "${this.mode}". Use mode "ndjson", or use maxEntries to limit array mode.`
        );
      }
      if (this.maxBytes === undefined) {
        throw new RangeError(
          'JsonFileErrorAdapter: maxFiles needs maxBytes; set maxBytes to turn rotation on.'
        );
      }
      assertPositiveInteger('JsonFileErrorAdapter', this.maxBytes, 'maxBytes');
      assertPositiveInteger('JsonFileErrorAdapter', this.maxFiles, 'maxFiles');
    }
    if (!Number.isInteger(this.indent) || this.indent < 0) {
      throw new RangeError(
        `JsonFileErrorAdapter: indent must be a non-negative integer, received ${String(this.indent)}.`
      );
    }
  }

  log(entry: ErrorLogEntry<TCode>): Promise<ErrorLogResult> {
    return this.queue.run((): Promise<ErrorLogResult> => this.write(entry));
  }

  private async write(entry: ErrorLogEntry<TCode>): Promise<ErrorLogResult> {
    try {
      const record: JsonFileErrorRecord = {
        id: resolveEntryId(entry),
        ...serializeEntry(entry),
      };
      const fs: ReadWriteFileSystemLike = await this.getFileSystem();
      await this.prepareDirectory(fs);
      if (this.mode === 'ndjson') {
        const line: string = `${JSON.stringify(record)}\n`;
        if (this.maxBytes !== undefined) {
          await rotateIfNeeded(
            fs,
            this.filePath,
            new TextEncoder().encode(line).length,
            { maxBytes: this.maxBytes, maxFiles: this.maxFiles },
            { adapterName: 'JsonFileErrorAdapter', prefix: this.prefix }
          );
        }
        await fs.appendFile(this.filePath, line);
      } else {
        await this.rewriteArray(fs, record);
      }
      return { ok: true };
    } catch (error: unknown) {
      return reportFailure({
        adapterName: 'JsonFileErrorAdapter',
        prefix: this.prefix,
        action: `to write "${this.filePath}" in ${this.mode} mode`,
        error,
      });
    }
  }

  private async getFileSystem(): Promise<ReadWriteFileSystemLike> {
    if (this.fs === undefined) {
      this.fs = await loadNodeFileSystem();
    }
    return this.fs;
  }

  private async prepareDirectory(fs: ReadWriteFileSystemLike): Promise<void> {
    if (!this.createDirectory || this.directoryReady) {
      return;
    }
    const directory: string | null = parentDirectory(this.filePath);
    if (directory !== null) {
      await fs.mkdir(directory, { recursive: true });
    }
    this.directoryReady = true;
  }

  /**
   * Adds the record to the array and replaces the file. The new content is
   * written to a temporary file first and renamed into place, so a crash
   * mid-write cannot leave a half-written file.
   */
  private async rewriteArray(
    fs: ReadWriteFileSystemLike,
    record: JsonFileErrorRecord
  ): Promise<void> {
    // An entry logged again with the same id replaces its earlier record.
    const records: JsonFileErrorRecord[] = [
      ...(await this.readRecords(fs)).filter(
        (existing: JsonFileErrorRecord): boolean => existing?.id !== record.id
      ),
      record,
    ];
    const kept: JsonFileErrorRecord[] =
      this.maxEntries === undefined ? records : records.slice(-this.maxEntries);
    const temporaryPath: string = `${this.filePath}.tmp`;
    await fs.writeFile(
      temporaryPath,
      `${JSON.stringify(kept, null, this.indent)}\n`
    );
    await fs.rename(temporaryPath, this.filePath);
  }

  /**
   * Returns the records already in the file. A missing or empty file has none.
   * A file that is not a JSON array is moved to `<path>.corrupt` (so nothing is
   * lost) and logging continues with a fresh file.
   */
  private async readRecords(
    fs: ReadWriteFileSystemLike
  ): Promise<JsonFileErrorRecord[]> {
    let content: string;
    try {
      content = await fs.readFile(this.filePath, 'utf8');
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return [];
      }
      throw error;
    }
    if (content.trim() === '') {
      return [];
    }
    let problem: string;
    try {
      const parsed: unknown = JSON.parse(content);
      if (Array.isArray(parsed)) {
        return parsed as JsonFileErrorRecord[];
      }
      problem = 'did not hold a JSON array';
    } catch (error: unknown) {
      problem = `held invalid JSON (${describeError(error)})`;
    }
    const corruptPath: string = `${this.filePath}.corrupt`;
    await fs.rename(this.filePath, corruptPath);
    console.error(
      `${this.prefix} JsonFileErrorAdapter: "${this.filePath}" ${problem}, so it was moved to "${corruptPath}" and a new file was started.`
    );
    return [];
  }
}
