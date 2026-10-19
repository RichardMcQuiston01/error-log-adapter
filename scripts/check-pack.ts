/**
 * Checks what `npm publish` would put in the tarball of the core package and of
 * every package under `packages/`, so a missing build or a stray source file is
 * caught in CI instead of after a release:
 *
 *   bun run build && bun run build:packages && bun scripts/check-pack.ts
 *
 * Each tarball must hold the built files, the README, the LICENSE and the
 * package.json, and nothing from `src/` or the test files.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface PackedFile {
  path: string;
}

interface PackJson {
  name: string;
  files: PackedFile[];
}

/** Files every package must ship, besides the built entry files listed in its `exports`. */
const ALWAYS = ['package.json', 'README.md', 'LICENSE'];

/** Paths of the built files a package.json `exports` map points at. */
export function exportedFiles(exportsField: unknown): string[] {
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      found.add(value.replace(/^\.\//, ''));
    } else if (typeof value === 'object' && value !== null) {
      Object.values(value).forEach(visit);
    }
  };
  visit(exportsField);
  return [...found].sort();
}

/**
 * @returns descriptions of everything wrong with a tarball's file list; an empty
 * array means it is fine.
 */
export function checkPackedFiles(
  packed: readonly string[],
  required: readonly string[]
): string[] {
  const problems: string[] = [];
  for (const file of [...ALWAYS, ...required]) {
    if (!packed.includes(file)) {
      problems.push(`missing ${file}`);
    }
  }
  for (const file of packed) {
    if (file.startsWith('src/') || /\.test\.[cm]?[jt]s$/.test(file)) {
      problems.push(`should not be published: ${file}`);
    }
  }
  return problems;
}

function packedFiles(dir: string): PackJson {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const [result] = JSON.parse(output) as PackJson[];
  if (result === undefined) {
    throw new Error(`npm pack printed nothing for ${dir}.`);
  }
  return result;
}

function packageDirs(root: string): string[] {
  const packagesDir = join(root, 'packages');
  const nested = existsSync(packagesDir)
    ? readdirSync(packagesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(packagesDir, entry.name))
        .sort()
    : [];
  return [root, ...nested];
}

const isMain: boolean =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  let failed = false;
  for (const dir of packageDirs(process.cwd())) {
    const manifest = JSON.parse(
      readFileSync(join(dir, 'package.json'), 'utf8')
    ) as { exports?: unknown };
    const packed = packedFiles(dir);
    const problems = checkPackedFiles(
      packed.files.map((file) => file.path),
      exportedFiles(manifest.exports)
    );
    if (problems.length === 0) {
      console.log(`ok   ${packed.name} (${packed.files.length} files)`);
    } else {
      failed = true;
      console.error(`FAIL ${packed.name}`);
      problems.forEach((problem) => console.error(`       ${problem}`));
    }
  }
  process.exit(failed ? 1 : 0);
}
