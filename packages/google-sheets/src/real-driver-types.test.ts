// Compile-time check: the real `@googleapis/sheets` client type must be
// assignable to `SheetsClientLike`. `tsc --noEmit` fails when an upgrade stops
// fitting.
import type { sheets_v4 } from '@googleapis/sheets';
import { describe, expect, it } from 'vitest';
import type { SheetsClientLike } from './google-sheets-error-adapter.js';

describe('real @googleapis/sheets types fit SheetsClientLike', () => {
  it('compiles', () => {
    const client = (c: sheets_v4.Sheets): SheetsClientLike => c;
    expect([client]).toHaveLength(1);
  });
});
