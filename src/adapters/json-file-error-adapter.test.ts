import * as realFs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ReadWriteFileSystemLike } from '../file-system.js';
import type { ErrorLogEntry } from '../types.js';
import { JsonFileErrorAdapter } from './json-file-error-adapter.js';
import type { JsonFileErrorRecord } from './json-file-error-adapter.js';

const TIMESTAMP = '2026-01-02T03:04:05.000Z';

function entry(message: string): ErrorLogEntry {
  return { code: 'E', message, timestamp: TIMESTAMP };
}

function enoent(path: string): Error {
  return Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
}

/** In-memory file system that fails like Node does for missing files. */
class FakeFileSystem implements ReadWriteFileSystemLike {
  readonly files = new Map<string, string>();
  readonly directories: string[] = [];
  failWrite: Error | null = null;

  async appendFile(path: string, data: string): Promise<void> {
    if (this.failWrite !== null) {
      throw this.failWrite;
    }
    this.files.set(path, (this.files.get(path) ?? '') + data);
  }

  async writeFile(path: string, data: string): Promise<void> {
    if (this.failWrite !== null) {
      throw this.failWrite;
    }
    this.files.set(path, data);
  }

  async readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) {
      throw enoent(path);
    }
    return content;
  }

  async mkdir(path: string): Promise<void> {
    this.directories.push(path);
  }

  async stat(path: string): Promise<{ size: number }> {
    return { size: (await this.readFile(path)).length };
  }

  async rename(from: string, to: string): Promise<void> {
    this.files.set(to, await this.readFile(from));
    this.files.delete(from);
  }

  async rm(path: string): Promise<void> {
    this.files.delete(path);
  }

  json(path: string): JsonFileErrorRecord[] {
    return JSON.parse(this.files.get(path) ?? '[]') as JsonFileErrorRecord[];
  }
}

function silenceConsole() {
  return vi.spyOn(console, 'error').mockImplementation(() => {});
}

describe('JsonFileErrorAdapter (ndjson mode)', () => {
  it('appends one compact JSON object per line with a UUID id', async () => {
    const fs = new FakeFileSystem();
    const adapter = new JsonFileErrorAdapter('/var/log/app/errors.ndjson', {
      fs,
    });

    expect(
      await adapter.log({
        ...entry('first\nsecond'),
        source: 'app',
        cause: new Error('x'),
      })
    ).toEqual({ ok: true });
    await adapter.log(entry('two'));

    const lines = (fs.files.get('/var/log/app/errors.ndjson') ?? '')
      .trimEnd()
      .split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0] ?? '') as JsonFileErrorRecord;
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(first).toMatchObject({
      code: 'E',
      message: 'first\nsecond',
      source: 'app',
      timestamp: TIMESTAMP,
      cause: { name: 'Error', message: 'x' },
    });
    expect(fs.directories).toEqual(['/var/log/app']);
  });

  it('keeps every line when many entries are logged at once', async () => {
    const fs = new FakeFileSystem();
    const adapter = new JsonFileErrorAdapter('/l/e.ndjson', { fs });

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => adapter.log(entry(`m${i}`)))
    );

    expect(results.every((r) => r.ok)).toBe(true);
    const messages = (fs.files.get('/l/e.ndjson') ?? '')
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as JsonFileErrorRecord).message);
    expect(messages).toEqual(Array.from({ length: 20 }, (_, i) => `m${i}`));
  });

  it('returns a failure result and keeps working after a write fails', async () => {
    const fs = new FakeFileSystem();
    fs.failWrite = new Error('EACCES: permission denied');
    const spy = silenceConsole();
    const adapter = new JsonFileErrorAdapter('/l/e.ndjson', {
      fs,
      prefix: '[my-app]',
    });

    const failed = await adapter.log(entry('a'));
    fs.failWrite = null;
    const recovered = await adapter.log(entry('b'));

    expect(failed.ok).toBe(false);
    expect(failed.error).toContain('permission denied');
    expect(failed.error).toContain('"/l/e.ndjson"');
    expect(failed.error).toContain('ndjson mode');
    expect(spy).toHaveBeenCalledWith(
      '[my-app] JsonFileErrorAdapter:',
      expect.any(Error)
    );
    expect(recovered).toEqual({ ok: true });
    spy.mockRestore();
  });

  it('returns a failure result, without touching the file, if the cause cannot be serialized', async () => {
    const fs = new FakeFileSystem();
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const spy = silenceConsole();

    const result = await new JsonFileErrorAdapter('/l/e.ndjson', { fs }).log({
      ...entry('x'),
      cause: circular,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('circular');
    expect(fs.files.size).toBe(0);
    spy.mockRestore();
  });

  it('skips mkdir for a bare file name or when createDirectory is false', async () => {
    const bare = new FakeFileSystem();
    await new JsonFileErrorAdapter('errors.ndjson', { fs: bare }).log(
      entry('a')
    );
    const disabled = new FakeFileSystem();
    await new JsonFileErrorAdapter('/logs/errors.ndjson', {
      fs: disabled,
      createDirectory: false,
    }).log(entry('a'));

    expect(bare.directories).toEqual([]);
    expect(disabled.directories).toEqual([]);
  });
});

