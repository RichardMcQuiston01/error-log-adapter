import { describe, expect, it } from 'vitest';
import { hasCallerId, resolveEntryId } from './entry-id.js';

const UUID = '3f2b8c1e-5d4a-4e7b-9a10-2c6d8e0f1a2b';

describe('resolveEntryId', () => {
  it('generates a UUID when the entry has none, different each time', () => {
    const entry = { code: 'E', message: 'm' };
    const first = resolveEntryId(entry);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolveEntryId(entry)).not.toBe(first);
  });

  it('returns the caller id, lower-cased', () => {
    expect(resolveEntryId({ code: 'E', message: 'm', id: UUID })).toBe(UUID);
    expect(
      resolveEntryId({ code: 'E', message: 'm', id: UUID.toUpperCase() })
    ).toBe(UUID);
  });

  it.each(['', 'not-a-uuid', '123', `${UUID}x`, ' ' + UUID, 42 as never])(
    'rejects %j with a descriptive error',
    (id) => {
      expect(() => resolveEntryId({ code: 'E', message: 'm', id })).toThrow(
        /entry\.id must be a UUID/
      );
    }
  );
});

describe('hasCallerId', () => {
  it('is true only when an id was supplied', () => {
    expect(hasCallerId({ code: 'E', message: 'm' })).toBe(false);
    expect(hasCallerId({ code: 'E', message: 'm', id: UUID })).toBe(true);
  });
});
