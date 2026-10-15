import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ErrorLogEntry } from '../types.js';
import {
  FlatFileErrorAdapter,
  formatErrorLogLine,
} from './flat-file-error-adapter.js';
import type { FileSystemLike } from '../file-system.js';

const TIMESTAMP = '2026-01-02T03:04:05.000Z';

function entry(message: string): ErrorLogEntry {
  return { code: 'E', message, timestamp: TIMESTAMP };
}

/** In-memory file system that fails like Node does for missing files. */
class FakeFileSystem implements FileSystemLike {
  readonly files = new Map<string, string>();
  readonly directories: string[] = [];
  failAppend: Error | null = null;
  failRename: Error | null = null;

  async appendFile(path: string, data: string): Promise<void> {
    if (this.failAppend !== null) {
      throw this.failAppend;
    }
    this.files.set(path, (this.files.get(path) ?? '') + data);
  }

  async mkdir(path: string): Promise<void> {
    this.directories.push(path);
  }

  async stat(path: string): Promise<{ size: number }> {
    const content = this.files.get(path);
    if (content === undefined) {
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    }
    return { size: new TextEncoder().encode(content).length };
  }

  async rename(from: string, to: string): Promise<void> {
    if (this.failRename !== null) {
      throw this.failRename;
    }
    const content = this.files.get(from);
    if (content === undefined) {
      throw Object.assign(new Error(`ENOENT: ${from}`), { code: 'ENOENT' });
    }
    this.files.delete(from);
    this.files.set(to, content);
  }

  async rm(path: string): Promise<void> {
    this.files.delete(path);
  }
}

describe('formatErrorLogLine', () => {
  it('includes timestamp, code, source, message and cause', () => {
    expect(
      formatErrorLogLine({
        code: 'RULE_FAILED',
        message: 'bad rule',
        source: 'engine',
        cause: { name: 'TypeError', message: 'x is undefined', stack: 'a\nb' },
        timestamp: TIMESTAMP,
      })
    ).toBe(
      `${TIMESTAMP} [RULE_FAILED] engine: bad rule (cause: TypeError: x is undefined)`
    );
  });

  it('omits missing source and cause', () => {
    expect(
      formatErrorLogLine({ code: 'E', message: 'm', timestamp: TIMESTAMP })
    ).toBe(`${TIMESTAMP} [E] m`);
  });

  it('keeps each entry on one line', () => {
    const line = formatErrorLogLine({
      code: 'E',
      message: 'first\nsecond\r\nthird',
      timestamp: TIMESTAMP,
    });

    expect(line).not.toMatch(/[\r\n]/);
    expect(line).toContain('first\\nsecond\\nthird');
  });

  it.each([
    ['a string', 'plain text', 'plain text'],
    ['an object', { a: 1 }, '{"a":1}'],
    ['a number', 42, '42'],
  ])('describes %s causes', (_label, cause, expected) => {
    expect(
      formatErrorLogLine({
        code: 'E',
        message: 'm',
        cause,
        timestamp: TIMESTAMP,
      })
    ).toContain(`(cause: ${expected})`);
  });

  it('describes a circular cause without throwing', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    expect(() =>
      formatErrorLogLine({
        code: 'E',
        message: 'm',
        cause: circular,
        timestamp: TIMESTAMP,
      })
    ).not.toThrow();
  });
});

describe('FlatFileErrorAdapter', () => {
  it('appends one line per entry, creating the parent directory once', async () => {
    const fs = new FakeFileSystem();
    const adapter = new FlatFileErrorAdapter('/var/log/app/errors.log', { fs });

    expect(await adapter.log(entry('one'))).toEqual({ ok: true });
    expect(await adapter.log(entry('two'))).toEqual({ ok: true });

    expect(fs.files.get('/var/log/app/errors.log')).toBe(
      `${TIMESTAMP} [E] one\n${TIMESTAMP} [E] two\n`
    );
    expect(fs.directories).toEqual(['/var/log/app']);
  });

  it.each(['C:\\error.log', 'C:/error.log', '\\error.log', '/error.log'])(
    'does not try to create the root folder of %s',
    async (filePath: string) => {
      const fs = new FakeFileSystem();

      const result = await new FlatFileErrorAdapter(filePath, { fs }).log(
        entry('a')
      );

      expect(result).toEqual({ ok: true });
      expect(fs.directories).toEqual([]);
    }
  );

  it('skips mkdir for a bare file name or when createDirectory is false', async () => {
    const bare = new FakeFileSystem();
    await new FlatFileErrorAdapter('errors.log', { fs: bare }).log(entry('a'));
    const disabled = new FakeFileSystem();
    await new FlatFileErrorAdapter('/logs/errors.log', {
      fs: disabled,
      createDirectory: false,
    }).log(entry('a'));

    expect(bare.directories).toEqual([]);
    expect(disabled.directories).toEqual([]);
  });

  it('uses a custom formatter and adds the missing newline', async () => {
    const fs = new FakeFileSystem();

    await new FlatFileErrorAdapter('/l/e.log', {
      fs,
      formatLine: (e) => `${e.code}|${e.message}`,
    }).log(entry('hi'));

    expect(fs.files.get('/l/e.log')).toBe('E|hi\n');
  });

  it('keeps every line when many entries are logged at once', async () => {
    const fs = new FakeFileSystem();
    const adapter = new FlatFileErrorAdapter('/l/e.log', { fs });

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => adapter.log(entry(`m${i}`)))
    );

    expect(results.every((r) => r.ok)).toBe(true);
    const lines = (fs.files.get('/l/e.log') ?? '').trim().split('\n');
    expect(lines).toHaveLength(20);
    expect(lines[0]).toContain('m0');
    expect(lines[19]).toContain('m19');
  });

  it('returns a failure result and keeps working after an append fails', async () => {
    const fs = new FakeFileSystem();
    fs.failAppend = new Error('EACCES: permission denied');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const adapter = new FlatFileErrorAdapter('/l/e.log', {
      fs,
      prefix: '[my-app]',
    });

    const failed = await adapter.log(entry('a'));
    fs.failAppend = null;
    const recovered = await adapter.log(entry('b'));

    expect(failed.ok).toBe(false);
    expect(failed.error).toContain('permission denied');
    expect(failed.error).toContain('"/l/e.log"');
    expect(spy).toHaveBeenCalledWith(
      '[my-app] FlatFileErrorAdapter:',
      expect.any(Error)
    );
    expect(recovered).toEqual({ ok: true });
    spy.mockRestore();
  });

  it.each([0, -5, 1.5])('rejects maxBytes of %s', (maxBytes: number) => {
    expect(
      () =>
        new FlatFileErrorAdapter('/l/e.log', {
          fs: new FakeFileSystem(),
          maxBytes,
        })
    ).toThrowError(/maxBytes must be a positive integer/);
  });

  it('rejects an invalid maxFiles', () => {
    expect(
      () =>
        new FlatFileErrorAdapter('/l/e.log', {
          fs: new FakeFileSystem(),
          maxFiles: 0,
        })
    ).toThrowError(/maxFiles must be a positive integer/);
  });
});

