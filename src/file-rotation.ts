import { isMissingFileError } from './file-system.js';
import type { FileSystemLike } from './file-system.js';
import { describeError } from './serialize.js';

/** Default number of rotated files kept when `maxBytes` is set. */
export const DEFAULT_MAX_FILES = 3;

export interface RotationSettings {
  /** Rotate the file before it would grow past this many bytes. */
  maxBytes: number;
  /** Rotated files to keep (`app.log.1` is newest). */
  maxFiles: number;
}

/** @throws {RangeError} unless `value` is a whole number of 1 or more. */
export function assertPositiveInteger(
  adapterName: string,
  value: number,
  name: string
): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(
      `${adapterName}: ${name} must be a positive integer, received ${String(value)}.`
    );
  }
}

async function renameIfPresent(
  fs: FileSystemLike,
  from: string,
  to: string
): Promise<void> {
  try {
    await fs.rename(from, to);
  } catch (error: unknown) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

/**
 * Moves `app.log` to `app.log.1` (shifting older files up, dropping the
 * oldest) when the next write of `writeBytes` would push it past `maxBytes`. A
 * failed rotation is reported to the console, but nothing is thrown, so the
 * caller can still write the entry and not lose it.
 *
 * The caller must make sure no other write to the file runs at the same time
 * (both file adapters queue their writes).
 */
export async function rotateIfNeeded(
  fs: FileSystemLike,
  filePath: string,
  writeBytes: number,
  settings: RotationSettings,
  report: { adapterName: string; prefix: string }
): Promise<void> {
  try {
    let currentSize: number;
    try {
      currentSize = (await fs.stat(filePath)).size;
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return;
      }
      throw error;
    }
    if (currentSize === 0 || currentSize + writeBytes <= settings.maxBytes) {
      return;
    }
    await fs.rm(`${filePath}.${settings.maxFiles}`, { force: true });
    for (let index = settings.maxFiles - 1; index >= 1; index -= 1) {
      await renameIfPresent(
        fs,
        `${filePath}.${index}`,
        `${filePath}.${index + 1}`
      );
    }
    await fs.rename(filePath, `${filePath}.1`);
  } catch (error: unknown) {
    console.error(
      `${report.prefix} ${report.adapterName}: could not rotate "${filePath}", so it will keep growing: ${describeError(error)}`
    );
  }
}
