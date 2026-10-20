# @richardmcquiston01/error-log-adapter-couchdb

An [Apache CouchDB](https://couchdb.apache.org) adapter for [`@richardmcquiston01/error-log-adapter`](../../README.md). Each error becomes a JSON document whose `_id` is the entry's UUID, written with a database handle from [`nano`](https://www.npmjs.com/package/nano) that you create. This package has no runtime dependencies: `nano` is only needed by your application.

## Install

```sh
npm install @richardmcquiston01/error-log-adapter @richardmcquiston01/error-log-adapter-couchdb nano
```

## Usage

```ts
import nano from 'nano';
import {
  CouchDbErrorAdapter,
  buildErrorLogIndex,
} from '@richardmcquiston01/error-log-adapter-couchdb';

const server = nano('http://admin:secret@localhost:5984');
await server.db.create('error_log').catch(() => undefined); // once
const database = server.use('error_log');
await database.createIndex(buildErrorLogIndex()); // once, for queries by time

const adapter = new CouchDbErrorAdapter(database);

const result = await adapter.log({
  code: 'DB_DOWN',
  message: 'cannot reach the database',
  source: 'checkout',
});
if (!result.ok) {
  console.error(result.error);
}
```

The database must already exist; the adapter does not create it. A missing database, a wrong login or an unreachable server comes back as `ok: false` with CouchDB's own reason, for example `CouchDB answered HTTP 404 (not_found): Database does not exist.`

## The document

```json
{
  "_id": "3f2b8c1e-5a7d-4e21-9c0a-1b2c3d4e5f60",
  "type": "error_log",
  "code": "DB_DOWN",
  "message": "cannot reach the database",
  "cause": { "name": "Error", "message": "ECONNREFUSED" },
  "source": "checkout",
  "occurred_at": "2026-10-19T05:00:00.123Z",
  "created_at": "2026-10-19T05:00:00.140Z"
}
```

`cause` is stored as real JSON, not a string, and `cause` and `source` are left out when the entry has none. `type` marks the document so one database can hold other kinds; the `docType` option changes it, and `''` leaves it out. `buildErrorLogIndex()` returns a Mango index over `type` and `occurred_at` for "latest errors" and time-range queries:

```ts
await database.find({
  selector: {
    type: 'error_log',
    occurred_at: { $gte: '2026-10-19T00:00:00.000Z' },
  },
  sort: [{ type: 'asc' }, { occurred_at: 'asc' }],
});
```

## Repeats

Because `_id` is the entry's UUID, logging the same entry twice makes CouchDB answer with a conflict, and the adapter treats that as success: the first document is kept, so a retry after a timeout never stores an entry twice. (The kept document is the first write, with its original `created_at`.) Pass your own `id` to make a retry of the same entry safe.

## Options

| Option      | Default               | Meaning                                                       |
| ----------- | --------------------- | ------------------------------------------------------------- |
| `docType`   | `error_log`           | Value of the `type` field. `''` leaves the field out.         |
| `timeoutMs` | `10000`               | How long to wait for CouchDB. `Infinity` waits without limit. |
| `prefix`    | `[error-log-adapter]` | Text printed before failure messages.                         |

## Batching

`logBatch` writes a whole batch with one `_bulk_docs` request, so `BatchingErrorAdapter` can wrap this adapter. It checks every entry first and writes nothing if one is invalid. CouchDB then answers per document: entries that already exist count as stored, and if it refuses any other document the error says how many were stored and why the others were not. Trying the batch again is safe.

## What was checked

- The tests run the adapter with the real `nano` client against a small in-memory CouchDB stand-in over HTTP, and a compile-time check fits the real `nano` database type to the adapter's `CouchDbDatabaseLike`.
- The same adapter, and `buildErrorLogIndex()`, were also run against PouchDB Server, a CouchDB-compatible server: documents stored, a repeat and a repeated batch entry kept as one document, a missing database reported, the index created and a time-range query answered through it.
- An opt-in live test (`couchdb-error-adapter.live.test.ts`) ran against real Apache CouchDB 3.5 and 3.3 servers in Docker: the document keyed by the entry id, `cause` stored as JSON, an absent `cause`, `source` and (with `docType: ''`) `type` left out, a repeat keeping the first write, a batch that includes an existing id, a time-range query answered through the `buildErrorLogIndex()` index with no warning from CouchDB, and a missing database (404) and a wrong login (401) coming back as `ok: false`. It is skipped unless `COUCHDB_TEST_URL` is set; see the file for how to run it.
- Not tested: clusters, CouchDB 2.x, Cloudant, and replication conflicts.

## Compatibility

Requires `@richardmcquiston01/error-log-adapter` 0.15 or newer (the release that adds the `/kit` entry point) as a peer dependency.
