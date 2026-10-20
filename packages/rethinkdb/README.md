# @richardmcquiston01/error-log-adapter-rethinkdb

A [RethinkDB](https://rethinkdb.com) adapter for [`@richardmcquiston01/error-log-adapter`](../../README.md). Each error becomes a document whose primary key is the entry's UUID, written through a table from [`rethinkdb-ts`](https://www.npmjs.com/package/rethinkdb-ts) that you create. This package has no runtime dependencies: `rethinkdb-ts` is only needed by your application.

## Install

```sh
npm install @richardmcquiston01/error-log-adapter @richardmcquiston01/error-log-adapter-rethinkdb rethinkdb-ts
```

## Usage

```ts
import { r } from 'rethinkdb-ts';
import {
  OCCURRED_AT_INDEX,
  RethinkDbErrorAdapter,
} from '@richardmcquiston01/error-log-adapter-rethinkdb';

const connection = await r.connect({ host: 'localhost', port: 28015 });

// Once: the table, and an index for "newest first" queries.
await r.dbCreate('logs').run(connection);
await r.db('logs').tableCreate('error_log').run(connection);
await r
  .db('logs')
  .table('error_log')
  .indexCreate(OCCURRED_AT_INDEX)
  .run(connection);

const adapter = new RethinkDbErrorAdapter(
  r.db('logs').table('error_log'),
  connection
);

const result = await adapter.log({
  code: 'DB_DOWN',
  message: 'cannot reach the database',
  source: 'checkout',
});
if (!result.ok) {
  console.error(result.error);
}
```

The table has to exist; the adapter does not create it. With a default connection pool (`await r.connectPool(...)`), leave the connection out: `new RethinkDbErrorAdapter(r.table('error_log'))`.

## The document

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

`cause` is stored as real JSON, and `cause` and `source` are left out when the entry has none. `occurred_at` and `created_at` are stored as RethinkDB's native time type (the driver gives them back as `Date`), so an index on `occurred_at` answers "newest first":

```ts
const newest = await r
  .db('logs')
  .table('error_log')
  .orderBy({ index: r.desc(OCCURRED_AT_INDEX) })
  .limit(50)
  .run(connection);
```

## Repeats

The primary key is the entry's UUID, and the adapter inserts with a conflict function that returns the stored document, so logging the same entry again leaves the first document, with its original `created_at`, and reports success. A retry after a timeout never stores an entry twice. Pass your own `id` to make a retry of the same entry safe.

## Failures

RethinkDB answers a refused write with a result whose `errors` count is not 0, not with an error. The adapter reads that count and returns `ok: false` with the first reason. A missing table, a closed connection or an unreachable server comes back as `ok: false` with the server's short reason (`RethinkDB error ReqlOpFailedError: Table \`logs.error_log\` does not exist.`) instead of the driver's message, which repeats the whole query and the document.

## Options

| Option       | Default               | Meaning                                                                       |
| ------------ | --------------------- | ----------------------------------------------------------------------------- |
| `durability` | the table's setting   | `hard` waits until the write is on disk; `soft` answers once it is in memory. |
| `timeoutMs`  | `10000`               | How long to wait for RethinkDB. `Infinity` waits without limit.               |
| `prefix`     | `[error-log-adapter]` | Text printed before failure messages.                                         |

## Batching

`logBatch` writes a whole batch with one `insert`, so `BatchingErrorAdapter` can wrap this adapter. It checks every entry first and writes nothing if one is invalid. If RethinkDB refuses any document the error gives the count and the first reason. Trying the batch again is safe.

## What was checked

- Unit tests with a fake table, and a compile-time check that a real `rethinkdb-ts` table fits `RethinkDbTableLike` and builds an adapter.
- An opt-in live test (`rethinkdb-error-adapter.live.test.ts`) ran the adapter with the real `rethinkdb-ts` driver against a real RethinkDB 2.4 server in Docker: the document keyed by the entry id with native times, field names kept exactly as written (also inside `cause`), awkward text read back exactly, a repeat keeping the first document, a batch that includes an existing id, "newest first" through an `occurred_at` index, soft durability, the default connection pool with no connection given, and a missing table and a closed connection coming back as `ok: false`. It is skipped unless `RETHINKDB_TEST_HOST` is set; see the file for how to run it.
- Not tested: clusters and sharded tables, TLS and authentication, other drivers (the older `rethinkdb` and `rethinkdbdash` packages), and RethinkDB other than 2.4.

## Compatibility

Requires `@richardmcquiston01/error-log-adapter` 0.15 or newer (the release that adds the `/kit` entry point) as a peer dependency. The table type is checked against `rethinkdb-ts` 3.