describe('JsonFileErrorAdapter (array mode)', () => {
  const PATH = '/l/errors.json';

  it('creates the file as an indented JSON array and appends to it', async () => {
    const fs = new FakeFileSystem();
    const adapter = new JsonFileErrorAdapter(PATH, { fs, mode: 'array' });

    await adapter.log(entry('one'));
    await adapter.log(entry('two'));

    expect(fs.json(PATH).map((r) => r.message)).toEqual(['one', 'two']);
    expect(fs.files.get(PATH)).toContain('\n  {\n    "id"');
    expect(fs.files.get(PATH)?.endsWith('\n')).toBe(true);
    expect(fs.files.has(`${PATH}.tmp`)).toBe(false);
  });

  it('writes compact output when indent is 0', async () => {
    const fs = new FakeFileSystem();

    await new JsonFileErrorAdapter(PATH, {
      fs,
      mode: 'array',
      indent: 0,
    }).log(entry('one'));

    expect(fs.files.get(PATH)?.trimEnd()).not.toContain('\n');
  });

  it('keeps only the newest maxEntries records', async () => {
    const fs = new FakeFileSystem();
    const adapter = new JsonFileErrorAdapter(PATH, {
      fs,
      mode: 'array',
      maxEntries: 2,
    });

    for (const message of ['one', 'two', 'three']) {
      await adapter.log(entry(message));
    }

    expect(fs.json(PATH).map((r) => r.message)).toEqual(['two', 'three']);
  });

  it('keeps every record when many entries are logged at once', async () => {
    const fs = new FakeFileSystem();
    const adapter = new JsonFileErrorAdapter(PATH, { fs, mode: 'array' });

    await Promise.all(
      Array.from({ length: 15 }, (_, i) => adapter.log(entry(`m${i}`)))
    );

    expect(fs.json(PATH).map((r) => r.message)).toEqual(
      Array.from({ length: 15 }, (_, i) => `m${i}`)
    );
  });

  it('treats an empty file as an empty array', async () => {
    const fs = new FakeFileSystem();
    fs.files.set(PATH, '  \n');

    const result = await new JsonFileErrorAdapter(PATH, {
      fs,
      mode: 'array',
    }).log(entry('one'));

    expect(result).toEqual({ ok: true });
    expect(fs.json(PATH)).toHaveLength(1);
  });

  it.each([
    ['invalid JSON', 'not json'],
    ['a non-array value', '{"a":1}'],
  ])(
    'moves a file with %s to .corrupt instead of losing it, then keeps logging',
    async (_label: string, content: string) => {
      const fs = new FakeFileSystem();
      fs.files.set(PATH, content);
      const spy = silenceConsole();

      const result = await new JsonFileErrorAdapter(PATH, {
        fs,
        mode: 'array',
      }).log(entry('fresh'));

      expect(result).toEqual({ ok: true });
      expect(fs.files.get(`${PATH}.corrupt`)).toBe(content);
      expect(fs.json(PATH).map((r) => r.message)).toEqual(['fresh']);
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining(`moved to "${PATH}.corrupt"`)
      );
      spy.mockRestore();
    }
  );

  it('leaves the existing file untouched if the replacement cannot be written', async () => {
    const fs = new FakeFileSystem();
    const adapter = new JsonFileErrorAdapter(PATH, { fs, mode: 'array' });
    await adapter.log(entry('one'));
    const before = fs.files.get(PATH);
    fs.failWrite = new Error('ENOSPC: no space left on device');
    const spy = silenceConsole();

    const result = await adapter.log(entry('two'));

    expect(result.ok).toBe(false);
    expect(result.error).toContain('no space left');
    expect(result.error).toContain('array mode');
    expect(fs.files.get(PATH)).toBe(before);
    spy.mockRestore();
  });
});

