# @richardmcquiston01/error-log-adapter-arangodb

An [ArangoDB](https://arangodb.com) adapter for [`@richardmcquiston01/error-log-adapter`](../../README.md). Each error becomes a JSON document whose `_key` is the entry's UUID, written with a collection handle from [`arangojs`](https://www.npmjs.com/package/arangojs) that you create. This package has no runtime dependencies: `arangojs` is only needed by your application.

## Install

```sh
npm install @richardmcquiston01/error-log-adapter @richardmcquiston01/error-log-adapter-arangodb arangojs
```

## Usage

```ts
import { Database } from 'arangojs';
import {
  ArangoDbErrorAdapter,
  buildErrorLogIndex,
} from '@richardmcquiston01/error-log-adapter-arangodb';

const db = new Database({ url: 'http://localhost:8529', databaseName: 'logs' });
db.useBasicAuth('root', 'secret');

const collection = db.collection('error_log');
if (!(await collection.exists())) {
  await collection.create(); // once
}
await collection.ensureIndex(buildErrorLogIndex()); // once, for queries by time

const adapter = new ArangoDbErrorAdapter(collection);

const result = await adapter.log({
  code: 'DB_DOWN',
  message: 'cannot reach the database',
  source: 'checkout',
});
if (!result.ok) {
  console.error(result.error);
}
```

The collection must already exist; the adapter does not create it. A missing collection, a bad login or an unreachable server comes back as `ok: false` with ArangoDB's error number, for example `ArangoDB error 1203 (HTTP 404): collection or view not found: error_log`.

## The document

```json
{
  "_key": "3f2b8c1e-5a7d-4e21-9c0a-1b2c3d4e5f60",
  "code": "DB_DOWN",
  "message": "cannot reach the database",
  "cause": { "name": "Error", "message": "ECONNREFUSED" },
  "source": "checkout",
  "occurred_at": "2026-10-19T05:00:00.123Z",
  "created_at": "2026-10-19T05:00:00.140Z"
}
```

`cause` is stored as real JSON, not a string, and `cause` and `source` are left out when the entry has none. `buildErrorLogIndex()` returns a persistent index on `occurred_at` for "latest errors" and time-range queries:

```ts
const cursor = await db.query(
  'FOR e IN error_log FILTER e.occurred_at >= @since SORT e.occurred_at DESC LIMIT 50 RETURN e',
  { since: '2026-10-19T00:00:00.000Z' }
);
```

## Repeats

Because `_key` is the entry's UUID, logging the same entry twice is harmless. Documents are inserted with `overwriteMode: 'ignore'` (ArangoDB 3.7 and newer), which skips a key that already exists without an error. On an older server the "unique constraint violated" error (1210) is treated as success. Either way the first document is kept, with its original `created_at`, so a retry after a timeout never stores an entry twice. Pass your own `id` to make a retry of the same entry safe.

## Options

| Option      | Default               | Meaning                                                        |
| ----------- | --------------------- | -------------------------------------------------------------- |
| `timeoutMs` | `10000`               | How long to wait for ArangoDB. `Infinity` waits without limit. |
| `prefix`    | `[error-log-adapter]` | Text printed before failure messages.                          |

## Batching

`logBatch` writes a whole batch with one `saveAll` request, so `BatchingErrorAdapter` can wrap this adapter. It checks every entry first and writes nothing if one is invalid. ArangoDB then answers per document: keys that already exist count as stored, and if it refuses any other document the error says how many were stored and why the others were not. Trying the batch again is safe.

## What was checked

- The tests run the adapter with the real `arangojs` client against a small stand-in for ArangoDB's document HTTP API: the request path and `overwriteMode=ignore`, a repeat, a batch, a missing collection (1203), wrong credentials (401) and an unreachable server. A compile-time check fits the real `arangojs` collection type to the adapter's `ArangoCollectionLike`.
- The stand-in follows ArangoDB's documented behavior; **it has not been run against an ArangoDB server**, which was not available when this was written. If a real server answers differently, the tests would not show it.

## Compatibility

Requires `@richardmcquiston01/error-log-adapter` 0.15 or newer (the release that adds the `/kit` entry point) as a peer dependency. Written against `arangojs` 10.
