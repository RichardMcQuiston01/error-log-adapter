// Compile-time check: the real `memjs` client must be assignable to
// `MemcachedClientLike`. `tsc --noEmit` fails when a `memjs` upgrade stops
// fitting. The second test checks that a client built with the adapter's
// value types is accepted by the constructor.
import { Client } from 'memjs';
import { describe, expect, it } from 'vitest';
import { MemcachedErrorAdapter } from './memcached-error-adapter.js';
import type { MemcachedClientLike } from './memcached-error-adapter.js';

describe('real memjs types fit MemcachedClientLike', () => {
  it('compiles', () => {
    const client = (c: Client): MemcachedClientLike => c;
    expect([client]).toHaveLength(1);
  });

  it('accepts a memjs client in the adapter', () => {
    const client: Client = Client.create('127.0.0.1:11211');
    const adapter = new MemcachedErrorAdapter(client);
    expect(adapter).toBeInstanceOf(MemcachedErrorAdapter);
    client.close();
  });
});