describe('JsonFileErrorAdapter options', () => {
  const fs = new FakeFileSystem();

  it('rejects maxEntries outside array mode', () => {
    expect(
      () => new JsonFileErrorAdapter('/l/e.json', { fs, maxEntries: 5 })
    ).toThrowError(/maxEntries only applies to mode "array"/);
  });

  it.each([0, -1, 1.5])('rejects maxEntries of %s', (maxEntries: number) => {
    expect(
      () =>
        new JsonFileErrorAdapter('/l/e.json', {
          fs,
          mode: 'array',
          maxEntries,
        })
    ).toThrowError(/maxEntries must be a positive integer/);
  });

  it.each([-1, 1.5])('rejects indent of %s', (indent: number) => {
    expect(
      () => new JsonFileErrorAdapter('/l/e.json', { fs, mode: 'array', indent })
    ).toThrowError(/indent must be a non-negative integer/);
  });

  it('accepts node:fs/promises as the file system', () => {
    const real: ReadWriteFileSystemLike = realFs;

    expect(
      () => new JsonFileErrorAdapter('/l/e.json', { fs: real })
    ).not.toThrow();
  });
});

describe('JsonFileErrorAdapter with the real file system', () => {
  it('writes both modes to disk, creating folders', async () => {
    const directory = await realFs.mkdtemp(
      join(tmpdir(), 'error-log-adapter-')
    );
    try {
      const ndjsonPath = join(directory, 'a', 'errors.ndjson');
      const arrayPath = join(directory, 'b', 'errors.json');
      const ndjson = new JsonFileErrorAdapter(ndjsonPath);
      const array = new JsonFileErrorAdapter(arrayPath, {
        mode: 'array',
        maxEntries: 2,
      });

      for (const message of ['one', 'two', 'three']) {
        expect(await ndjson.log(entry(message))).toEqual({ ok: true });
        expect(await array.log(entry(message))).toEqual({ ok: true });
      }

      const lines = (await realFs.readFile(ndjsonPath, 'utf8'))
        .trim()
        .split('\n');
      expect(
        lines.map((l) => (JSON.parse(l) as JsonFileErrorRecord).message)
      ).toEqual(['one', 'two', 'three']);
      const stored = JSON.parse(
        await realFs.readFile(arrayPath, 'utf8')
      ) as JsonFileErrorRecord[];
      expect(stored.map((r) => r.message)).toEqual(['two', 'three']);
      expect(await realFs.readdir(join(directory, 'b'))).toEqual([
        'errors.json',
      ]);
    } finally {
      await realFs.rm(directory, { recursive: true, force: true });
    }
  });
});
