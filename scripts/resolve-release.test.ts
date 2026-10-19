import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CORE_PACKAGE_NAME, resolveRelease } from './resolve-release.js';

let root = '';

function write(dir: string, json: object): void {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, 'package.json'), JSON.stringify(json));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'resolve-release-'));
  write('.', { name: CORE_PACKAGE_NAME, version: '0.15.0' });
  write('packages/rabbitmq', {
    name: `${CORE_PACKAGE_NAME}-rabbitmq`,
    version: '0.1.0',
    peerDependencies: { [CORE_PACKAGE_NAME]: '>=0.15.0' },
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('resolveRelease', () => {
  it('maps v<version> to the core package', () => {
    expect(resolveRelease('v0.15.0', root)).toEqual({
      name: CORE_PACKAGE_NAME,
      dir: '.',
      version: '0.15.0',
      npmTag: 'latest',
    });
  });

  it('maps <package>-v<version> to packages/<package>', () => {
    expect(resolveRelease('rabbitmq-v0.1.0', root)).toEqual({
      name: `${CORE_PACKAGE_NAME}-rabbitmq`,
      dir: join('packages', 'rabbitmq'),
      version: '0.1.0',
      npmTag: 'latest',
    });
  });

  it('publishes a prerelease under the next tag', () => {
    write('.', { name: CORE_PACKAGE_NAME, version: '1.0.0-rc.1' });
    expect(resolveRelease('v1.0.0-rc.1', root).npmTag).toBe('next');
  });

  it('rejects a tag that is not in either form', () => {
    for (const tag of [
      '0.15.0',
      'release-1',
      'v',
      'Rabbitmq-v0.1.0',
      'v0.15',
    ]) {
      expect(() => resolveRelease(tag, root)).toThrow(
        /is not v<version>|valid version/
      );
    }
  });

  it('rejects a tag whose version differs from package.json', () => {
    expect(() => resolveRelease('v0.16.0', root)).toThrow(
      'does not match ./package.json, which is version 0.15.0'
    );
    expect(() => resolveRelease('rabbitmq-v0.2.0', root)).toThrow(
      'is version 0.1.0. Change one of them so the tag is rabbitmq-v0.1.0'
    );
  });

  it('names the packages that exist when the package is unknown', () => {
    expect(() => resolveRelease('mongo-v0.1.0', root)).toThrow(
      'no packages/mongo/package.json. Packages: rabbitmq.'
    );
  });

  it('refuses a private package', () => {
    write('packages/rabbitmq', {
      name: `${CORE_PACKAGE_NAME}-rabbitmq`,
      version: '0.1.0',
      private: true,
    });
    expect(() => resolveRelease('rabbitmq-v0.1.0', root)).toThrow('is private');
  });

  it('refuses a package whose core peer range the core does not satisfy', () => {
    write('.', { name: CORE_PACKAGE_NAME, version: '0.14.0' });
    expect(() => resolveRelease('rabbitmq-v0.1.0', root)).toThrow(
      'needs @richardmcquiston01/error-log-adapter >=0.15.0, but the core at this commit is 0.14.0. Release the core first'
    );
  });

  it('refuses a package with no core peer dependency', () => {
    write('packages/rabbitmq', {
      name: `${CORE_PACKAGE_NAME}-rabbitmq`,
      version: '0.1.0',
    });
    expect(() => resolveRelease('rabbitmq-v0.1.0', root)).toThrow(
      'must list @richardmcquiston01/error-log-adapter as a peer dependency'
    );
  });
});
