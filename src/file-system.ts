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

/** Returns the folder part of a path, or `null` if the path has none. */
export function parentDirectory(filePath: string): string | null {
  const lastSeparator: number = Math.max(
    filePath.lastIndexOf('/'),
    filePath.lastIndexOf('\\')
  );
  if (lastSeparator < 0) {
    return null;
  }
  return lastSeparator === 0 ? '/' : filePath.slice(0, lastSeparator);
}

/** True for the error Node throws when a file or folder does not exist. */
export function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}
