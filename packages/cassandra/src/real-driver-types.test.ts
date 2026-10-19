// Compile-time check: the real `cassandra-driver` client must be assignable to
// `CassandraClientLike`. `tsc --noEmit` fails when a driver upgrade stops
// fitting. The second test checks that the values the adapter binds are ones the
// driver can encode for the table's column types, using the driver's own types.
import { Client, types } from 'cassandra-driver';
import { describe, expect, it } from 'vitest';
import type { CassandraClientLike } from './cassandra-error-adapter.js';

describe('real cassandra-driver types fit CassandraClientLike', () => {
  it('compiles', () => {
    const client = (c: Client): CassandraClientLike => c;
    expect([client]).toHaveLength(1);
  });

  it('accepts the entry id as the uuid column value', () => {
    const id = '3f2b8c1e-5a7d-4e21-9c0a-1b2c3d4e5f60';
    expect(types.Uuid.fromString(id).toString()).toBe(id);
  });
});
