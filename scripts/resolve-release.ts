/**
 * Works out what a GitHub release tag publishes, and checks the tag against the
 * package it names. Used by the Publish workflow, and runnable by hand:
 *
 *   bun scripts/resolve-release.ts v0.15.0
 *   bun scripts/resolve-release.ts rabbitmq-v0.1.0
 *
 * A tag `v<version>` publishes the core package at the repository root. A tag
 * `<name>-v<version>` publishes `packages/<name>`. The version in the tag must
 * equal the version in that package's package.json.
 */
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

export const CORE_PACKAGE_NAME = '@richardmcquiston01/error-log-adapter';

export interface ReleaseTarget {
  /** npm package name, for example `@richardmcquiston01/error-log-adapter-rabbitmq`. */
  name: string;
  /** Directory to publish from, relative to the repository root. */
  dir: string;
  version: string;
  /** `next` for a prerelease version such as `1.0.0-rc.1`, otherwise `latest`. */
  npmTag: 'latest' | 'next';
}

interface PackageJson {
  name?: string;
  version?: string;
  private?: boolean;
  peerDependencies?: Record<string, string>;
}

const TAG_PATTERN =
  /^(?:(?<slug>[a-z][a-z0-9-]*)-)?v(?<version>\d[0-9A-Za-z.+-]*)$/;

function readPackageJson(path: string): PackageJson {
  if (!existsSync(path)) {
    throw new Error(`${path} does not exist.`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as PackageJson;
}

/** The names of the packages under `packages/`, for error messages. */
function listPackages(repoRoot: string): string[] {
  const dir = join(repoRoot, 'packages');
  return existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    : [];
}

/**
 * @throws {Error} with a message that says what is wrong with the tag and how
 * to fix it: an unknown package, a version that does not match package.json, a
 * private package, or a package whose core peer range the core at this commit
 * does not satisfy.
 */
export function resolveRelease(tag: string, repoRoot: string): ReleaseTarget {
  const match = TAG_PATTERN.exec(tag);
  if (match?.groups === undefined) {
    throw new Error(
      `Release tag "${tag}" is not v<version> (publishes the core package) or <package>-v<version> (publishes packages/<package>), for example v0.15.0 or rabbitmq-v0.1.0.`
    );
  }
  const slug = match.groups['slug'];
  const tagVersion = match.groups['version'] as string;
  if (semver.valid(tagVersion) === null) {
    throw new Error(`Release tag "${tag}" does not end in a valid version.`);
  }

  const dir = slug === undefined ? '.' : join('packages', slug);
  if (slug !== undefined && !existsSync(join(repoRoot, dir, 'package.json'))) {
    const known = listPackages(repoRoot);
    throw new Error(
      `Release tag "${tag}" names the package "${slug}", but there is no packages/${slug}/package.json. Packages: ${known.length === 0 ? '(none)' : known.join(', ')}.`
    );
  }

  const pkg = readPackageJson(join(repoRoot, dir, 'package.json'));
  if (pkg.name === undefined || pkg.version === undefined) {
    throw new Error(`${dir}/package.json needs a name and a version.`);
  }
  if (pkg.private === true) {
    throw new Error(`${pkg.name} is private and cannot be published.`);
  }
  if (pkg.version !== tagVersion) {
    throw new Error(
      `Release tag "${tag}" does not match ${dir}/package.json, which is version ${pkg.version}. Change one of them so the tag is ${slug === undefined ? '' : `${slug}-`}v${pkg.version}.`
    );
  }

  if (slug !== undefined) {
    const core = readPackageJson(join(repoRoot, 'package.json'));
    const range = pkg.peerDependencies?.[CORE_PACKAGE_NAME];
    if (range === undefined || core.version === undefined) {
      throw new Error(
        `${pkg.name} must list ${CORE_PACKAGE_NAME} as a peer dependency.`
      );
    }
    if (!semver.satisfies(core.version, range)) {
      throw new Error(
        `${pkg.name} needs ${CORE_PACKAGE_NAME} ${range}, but the core at this commit is ${core.version}. Release the core first, or fix the peer range.`
      );
    }
  }

  return {
    name: pkg.name,
    dir,
    version: pkg.version,
    npmTag: semver.prerelease(pkg.version) === null ? 'latest' : 'next',
  };
}

/** Writes `name=value` lines to the file GitHub Actions reads step outputs from. */
function writeOutputs(target: ReleaseTarget, outputFile: string): void {
  appendFileSync(
    outputFile,
    `name=${target.name}\ndir=${target.dir}\nversion=${target.version}\nnpm_tag=${target.npmTag}\n`
  );
}

const isMain: boolean =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const tag = process.argv[2];
  if (tag === undefined || tag === '') {
    console.error('Usage: bun scripts/resolve-release.ts <release-tag>');
    process.exit(2);
  }
  try {
    const target = resolveRelease(tag, process.cwd());
    console.log(
      `Publishing ${target.name}@${target.version} from ${target.dir} with npm tag "${target.npmTag}".`
    );
    const outputFile = process.env['GITHUB_OUTPUT'];
    if (outputFile !== undefined && outputFile !== '') {
      writeOutputs(target, outputFile);
    }
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
