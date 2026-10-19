// Compile-time check: the real `@clickhouse/client` client type must be
// assignable to `ClickHouseClientLike`. `tsc --noEmit` fails when an upgrade
// stops fitting.
import type { ClickHouseClient } from '@clickhouse/client';
import { describe, expect, it } from 'vitest';
import type { ClickHouseClientLike } from './clickhouse-error-adapter.js';

describe('real @clickhouse/client types fit ClickHouseClientLike', () => {
  it('compiles', () => {
    const client = (c: ClickHouseClient): ClickHouseClientLike => c;
    expect([client]).toHaveLength(1);
  });
});
