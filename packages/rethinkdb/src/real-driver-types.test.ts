// Compile-time check: a real `rethinkdb-ts` table must be assignable to
// `RethinkDbTableLike`. `tsc --noEmit` fails when a `rethinkdb-ts` upgrade stops
// fitting.
import { r } from 'rethinkdb-ts';
import type { Connection } from 'rethinkdb-ts';
import { describe, expect, it } from 'vitest';
import { RethinkDbErrorAdapter } from './rethinkdb-error-adapter.js';
import type { RethinkDbTableLike } from './rethinkdb-error-adapter.js';

describe('real rethinkdb-ts types fit RethinkDbTableLike', () => {
  it('compiles', () => {
    const table = (): RethinkDbTableLike<Connection> =>
      r.db('logs').table('error_log');
    expect([table]).toHaveLength(1);
  });

  it('builds an adapter from a real table and connection type', () => {
    const make = (connection: Connection): RethinkDbErrorAdapter =>
      new RethinkDbErrorAdapter(r.db('logs').table('error_log'), connection);
    expect([make]).toHaveLength(1);
  });
});
