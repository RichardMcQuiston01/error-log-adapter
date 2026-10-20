# @richardmcquiston01/error-log-adapter-memcached

A [Memcached](https://memcached.org) adapter for [`@richardmcquiston01/error-log-adapter`](../../README.md). It keeps recent errors in memory as expiring JSON entries, written with a [`memjs`](https://www.npmjs.com/package/memjs) client that you create. This package has no runtime dependencies: `memjs` is only needed by your application.

**Memcached is a cache, not a log.** It has no queries, no durability, and it may drop any key early when it runs out of memory. Use this adapter for a short, cheap look at what went wrong lately (for example, to show recent errors on an admin page), and put a durable adapter beside it with `CompositeErrorAdapter` for anything that must survive.

## Install

```sh
npm install @richardmcquiston01/error-log-adapter @richardmcquiston01/error-log-adapter-memcached memjs
```

## Usage

```ts
import memjs from 'memjs';
import { MemcachedErrorAdapter } from '@richardmcquiston01/error-log-adapter-memcached';

const client = memjs.Client.create('127.0.0.1:11211');
const adapter = new MemcachedErrorAdapter(client, {
  ttlSeconds: 24 * 60 * 60,
  ringSize: 200,
});

const result = await adapter.log({
  code: 'DB_DOWN',
  message: 'cannot reach the database',
  source: 'checkout',
});
if (!result.ok) {
  console.error(result.error);
}
```

## What is stored

Each entry is one key, `<keyPrefix><id>` (default prefix `error_log:`), holding JSON:

```json
{
  "id": "3f2b8c1e-5a7d-4e21-9c0a-1b2c3d4e5f60",
  "code": "DB_DOWN",
  "message": "cannot reach the database",
  "cause": { "name": "Error", "message": "ECONNREFUSED" },
  "source": "checkout",
  "occurred_at": "2026-10-19T05:00:00.123Z",
  "created_at": "2026-10-19T05:00:00.140Z"
}
```

`cause` and `source` are left out when the entry has none. The key expires after `ttlSeconds` (default seven days, at most 30 days, because Memcached reads a larger expiry as a Unix time).

## Finding the newest entries

Memcached cannot list keys, so the adapter keeps a fixed-size **recent list**: a counter, `<keyPrefix>count`, numbers each new entry, and the slot `<keyPrefix>recent:<n % ringSize>` holds that entry's id, overwriting the oldest. `ringSize` defaults to 100; `0` turns the list off.

```ts
import {
  counterKey,
  entryKey,
  recentSlotKeys,
} from '@richardmcquiston01/error-log-adapter-memcached';

const counter = Number((await client.get(counterKey())).value);
for (const slot of recentSlotKeys(counter, { ringSize: 200 })) {
  const id = (await client.get(slot)).value?.toString();
  if (id === undefined) continue; // the slot expired
  const stored = (await client.get(entryKey(id))).value; // JSON, or null if it expired
}
```

`recentSlotKeys` returns the slot keys newest first. If the counter does not exist yet, nothing has been logged. Pass the same `keyPrefix` and `ringSize` to every call.

## Repeats

The entry is written with `add`, which refuses a key that exists. The adapter treats that as success and leaves the first write (and its place in the recent list) as it was, so a retry after a timeout never stores an entry twice. Pass your own `id` to make a retry of the same entry safe. If the recent list cannot be updated after the entry was stored, the adapter deletes the entry again and reports the failure, so a retry stores and lists it properly.

## Options

| Option          | Default               | Meaning                                                                  |
| --------------- | --------------------- | ------------------------------------------------------------------------ |
| `keyPrefix`     | `error_log:`          | Prefix of every key. Printable ASCII, no spaces, at most 100 characters. |
| `ttlSeconds`    | `604800` (7 days)     | How long an entry is kept. Whole seconds, 1 to 2592000 (30 days).        |
| `ringSize`      | `100`                 | Entries the recent list keeps. `0` turns it off.                         |
| `maxValueBytes` | `1000000`             | Refuse an entry larger than this as JSON, before contacting the server.  |
| `timeoutMs`     | `10000`               | How long to wait for each request. `Infinity` waits without limit.       |
| `prefix`        | `[error-log-adapter]` | Text printed before failure messages.                                    |

A key longer than 250 characters, or one with a space or control character, is refused before sending, with a message that names the key.

## Batching

`logBatch` stores entries in order, so `BatchingErrorAdapter` can wrap this adapter. It checks every entry first and stores nothing if one is invalid. After that it stops at the first failure and says how many entries were stored. Trying the whole batch again is safe.

## What was checked

- Unit tests with an in-memory fake client, and a compile-time check that the real `memjs` `Client` type fits `MemcachedClientLike`.
- An opt-in live test (`memcached-error-adapter.live.test.ts`) ran the adapter with the real `memjs` client against a real Memcached 1.6 server in Docker: the entry stored as JSON under its id, awkward text (quotes, backslashes, line breaks, emoji, a NUL character) read back exactly, a repeat keeping the first write and being listed once, a recent list that wraps around, `ringSize: 0` leaving the counter alone, an entry expiring after `ttlSeconds`, a batch, a value over the item limit and an unreachable server coming back as `ok: false`. It is skipped unless `MEMCACHED_TEST_SERVER` is set; see the file for how to run it.
- Not tested: several servers in one client, SASL authentication, TLS, and Memcached other than 1.6.

## Compatibility

Requires `@richardmcquiston01/error-log-adapter` 0.15 or newer (the release that adds the `/kit` entry point) as a peer dependency. The client type is checked against `memjs` 1.3.
