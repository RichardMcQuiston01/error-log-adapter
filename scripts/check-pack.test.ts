import { describe, expect, it } from 'vitest';
import { checkPackedFiles, exportedFiles } from './check-pack.js';

describe('exportedFiles', () => {
  it('lists the files an exports map points at', () => {
    expect(
      exportedFiles({
        '.': {
          types: './dist/index.d.ts',
          import: './dist/index.mjs',
          require: './dist/index.cjs',
        },
        './kit': { types: './dist/kit.d.ts', import: './dist/kit.mjs' },
      })
    ).toEqual([
      'dist/index.cjs',
      'dist/index.d.ts',
      'dist/index.mjs',
      'dist/kit.d.ts',
      'dist/kit.mjs',
    ]);
  });

  it('returns nothing for a package without exports', () => {
    expect(exportedFiles(undefined)).toEqual([]);
  });
});

describe('checkPackedFiles', () => {
  const required = ['dist/index.mjs'];
  const good = ['package.json', 'README.md', 'LICENSE', 'dist/index.mjs'];

  it('accepts a complete tarball', () => {
    expect(checkPackedFiles(good, required)).toEqual([]);
  });

  it('reports a missing build and a missing LICENSE', () => {
    expect(checkPackedFiles(['package.json', 'README.md'], required)).toEqual([
      'missing LICENSE',
      'missing dist/index.mjs',
    ]);
  });

  it('reports sources and tests that would be published', () => {
    expect(
      checkPackedFiles(
        [...good, 'src/index.ts', 'dist/index.test.js', 'dist/index.d.ts'],
        required
      )
    ).toEqual([
      'should not be published: src/index.ts',
      'should not be published: dist/index.test.js',
    ]);
  });
});