describe('FlatFileErrorAdapter rotation', () => {
  const LINE = `${TIMESTAMP} [E] x\n`;

  it('rotates when the next line would pass maxBytes and shifts older files up', async () => {
    const fs = new FakeFileSystem();
    // Room for exactly two lines.
    const adapter = new FlatFileErrorAdapter('/l/e.log', {
      fs,
      maxBytes: LINE.length * 2,
      maxFiles: 3,
    });

    for (const message of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      await adapter.log(entry(message));
    }

    const read = (name: string): string => fs.files.get(name) ?? '';
    expect(read('/l/e.log')).toContain('] g');
    expect(read('/l/e.log.1')).toMatch(/\] e\n.*\] f\n/);
    expect(read('/l/e.log.2')).toMatch(/\] c\n.*\] d\n/);
    expect(read('/l/e.log.3')).toMatch(/\] a\n.*\] b\n/);
    expect(fs.files.has('/l/e.log.4')).toBe(false);
  });

  it('drops the oldest rotated file once maxFiles is reached', async () => {
    const fs = new FakeFileSystem();
    const adapter = new FlatFileErrorAdapter('/l/e.log', {
      fs,
      maxBytes: LINE.length,
      maxFiles: 1,
    });

    for (const message of ['a', 'b', 'c']) {
      await adapter.log(entry(message));
    }

    expect(fs.files.get('/l/e.log')).toContain('] c');
    expect(fs.files.get('/l/e.log.1')).toContain('] b');
    expect(fs.files.has('/l/e.log.2')).toBe(false);
  });

  it('does not rotate an empty or missing file, even if one line exceeds maxBytes', async () => {
    const fs = new FakeFileSystem();

    await new FlatFileErrorAdapter('/l/e.log', { fs, maxBytes: 5 }).log(
      entry('a very long message')
    );

    expect(fs.files.has('/l/e.log.1')).toBe(false);
    expect(fs.files.get('/l/e.log')).toContain('a very long message');
  });

  it('still writes the entry if rotation fails, and reports it', async () => {
    const fs = new FakeFileSystem();
    fs.failRename = new Error('EPERM: operation not permitted');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const adapter = new FlatFileErrorAdapter('/l/e.log', {
      fs,
      maxBytes: LINE.length,
    });

    await adapter.log(entry('a'));
    const result = await adapter.log(entry('b'));

    expect(result).toEqual({ ok: true });
    expect(fs.files.get('/l/e.log')).toContain('] b');
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('could not rotate')
    );
    spy.mockRestore();
  });
});

describe('FlatFileErrorAdapter with the real file system', () => {
  it('creates folders, appends lines and rotates files on disk', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'error-log-adapter-'));
    try {
      const filePath = join(directory, 'nested', 'errors.log');
      const adapter = new FlatFileErrorAdapter(filePath, {
        maxBytes: 70,
        maxFiles: 2,
      });

      for (const message of ['one', 'two', 'three', 'four', 'five']) {
        expect(await adapter.log(entry(message))).toEqual({ ok: true });
      }

      const names = (await readdir(join(directory, 'nested'))).sort();
      expect(names).toEqual(['errors.log', 'errors.log.1', 'errors.log.2']);
      expect(await readFile(filePath, 'utf8')).toContain('] five');
      expect(await readFile(`${filePath}.2`, 'utf8')).toMatch(
        /\] one\n.*\] two\n/
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
