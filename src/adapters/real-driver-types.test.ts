/// <reference lib="dom" />
// Compile-time checks: each real vendor client type must be assignable to the
// adapter's hand-written `...Like` interface. `tsc --noEmit` in CI fails when
// a driver upgrade stops fitting. Nothing here connects to a service.
import type { Collection } from 'mongodb';
import type { Pool as MySqlPool } from 'mysql2/promise';
import type { Pool as PgPool } from 'pg';
import type { RedisClientType } from 'redis';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Reference } from 'firebase-admin/database';
import type { WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';
import type { CollectionLike } from './mongodb-error-adapter.js';
import type { SqlClientLike } from './sql-error-adapter.js';
import type { RedisClientLike } from './redis-error-adapter.js';
import type { SupabaseClientLike } from './supabase-error-adapter.js';
import type { RealtimeDatabaseRefLike } from './firebase-error-adapter.js';
import type { WebSocketLike } from './websocket-error-adapter.js';
import type {
  IdbDatabaseLike,
  IdbObjectStoreLike,
} from './indexeddb-error-adapter.js';
import type { StorageLike } from './web-storage-error-adapter.js';

describe('real driver types fit the ...Like interfaces', () => {
  it('compiles', () => {
    const mongo = (c: Collection): CollectionLike => c;
    const mysql = (c: MySqlPool): SqlClientLike => c;
    const postgres = (c: PgPool): SqlClientLike => c;
    const redis = (c: RedisClientType): RedisClientLike => c;
    const supabase = (c: SupabaseClient): SupabaseClientLike => c;
    const realtime = (r: Reference): RealtimeDatabaseRefLike => r;
    const webSocket = (s: WebSocket): WebSocketLike => s;
    const idb = (d: IDBDatabase): IdbDatabaseLike => d;
    const idbStore = (s: IDBObjectStore): IdbObjectStoreLike => s;
    const webStorage = (s: Storage): StorageLike => s;
    expect([
      mongo,
      mysql,
      postgres,
      redis,
      supabase,
      realtime,
      webSocket,
      idb,
      idbStore,
      webStorage,
    ]).toHaveLength(10);
  });
});
