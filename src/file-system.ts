/**
 * The subset of `node:fs/promises` the file adapters use. Pass `fs.promises`
 * (or `node:fs/promises`) yourself, or leave `fs` unset in Node and Bun.
 */
export interface FileSystemLike {
  appendFile(path: string, data: string): Promise<unknown>;
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  stat(path: string): Promise<{ size: number }>;
  rename(from: string, to: string): Promise<unknown>;
  rm(path: string, options: { force: true }): Promise<unknown>;
}

/** `FileSystemLike` plus the reading and replacing that whole-file writes need. */
export interface ReadWriteFileSystemLike extends FileSystemLike {
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  writeFile(path: string, data: string): Promise<unknown>;
}

/** Loads `node:fs/promises`. Only call this from code that runs in Node or Bun. */
export async function loadNodeFileSystem(): Promise<ReadWriteFileSystemLike> {
  // A variable specifier keeps browser bundlers from resolving it.
  const moduleName: string = 'node:fs/promises';
  return (await import(moduleName)) as ReadWriteFileSystemLike;
}

/** A filesystem root: `/`, `\\`, `C:\\` or `C:/`, which always exists and cannot be created. */
const ROOT_PATTERN: RegExp = /^(?:[A-Za-z]:)?[\\/]+$/;

/**
 * Returns the folder to create for a file path, or `null` when there is nothing
 * to create: the path has no folder part (`app.log`), or its folder is a
 * filesystem root that always exists (`/app.log`, `C:\\app.log`, `\\app.log`).
 * Calling `mkdir` on a Windows drive root fails with `EPERM`.
 */
export function parentDirectory(filePath: string): string | null {
  const lastSeparator: number = Math.max(
    filePath.lastIndexOf('/'),
    filePath.lastIndexOf('\\')
  );
  if (lastSeparator < 0) {
    return null;
  }
  const directory: string = filePath.slice(0, lastSeparator + 1);
  if (ROOT_PATTERN.test(directory)) {
    return null;
  }
  return filePath.slice(0, lastSeparator);
}

/** True for the error Node throws when a file or folder does not exist. */
export function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}
