import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateId } from './uuid.js';

const UUID_V4: RegExp =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('generateId', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns a version 4 UUID', () => {
    expect(generateId()).toMatch(UUID_V4);
  });

  it('works where crypto.randomUUID is missing, as on an insecure http page', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: crypto.getRandomValues.bind(crypto),
    });
    const first: string = generateId();
    expect(first).toMatch(UUID_V4);
    expect(generateId()).not.toBe(first);
  });

  it('works without any crypto object', () => {
    vi.stubGlobal('crypto', undefined);
    expect(generateId()).toMatch(UUID_V4);
  });
});
